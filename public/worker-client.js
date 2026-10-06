/**
 * ValidationWorker 的单例客户端。
 * - 全页面共享一个同源 Worker，只处理仓库内固定演示许可表。
 * - 每次 validate 关联值修订号 rev 与表单归属 formTag，供控件丢弃迟到/串表结果。
 * - 维护测试/调试可观察的请求台账（无外部服务）。
 */

const WORKER_URL = '/workers/validation-worker.js';

let worker = null;
let seq = 0;
const pending = new Map();

// 最近完成的请求，供测试控制顺序时观察（id/region/postal/rev/formTag/ok/reason）。
export const requestLedger = [];
// 每次 Worker 有结果落地时解析的等待器。
let nextResultResolvers = [];

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(WORKER_URL);
  worker.onmessage = (e) => {
    const msg = e.data;
    if (msg.type !== 'result') return;

    requestLedger.push({
      id: msg.id,
      rev: msg.rev,
      formTag: msg.formTag,
      region: msg.region,
      postal: msg.postal,
      ok: msg.ok,
      reason: msg.reason,
    });

    const resolver = pending.get(msg.id);
    if (resolver) {
      pending.delete(msg.id);
      resolver(msg);
    }
    const resolvers = nextResultResolvers;
    nextResultResolvers = [];
    for (const r of resolvers) r(msg);
  };
  worker.onerror = (e) => {
    console.error('validation worker error', e.message);
  };
  return worker;
}

export function configureWorker({ stall = false, normalDelayMs } = {}) {
  ensureWorker().postMessage({
    type: 'configure',
    stall,
    ...(typeof normalDelayMs === 'number' ? { normalDelayMs } : {}),
  });
}

/** 放行挂起的校验结果；ids 为 null 时按挂起顺序全部放行。 */
export function releaseResults(ids = null) {
  ensureWorker().postMessage({ type: 'release', ids });
}

/** 等待下一条 Worker 结果（测试控制返回顺序用）。 */
export function waitForNextResult() {
  return new Promise((resolve) => nextResultResolvers.push(resolve));
}

/**
 * 发起一次校验。
 * @returns {{ promise: Promise<object>, id: string }}
 *   id 唯一标识本次请求；promise resolve 时带 { ok, reason, rev, formTag, ... }
 */
export function validate({ region, postal, rev, formTag }) {
  const id = `r${++seq}`;
  const promise = new Promise((resolve) => {
    pending.set(id, resolve);
  });
  ensureWorker().postMessage({
    type: 'validate',
    id,
    rev,
    formTag,
    region,
    postal,
  });
  return { id, promise };
}

export function getLedger() {
  return requestLedger.slice();
}

export function clearLedger() {
  requestLedger.length = 0;
}
