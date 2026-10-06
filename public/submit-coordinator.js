/**
 * 统一提交协调器
 * ----------------
 * 拦截两类“提交意图”：
 *   1. 点击提交按钮（document 捕获阶段，能在原生激活行为前 preventDefault）
 *   2. 控件内 Enter（由 region-postal-field 通过 onEnterIntention 回调）
 *
 * 规则：
 *   - 若该表单没有任何 pending 的地区/邮编控件：完全不干预，走浏览器原生提交，
 *     原生约束校验（包括其他控件）照常生效。
 *   - 若有 pending：阻止本次默认提交，等待这些控件的当前校验落定；
 *     等待期间一旦发生 改值 / reset / 禁用或恢复 / form 属性改属，
 *     控件会发 region-postal:invalidated，本次提交立即取消。
 *   - 等待结束且未取消：用【原 submitter】调用 form.requestSubmit(submitter)，
 *     重新走完整原生流程——不会绕开任何其他控件的约束校验。
 *   - 代码直接调用 form.requestSubmit() 不经协调器，pending 时由原生有效性直接阻止。
 */

const FIELD_TAG = 'REGION-POSTAL-FIELD';

function isSubmitButton(el) {
  if (!el || el.nodeType !== 1) return false;
  const tag = el.tagName;
  if (tag === 'INPUT') {
    return ['submit', 'image'].includes(el.type);
  }
  if (tag === 'BUTTON') {
    // 无 type 的 button 在表单内默认为 submit
    return el.type === 'submit' || (!el.hasAttribute('type') && el.form);
  }
  return false;
}

function regionPostalFields(form) {
  // 使用 form.elements：既包含表单后代，也包含通过 form 属性改属而来的关联控件。
  return Array.from(form.elements).filter(
    (el) => el.tagName === FIELD_TAG && el.form === form
  );
}

function pendingFields(form) {
  // willValidate === false 覆盖 disabled（含 disabled fieldset）等不参与校验的情况。
  return regionPostalFields(form).filter(
    (el) => el.willValidate && el.isPending
  );
}

function defaultSubmitter(form) {
  const candidates = form.querySelectorAll(
    'button, input[type="submit"], input[type="image"]'
  );
  for (const el of candidates) {
    if (el.form === form && isSubmitButton(el) && !el.disabled) return el;
  }
  return null;
}

const waitingForms = new WeakSet();

function coordinateSubmit(form, submitter, fields, via) {
  if (waitingForms.has(form)) {
    // 等待期间重复发起（连点/再按 Enter）：忽略，第一次等待的结果决定一切。
    return;
  }
  waitingForms.add(form);
  form.dataset.submissionState = 'waiting';

  let cancelled = false;
  let cancelReason = '';

  const cleanup = () => {
    window.removeEventListener('region-postal:invalidated', onInvalidated);
    form.removeEventListener('reset', onReset);
    waitingForms.delete(form);
    if (form.dataset.submissionState === 'waiting') delete form.dataset.submissionState;
  };

  const cancel = (reason) => {
    if (cancelled) return;
    cancelled = true;
    cancelReason = reason;
    form.dataset.submissionState = 'cancelled';
    cleanup();
    form.dispatchEvent(
      new CustomEvent('region-postal:submission-cancelled', {
        bubbles: true,
        detail: { reason, via },
      })
    );
  };

  const onInvalidated = (e) => {
    // 改值 / reset / 改属 / 禁用，只要涉及本次等待跟踪的控件，取消提交。
    if (fields.includes(e.detail.field)) {
      cancel(e.detail.field.form !== form ? 'reassociated' : 'invalidated');
    }
  };
  const onReset = () => cancel('reset');

  window.addEventListener('region-postal:invalidated', onInvalidated);
  form.addEventListener('reset', onReset);

  Promise.all(fields.map((f) => f.settled())).then(() => {
    if (cancelled) return;
    cleanup();

    // 落定后重新核对：归属、pending、参与校验资格。
    const drifted = fields.some(
      (f) => f.form !== form || f.isPending || !f.willValidate
    );
    if (drifted) return;

    // 让原生有效性给出结论（含其他控件）；有效则用原 submitter 走原生 requestSubmit。
    if (!form.checkValidity()) {
      form.reportValidity();
      form.dispatchEvent(
        new CustomEvent('region-postal:submission-blocked', {
          bubbles: true,
          detail: { via },
        })
      );
      return;
    }

    form.dataset.submissionState = 'dispatching';
    try {
      if (submitter && submitter.isConnected && submitter.form === form && !submitter.disabled) {
        form.requestSubmit(submitter);
      } else {
        // Enter 且原默认 submitter 已失效，退化为无 submitter 的原生提交。
        form.requestSubmit();
      }
    } finally {
      delete form.dataset.submissionState;
    }
  });
}

document.addEventListener(
  'click',
  (event) => {
    if (event.defaultPrevented || event.button !== 0) return;
    const path = event.composedPath ? event.composedPath() : [];
    const submitter = path.find(isSubmitButton);
    if (!submitter) return;
    const form = submitter.form;
    if (!form) return;

    const fields = pendingFields(form);
    if (fields.length === 0) {
      // 没有在途校验：不干预，浏览器按原生流程提交并执行全部约束校验。
      return;
    }
    event.preventDefault();
    coordinateSubmit(form, submitter, fields, 'click');
  },
  true
);

/** 供自定义元素在内部 Enter 时调用。 */
export function handleEnterIntention(field) {
  const form = field.form;
  if (!form) return;
  const fields = pendingFields(form);
  if (fields.length === 0) {
    // 无在途校验：以默认 submitter（若有）直接走原生 requestSubmit，
    // 无效则由浏览器拦截并提示，与物理 Enter 行为一致。
    const submitter = defaultSubmitter(form);
    if (submitter) form.requestSubmit(submitter);
    else form.requestSubmit();
    return;
  }
  coordinateSubmit(form, defaultSubmitter(form), fields, 'enter');
}

/** 把控件与协调器接线（每个元素实例调用一次）。 */
export function wireField(field) {
  if (field.__submitCoordinatorWired) return;
  field.__submitCoordinatorWired = true;
  field.onEnterIntention = handleEnterIntention;
}

// 自动为页面上（含未来插入）的所有控件接线。
document.addEventListener('DOMContentLoaded', () => {
  const wireAll = () => {
    document
      .querySelectorAll(FIELD_TAG.toLowerCase())
      .forEach((el) => wireField(el));
  };
  wireAll();
  new MutationObserver(wireAll).observe(document.body, { childList: true, subtree: true });
});
