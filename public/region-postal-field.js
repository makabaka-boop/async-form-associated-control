/**
 * <region-postal-field> —— form-associated 自定义元素。
 *
 * 通过 ElementInternals 原生参与：
 *   - 表单数据：以单个具名 JSON 值提交 { region, postal }（formdata 自动携带，无隐藏 input）
 *   - 约束校验：internals.setValidity + validationMessage，可被原生 requestSubmit 阻止
 *   - 生命周期：formAssociatedCallback / formResetCallback /
 *              formDisabledCallback（含 disabled fieldset）/ formStateRestoreCallback
 *
 * 并发正确性：
 *   - 每次输入变化立即撤销确认、令所有在途请求作废、取消等待提交。
 *   - 每次 Worker 请求带 rev（值修订号）与 formTag（发起时所属表单）；
 *     迟到结果若 rev 过期或表单归属已变，一律忽略，不得改变新状态。
 *   - disabled 时不参与数据与校验（setFormValue(null)，清除 validity）；
 *     重新启用后旧校验结果不得直接算有效，必须按当前值重新发起校验。
 */

import { validate } from './worker-client.js';

const REGIONS = ['上海市', '北京市', '广州市', '杭州市'];

const REASON_MESSAGE = {
  'region-empty': '请选择地区',
  'postal-format': '邮编必须是 6 位数字',
  'region-unknown': '未知地区',
  'postal-region-mismatch': '邮编与所选地区不匹配',
  'not-licensed': '该地区/邮编不在演示许可表内',
};

function isEmptyValue(v) {
  return !v.region && !v.postal;
}

function normalize(v) {
  return {
    region: String(v?.region ?? '').trim(),
    postal: String(v?.postal ?? '').trim(),
  };
}

function parseValue(raw) {
  if (raw == null || raw === '') return { region: '', postal: '' };
  try {
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return normalize(obj);
  } catch {
    return { region: '', postal: '' };
  }
}

export class RegionPostalField extends HTMLElement {
  static formAssociated = true;
  static observedAttributes = ['disabled', 'required', 'name', 'value'];

  #internals;
  #regionSelect;
  #postalInput;
  #statusEl;

  #value = { region: '', postal: '' };
  #defaultValue = { region: '', postal: '' };
  #rev = 0;                       // 值修订号：输入/reset/恢复/改属/禁用都会推进
  #pending = null;                // { id, rev, formTag }
  #confirmed = false;             // 当前值是否已得到匹配的校验确认
  #lastOk = false;
  #lastReason = '';
  #internalDisabled = false;      // 属性 disabled 与 disabled fieldset 的合成结果
  #connectedOnce = false;
  #restoreValue = null;           // 连接前到达的 formStateRestoreCallback 值
  #settlers = new Set();          // settled() 的等待器

  // 提交协调器注册：控件内 Enter 时回调。
  onEnterIntention = null;

