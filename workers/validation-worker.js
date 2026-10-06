/**
 * 地区/邮编校验 Worker（经典 Web Worker，同源运行）。
 *
 * 数据来源只有仓库内的固定演示许可表 /data/licenses.json（同源静态文件），
 * 不访问任何外部服务。
 *
 * 协议：
 *   { type: 'configure', stall: boolean }
 *       true 时所有校验结果先挂起，便于测试/演示精确控制返回顺序。
 *   { type: 'validate', id, rev, region, postal, formTag }
 *       发起一次校验；rev 是控件的值修订号，formTag 是发起时所属表单。
 *   { type: 'release', ids: string[] | null }
 *       放行指定 id（null 表示全部，按挂起顺序）。
 *   回复：
 *   { type: 'result', id, rev, formTag, ok, reason }
 */

let tablePromise = null;
let stalled = false;
const held = new Map();
let normalDelayMs = 50;

async function loadTable() {
  if (!tablePromise) {
    tablePromise = fetch('/data/licenses.json', { cache: 'no-store' })
      .then((r) => {
        if (!r.ok) throw new Error('许可表加载失败: ' + r.status);
        return r.json();
      });
  }
  return tablePromise;
}

function evaluate(table, region, postal) {
  region = (region || '').trim();
  postal = (postal || '').trim();

  if (!region && !postal) return { ok: true, reason: 'empty' };
  if (!region) return { ok: false, reason: 'region-empty' };
  if (!/^\d{6}$/.test(postal)) return { ok: false, reason: 'postal-format' };

  const rule = table.postalRules.find((r) => r.region === region);
  if (!rule) return { ok: false, reason: 'region-unknown' };
  if (!new RegExp(rule.pattern).test(postal)) {
    return { ok: false, reason: 'postal-region-mismatch' };
  }

  const licensed = table.licenses.some(
    (l) => l.region === region && l.postal === postal
  );
  if (!licensed) return { ok: false, reason: 'not-licensed' };

  return { ok: true, reason: 'licensed' };
}

function postResult(message) {
  self.postMessage(message);
}

self.onmessage = async (e) => {
  const msg = e.data || {};

  if (msg.type === 'configure') {
    stalled = !!msg.stall;
    if (typeof msg.normalDelayMs === 'number') normalDelayMs = msg.normalDelayMs;
    return;
  }

  if (msg.type === 'release') {
    const ids =
      msg.ids == null
        ? Array.from(held.keys())
        : msg.ids.filter((id) => held.has(id));
    for (const id of ids) {
      const queued = held.get(id);
      held.delete(id);
      postResult(queued);
    }
    return;
  }

  if (msg.type === 'validate') {
    const table = await loadTable();
    const result = evaluate(table, msg.region, msg.postal);
    const out = {
      type: 'result',
      id: msg.id,
      rev: msg.rev,
      formTag: msg.formTag,
      region: msg.region,
      postal: msg.postal,
      ok: result.ok,
      reason: result.reason,
    };

    if (stalled) {
      held.set(msg.id, out);
    } else {
      setTimeout(() => postResult(out), normalDelayMs);
    }
  }
};
