/**
 * 演示页脚本：
 *  - 记录来自【实际 submit / formdata 流程】的日志（成功提交的唯一可信来源）；
 *  - 提供 Worker 返回顺序控制（挂起/放行）与 fieldset、form 改属等操作；
 *  - submit 不 preventDefault：表单提交到同源隐藏 iframe（/submit-sink），
 *    使 submit→formdata 完整真实发生，同时主页面不导航。
 */

import {
  configureWorker,
  releaseResults,
  waitForNextResult,
  getLedger,
  clearLedger,
} from './worker-client.js';
import { wireField } from './submit-coordinator.js';
import './region-postal-field.js';

const logEl = document.getElementById('log');

window.__demo = {
  configureWorker,
  releaseResults,
  waitForNextResult,
  getLedger,
  clearLedger,
};

function ts() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(
    d.getSeconds()
  ).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function log(line, data) {
  const suffix = data === undefined ? '' : '  ' + JSON.stringify(data);
  logEl.textContent += `[${ts()}] ${line}${suffix}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}
window.__demo.log = log;

function formSubmitSnapshot(form) {
  // 使用真实 formdata 事件中捕获的快照，不再二次构造 FormData（避免重复触发 formdata）。
  return (form.__lastFormData || []).map(([name, value]) => {
    let parsed = value;
    try {
      parsed = JSON.parse(value);
    } catch {
      /* 非 JSON 控件（如原生文本框）保留字符串 */
    }
    return [name, parsed];
  });
}

function wireFormLogging(form, label) {
  form.addEventListener('submit', (event) => {
    const submitter = event.submitter;
    // formdata 事件先于网络提交，排队到微任务等 formdata 监听器先记录。
    queueMicrotask(() => {
      log(
        `✅ SUBMIT 实际触发（${label}）submitter=${
          submitter ? `${submitter.tagName.toLowerCase()}#${submitter.id}` : '(none)'
        }`,
        formSubmitSnapshot(form)
      );
    });
  });

  form.addEventListener('formdata', (event) => {
    // 真实构造提交载荷时触发；这里捕获的是 ElementInternals 自动写入的具名 JSON 值。
    const entries = [];
    for (const [name, value] of event.formData.entries()) entries.push([name, value]);
    form.__lastFormData = entries;
    log(`   formdata 事件（${label}）`, entries);
  });

  form.addEventListener('reset', () => {
    log(`↺ reset 事件（${label}）`);
  });

  form.addEventListener('region-postal:submission-cancelled', (event) => {
    log(`⊘ 提交等待被取消（${label}）: ${event.detail.reason}（via=${event.detail.via}）`);
  });

  form.addEventListener('region-postal:submission-blocked', (event) => {
    log(`⛔ 等待结束但校验未通过（${label}，via=${event.detail.via}）`);
  });
}

wireFormLogging(document.getElementById('shipping-form'), '发货单');
wireFormLogging(document.getElementById('billing-form'), '账单');

// 控件在脚本执行时可能尚未升级，等待升级后接线 Enter。
async function whenDefinedAll() {
  await customElements.whenDefined('region-postal-field');
  document.querySelectorAll('region-postal-field').forEach((el) => wireField(el));
}
whenDefinedAll();

// ---- 调试按钮 ----
document.getElementById('stall-on').addEventListener('click', () => {
  configureWorker({ stall: true });
  log('▶ Worker 已挂起：校验结果需手动放行');
});
document.getElementById('stall-off').addEventListener('click', () => {
  configureWorker({ stall: false });
  log('▶ Worker 恢复自动延迟返回');
});
document.getElementById('release-all').addEventListener('click', () => {
  releaseResults(null);
  log('▶ 已放行全部挂起结果（按挂起顺序）');
});
document.getElementById('clear-log').addEventListener('click', () => {
  logEl.textContent = '';
});

// ---- fieldset disabled ----
document.getElementById('ship-toggle-fieldset').addEventListener('click', () => {
  const fs = document.getElementById('ship-fieldset');
  fs.disabled = !fs.disabled;
  log(`▶ 发货 fieldset.disabled = ${fs.disabled}`);
});

// ---- form 属性改属 ----
const orphan = document.getElementById('orphan-field');
document.getElementById('attach-ship').addEventListener('click', () => {
  orphan.setAttribute('form', 'shipping-form');
  log('▶ 游离控件 form 属性 → shipping-form');
});
document.getElementById('attach-bill').addEventListener('click', () => {
  orphan.setAttribute('form', 'billing-form');
  log('▶ 游离控件 form 属性 → billing-form');
});
document.getElementById('attach-none').addEventListener('click', () => {
  orphan.removeAttribute('form');
  log('▶ 游离控件脱离表单');
});

// 默认较短延迟，便于演示观察 pending 窗口。
configureWorker({ stall: false, normalDelayMs: 80 });