  constructor() {
    super();
    this.#internals = this.attachInternals();

    const shadow = this.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { display: inline-block; }
        :host(:invalid:not(:disabled)) .box { border-color: #c0392b; }
        :host(:state(--pending)) .spinner { opacity: 1; }
        .row { display: flex; gap: 6px; align-items: center; }
        .box { display: flex; gap: 6px; padding: 4px; border: 1px solid #bbb; border-radius: 4px; background: #fff; }
        :host([disabled]) .box, :host(:disabled) .box { background: #eee; }
        select, input { font: inherit; padding: 3px 4px; }
        .spinner { opacity: 0; width: 10px; height: 10px; border: 2px solid #999; border-top-color: transparent; border-radius: 50%; animation: spin 0.8s linear infinite; transition: opacity .15s; }
        @keyframes spin { to { transform: rotate(360deg); } }
        .status { font-size: 12px; min-height: 16px; margin-top: 2px; }
        .status.ok { color: #1e8449; }
        .status.bad { color: #c0392b; }
        .status.pending { color: #7d6608; }
      </style>
      <div class="row">
        <div class="box">
          <select part="region" aria-label="地区">
            <option value="">选择地区…</option>
            ${REGIONS.map((r) => `<option>${r}</option>`).join('')}
          </select>
          <input part="postal" aria-label="邮编" inputmode="numeric" maxlength="6" placeholder="6 位邮编" />
        </div>
        <span class="spinner" aria-hidden="true"></span>
      </div>
      <div class="status" part="status"></div>
    `;

    this.#regionSelect = shadow.querySelector('select');
    this.#postalInput = shadow.querySelector('input');
    this.#statusEl = shadow.querySelector('.status');

    this.#regionSelect.addEventListener('change', () => {
      this.#value = { ...this.#value, region: this.#regionSelect.value };
      this.#commit('input');
    });

    this.#postalInput.addEventListener('input', () => {
      this.#postalInput.value = this.#postalInput.value.replace(/\D/g, '').slice(0, 6);
      this.#value = { ...this.#value, postal: this.#postalInput.value };
      this.#commit('input');
    });

    // 控件内 Enter：先阻止原生默认提交，交给协调器“等待当前校验，再走原生提交”。
    this.#postalInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      this.onEnterIntention?.(this);
    });
  }

  // ---- 标准 form-associated 生命周期 -------------------------------------

  connectedCallback() {
    this.#connectedOnce = true;
    this.#defaultValue = parseValue(this.getAttribute('value'));
    // 恢复值优先（浏览器 autofill/历史恢复），其次 value 属性默认值。
    const initial = this.#restoreValue ?? this.#defaultValue;
    this.#restoreValue = null;
    this.#syncInputs(initial);
    this.#value = initial;
    this.#commit('connect', { notify: false });
  }

  formAssociatedCallback(_form) {
    // form 属性改属 / 移入移出表单都会触发。按“当前值在新归属下未经确认”处理：
    // 旧表单的迟到结果带旧 formTag，会被防护丢弃；同时通知协调器取消等待提交。
    if (this.#connectedOnce) this.#commit('form-association');
    else this.#syncInternals();
  }

  formResetCallback() {
    // reset 回到 value 属性声明的默认值，并视为一次新的值修订（取消等待提交）。
    this.#defaultValue = parseValue(this.getAttribute('value'));
    this.#syncInputs(this.#defaultValue);
    this.#value = { ...this.#defaultValue };
    this.#commit('reset');
  }

  formDisabledCallback(disabled) {
    // 属性 disabled 或祖先 fieldset disabled 都会以 disabled=true 回调。
    this.#internalDisabled = disabled;
    this.#abortPending();                       // 作废在途、resolve 等待器
    this.#confirmed = false;
    this.#lastOk = false;
    this.#lastReason = '';
    if (disabled) {
      // 禁用本身也是一次修订：取消任何等待提交，且不参与数据与校验。
      this.#rev += 1;
      this.#notify('invalidated');
      this.#syncInternals();
      this.#syncInputsDisabled();
      this.#renderStatus();
    } else {
      this.#syncInputsDisabled();
      // 恢复时旧结果不能直接算有效：以当前值重新发起一轮校验。
      this.#commit('reenable');
    }
  }

  formStateRestoreCallback(state, _mode) {
    // 浏览器状态恢复（历史导航/自动填充）：state 即 setFormValue 的第二参数。
    const restored = parseValue(state);
    if (this.#connectedOnce) {
      this.#syncInputs(restored);
      this.#value = restored;
      this.#commit('restore');
    } else {
      this.#restoreValue = restored;
    }
  }

  attributeChangedCallback(name, _oldVal, newVal) {
    if (!this.#connectedOnce) return;
    if (name === 'value') {
      // value 属性只声明默认值；运行期改变由 reset 体现（同原生 defaultValue 语义）。
      this.#defaultValue = parseValue(newVal);
    } else if (name === 'required' || name === 'name') {
      this.#syncInternals();
    }
    // disabled 属性变化由浏览器的 formDisabledCallback 统一处理。
  }

  // ---- 对外只读视图（供协调器/测试使用）---------------------------------

  get form() {
    return this.#internals.form;
  }
  get name() {
    return this.getAttribute('name') ?? '';
  }
  get validity() {
    return this.#internals.validity;
  }
  get validationMessage() {
    return this.#internals.validationMessage;
  }
  get willValidate() {
    return this.#internals.willValidate;
  }
  get isPending() {
    return this.#pending !== null;
  }
  /** 当前在途 Worker 请求 id（测试用于精确控制/放行某一条结果）。 */
  get pendingId() {
    return this.#pending ? this.#pending.id : null;
  }
  /** 当前值修订号，测试用于核对“每次请求关联值修订”。 */
  get rev() {
    return this.#rev;
  }
  get currentValue() {
    return { ...this.#value };
  }
  get confirmed() {
    return this.#confirmed;
  }

  checkValidity() {
    return this.#internals.checkValidity();
  }
  reportValidity() {
    return this.#internals.reportValidity();
  }

  /** 编程设值：与用户输入走同一条“立即撤销 + 重新校验”路径。 */
  setValue(next) {
    const v = normalize(next);
    if (v.region === this.#value.region && v.postal === this.#value.postal) return;
    this.#syncInputs(v);
    this.#value = v;
    this.#commit('programmatic');
  }

  /** 在当前在途校验落定（或被作废）后 resolve。 */
  settled() {
    if (!this.#pending) return Promise.resolve();
    return new Promise((resolve) => this.#settlers.add(resolve));
  }

  // ---- 内部实现 ----------------------------------------------------------

  get #disabled() {
    return this.#internalDisabled || this.hasAttribute('disabled');
  }

  /** 统一的值修订入口：推进 rev、作废在途、撤销确认、通知协调器、重新校验。 */
  #commit(origin, { notify = true } = {}) {
    this.#rev += 1;
    this.#abortPending();
    this.#confirmed = false;
    if (notify && origin !== 'connect') this.#notify('invalidated');
    this.#syncInternals();
    this.#renderStatus();
    if (!this.#disabled) this.#startValidation(origin);
  }

  #abortPending() {
    this.#pending = null;
    const settlers = this.#settlers;
    this.#settlers = new Set();
    for (const resolve of settlers) resolve();
  }

  #notify(kind) {
    window.dispatchEvent(
      new CustomEvent(`region-postal:${kind}`, {
        detail: { field: this, form: this.#internals.form, rev: this.#rev },
      })
    );
  }

  #formTag() {
    const form = this.#internals.form;
    if (!form) return null;
    return form.dataset.tag || form.id || form.name || '';
  }

  #startValidation(_origin) {
    const value = this.#value;

    // 空值不请求 Worker：本地即可定状态（required 由 #syncInternals 处理）。
    if (isEmptyValue(value)) {
      this.#confirmed = true;
      this.#lastOk = true;
      this.#lastReason = 'empty';
      this.#syncInternals();
      this.#renderStatus();
      this.#notify('resolved');
      return;
    }

    const rev = this.#rev;
    const formTag = this.#formTag();
    const { id, promise } = validate({
      region: value.region,
      postal: value.postal,
      rev,
      formTag,
    });
    this.#pending = { id, rev, formTag };
    this.#syncInternals();
    this.#renderStatus();

    promise.then((msg) => {
      // 迟到结果防护 1：值修订号必须仍是发起时的修订号（输入/reset/改属/禁用已推进 rev）。
      if (this.#rev !== rev) return;
      // 迟到结果防护 2：表单归属必须与发起时一致（form 属性改属后不得污染新表单状态）。
      if (this.#formTag() !== formTag) return;
      // 防护 3：必须仍是同一个在途请求。
      if (!this.#pending || this.#pending.id !== id) return;
      // 防护 4：disabled 期间到达的结果一律丢弃。
      if (this.#disabled) return;

      this.#pending = null;
      this.#confirmed = true;
      this.#lastOk = !!msg.ok;
      this.#lastReason = msg.reason;
      this.#syncInternals();
      this.#renderStatus();
      const settlers = this.#settlers;
      this.#settlers = new Set();
      for (const resolve of settlers) resolve();
      this.#notify('resolved');
    });
  }

  /** 根据 disabled / 值 / 确认结果写入 ElementInternals 的值与约束状态。 */
  #syncInternals() {
    const internals = this.#internals;

    if (this.#disabled) {
      // 禁用时不参与数据，也不参与校验。
      internals.setFormValue(null);
      internals.setValidity({});
      return;
    }

    const json = JSON.stringify(this.#value);
    // 第二参数保存用户可编辑状态，供 formStateRestoreCallback 恢复。
    internals.setFormValue(json, json);

    const required = this.hasAttribute('required');
    const empty = isEmptyValue(this.#value);

    if (required && empty) {
      internals.setValidity({ valueMissing: true }, '请选择地区并填写邮编', this.#postalInput);
      return;
    }
    if (empty) {
      internals.setValidity({});
      return;
    }
    if (this.#pending) {
      // 关键防线：校验未结束时挂自定义错误，原生 requestSubmit 必被阻止，
      // 避免“看起来通过却提交旧值”。
      internals.setValidity({ customError: true }, '正在校验地区与邮编…', this.#postalInput);
      return;
    }
    if (this.#confirmed && this.#lastOk) {
      internals.setValidity({});
      return;
    }
    if (this.#confirmed && !this.#lastOk) {
      internals.setValidity(
        { customError: true },
        REASON_MESSAGE[this.#lastReason] || '地区/邮编校验未通过',
        this.#postalInput
      );
      return;
    }
    internals.setValidity({ customError: true }, '地区/邮编尚未校验', this.#postalInput);
  }

  #syncInputs(v) {
    this.#regionSelect.value = v.region;
    this.#postalInput.value = v.postal;
  }

  #syncInputsDisabled() {
    const d = this.#disabled;
    this.#regionSelect.disabled = d;
    this.#postalInput.disabled = d;
  }

  #renderStatus() {
    const el = this.#statusEl;
    const states = this.#internals.states;
    if (states) {
      if (this.#pending) states.add('--pending');
      else states.delete('--pending');
    }
    if (this.#disabled) {
      el.textContent = '已禁用（不参与提交与校验）';
      el.className = 'status';
      return;
    }
    if (this.#pending) {
      el.textContent = `校验中…（修订 ${this.#pending.rev}）`;
      el.className = 'status pending';
      return;
    }
    if (this.#confirmed && this.#lastOk) {
      el.textContent =
        this.#lastReason === 'empty' ? '未填写（可选）' : `校验通过（修订 ${this.#rev}）`;
      el.className = 'status ok';
      return;
    }
    if (this.#confirmed && !this.#lastOk) {
      el.textContent = REASON_MESSAGE[this.#lastReason] || '校验未通过';
      el.className = 'status bad';
      return;
    }
    el.textContent = '';
    el.className = 'status';
  }
}

if (!customElements.get('region-postal-field')) {
  customElements.define('region-postal-field', RegionPostalField);
}
