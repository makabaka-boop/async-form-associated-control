// @ts-check
import { test, expect } from '@playwright/test';

/**
 * 浏览器测试：通过挂起/放行同源校验 Worker，精确控制响应返回顺序，
 * 核对“一次确认只提交那次确认对应的字段”以及重置、禁用 fieldset、
 * form 属性改属、迟到旧响应、直接 requestSubmit 等场景。
 */

const SHIP = '#ship-field';
const BILL = '#bill-field';
const ORPHAN = '#orphan-field';

async function state(page, sel = SHIP) {
  return page.$eval(sel, (el) => ({
    pending: el.isPending,
    pendingId: el.pendingId,
    rev: el.rev,
    confirmed: el.confirmed,
    valid: el.validity.valid,
    message: el.validationMessage,
    value: el.currentValue,
    formId: el.form ? el.form.id : null,
    willValidate: el.willValidate,
  }));
}

async function setValue(page, sel, region, postal) {
  await page.$eval(
    sel,
    (el, [r, p]) => el.setValue({ region: r, postal: p }),
    [region, postal]
  );
}

async function waitIdle(page, sel = SHIP) {
  await page.waitForFunction(
    (s) => {
      const el = document.querySelector(s);
      return el && !el.isPending && el.confirmed;
    },
    sel
  );
}

async function waitPending(page, sel = SHIP) {
  await page.waitForFunction(
    (s) => {
      const el = document.querySelector(s);
      return el && el.isPending;
    },
    sel
  );
}

async function stallOn(page) {
  await page.evaluate(() => window.__demo.configureWorker({ stall: true }));
}

async function release(page, ids) {
  await page.evaluate((ids) => window.__demo.releaseResults(ids), ids);
}

async function ledger(page) {
  return page.evaluate(() => window.__demo.getLedger());
}

async function logText(page) {
  return (await page.locator('#log').textContent()) || '';
}

async function submitCount(page, label) {
  const text = await logText(page);
  return text
    .split('\n')
    .filter((l) => l.includes('SUBMIT 实际触发') && l.includes(`（${label}）`)).length;
}

async function lastFormData(page, formId) {
  return page.evaluate((id) => {
    const f = document.getElementById(id);
    return (f.__lastFormData || []).map(([name, value]) => {
      try {
        return [name, JSON.parse(value)];
      } catch {
        return [name, value];
      }
    });
  }, formId);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  // 等初始默认值的首轮 Worker 校验落定，避免与用例内请求竞争。
  await waitIdle(page, SHIP);
  await page.evaluate(() => window.__demo.clearLedger());
});

test('1. 具名 JSON 值通过真实 formdata 提交；等待 pending 后用原 submitter 原生提交，请求带 rev/表单归属', async ({
  page,
}) => {
  await page.locator('#ship-contact').fill('张三');
  await stallOn(page);
  await setValue(page, SHIP, '北京市', '100080');
  await waitPending(page, SHIP);
  const s1 = await state(page, SHIP);
  expect(s1.valid).toBe(false); // pending 期间原生有效性即无效

  await page.locator('#ship-submit').click(); // 点击发生在后台校验未结束时
  await expect
    .poll(() => submitCount(page, '发货单'), { timeout: 1500 })
    .toBe(0); // 没有提前提交旧值
  await expect
    .poll(
      async () =>
        (await page.locator('#shipping-form').getAttribute('data-submission-state')) || '',
      { timeout: 1500 }
    )
    .toBe('waiting');

  await release(page, [s1.pendingId]);
  await waitIdle(page, SHIP);

  await expect.poll(() => submitCount(page, '发货单')).toBe(1);
  const text = await logText(page);
  expect(text).toContain('submitter=button#ship-submit'); // 原 submitter 重新走原生 requestSubmit

  const entries = await lastFormData(page, 'shipping-form');
  expect(entries).toContainEqual([
    'shipAddress',
    { region: '北京市', postal: '100080' },
  ]); // 单个具名 JSON 值
  expect(entries).toContainEqual(['contact', '张三']);
  expect(entries).toContainEqual(['action', 'ship']);

  const led = await ledger(page);
  expect(led).toHaveLength(1);
  expect(led[0]).toMatchObject({
    ok: true,
    reason: 'licensed',
    formTag: 'shipping',
  });
  expect(led[0].rev).toBe(s1.rev); // 提交值与该次确认修订一致
});

test('2. 迟到的旧响应不得改变新状态；一次确认只提交那次确认对应的值', async ({ page }) => {
  await page.locator('#ship-contact').fill('张三');
  await stallOn(page);

  // 第一次输入：上海 + 不在许可表的邮编
  await setValue(page, SHIP, '上海市', '209999');
  const idOld = (await state(page, SHIP)).pendingId;

  // 第二次输入：许可值（修订号推进）
  await setValue(page, SHIP, '北京市', '100080');
  const sNew = await state(page, SHIP);
  const idNew = sNew.pendingId;
  expect(idNew).not.toBe(idOld);

  await page.locator('#ship-submit').click(); // 等待的是新修订
  // 先放行新结果：提交应只含新值
  await release(page, [idNew]);
  await expect.poll(() => submitCount(page, '发货单')).toBe(1);
  let entries = await lastFormData(page, 'shipping-form');
  expect(entries).toContainEqual(['shipAddress', { region: '北京市', postal: '100080' }]);

  // 再放行迟到的旧结果：不得翻转状态，也不得产生第二次提交
  await release(page, [idOld]);
  await page.waitForTimeout(300);
  const sAfter = await state(page, SHIP);
  expect(sAfter.valid).toBe(true);
  expect(sAfter.rev).toBe(sNew.rev);
  expect(sAfter.message).toBe('');
  await expect.poll(() => submitCount(page, '发货单')).toBe(1);

  const led = await ledger(page);
  const oldRow = led.find((r) => r.id === idOld);
  const newRow = led.find((r) => r.id === idNew);
  expect(oldRow.ok).toBe(false);
  expect(oldRow.reason).toBe('not-licensed');
  expect(newRow.ok).toBe(true);
  expect(oldRow.rev).toBeLessThan(newRow.rev); // 每次请求关联值修订

  // 再次提交仍是新值
  await page.locator('#ship-submit').click();
  await expect.poll(() => submitCount(page, '发货单')).toBe(2);
  entries = await lastFormData(page, 'shipping-form');
  expect(entries).toContainEqual(['shipAddress', { region: '北京市', postal: '100080' }]);
});

test('3. 等待期间 reset 取消提交；reset 回默认值并重新校验', async ({ page }) => {
  await page.locator('#ship-contact').fill('张三');
  await stallOn(page);
  await setValue(page, SHIP, '广州市', '510620');
  const id = (await state(page, SHIP)).pendingId;
  const revBefore = (await state(page, SHIP)).rev;

  await page.locator('#ship-submit').click();
  await expect
    .poll(
      async () =>
        (await page.locator('#shipping-form').getAttribute('data-submission-state')) || '',
      { timeout: 1500 }
    )
    .toBe('waiting');

  await page.locator('#ship-reset').click(); // 等待期间重置
  await expect.poll(() => logText(page)).toContain('提交等待被取消（发货单）: reset');
  await expect.poll(() => submitCount(page, '发货单')).toBe(0);

  // reset 后是默认值的新修订，旧请求结果到达也无效
  const sReset = await state(page, SHIP);
  expect(sReset.value).toEqual({ region: '上海市', postal: '200120' });
  expect(sReset.rev).toBeGreaterThan(revBefore);
  expect(sReset.pending).toBe(true);
  await release(page, [id]); // 旧修订结果
  await page.waitForTimeout(200);
  const sAfterOld = await state(page, SHIP);
  expect(sAfterOld.pending).toBe(true); // 旧结果没有落定任何状态

  await release(page, [sReset.pendingId]); // 默认值的新结果
  await waitIdle(page, SHIP);
  const sFinal = await state(page, SHIP);
  expect(sFinal.valid).toBe(true);
  expect(sFinal.value).toEqual({ region: '上海市', postal: '200120' });
  await expect.poll(() => submitCount(page, '发货单')).toBe(0);
});

test('4. disabled fieldset：不参与数据与校验；恢复后旧结果不能直接算有效', async ({
  page,
}) => {
  await page.locator('#ship-contact').fill('张三');
  await page.locator('#ship-toggle-fieldset').click(); // 禁用 fieldset
  const sDisabled = await state(page, SHIP);
  expect(sDisabled.willValidate).toBe(false);
  expect(sDisabled.valid).toBe(true); // 清除了一切约束
  // 禁用期间直接提交：必填复合控件既不阻止提交，也不出现在数据里
  await page.locator('#ship-submit').click();
  await expect.poll(() => submitCount(page, '发货单')).toBe(1);
  let entries = await lastFormData(page, 'shipping-form');
  expect(entries.find(([n]) => n === 'shipAddress')).toBeUndefined();
  expect(entries).toContainEqual(['contact', '张三']);

  // 挂起 Worker 后再恢复：必须重新发起校验，pending 期间不能凭旧结果直接算有效
  await stallOn(page);
  await page.locator('#ship-toggle-fieldset').click(); // 启用 fieldset
  await waitPending(page, SHIP);
  const sPending = await state(page, SHIP);
  expect(sPending.willValidate).toBe(true);
  expect(sPending.valid).toBe(false);
  expect(sPending.message).toContain('正在校验');
  const id = sPending.pendingId;

  // 直接 requestSubmit 在待校验时也必须被原生有效性阻止
  await page.evaluate(() => document.getElementById('shipping-form').requestSubmit());
  await expect.poll(() => submitCount(page, '发货单')).toBe(1); // 仍是禁用期间那一次

  await release(page, [id]);
  await waitIdle(page, SHIP);
  expect((await state(page, SHIP)).valid).toBe(true);
  await page.evaluate(() => document.getElementById('shipping-form').requestSubmit());
  await expect.poll(() => submitCount(page, '发货单')).toBe(2);
  entries = await lastFormData(page, 'shipping-form');
  expect(entries).toContainEqual(['shipAddress', { region: '上海市', postal: '200120' }]);
});

test('5. form 属性改属：待校验中改属取消原表单等待，数据与结果只归属新表单', async ({
  page,
}) => {
  await page.locator('#ship-contact').fill('张三');
  expect((await state(page, ORPHAN)).formId).toBeNull();

  await page.locator('#attach-ship').click();
  expect((await state(page, ORPHAN)).formId).toBe('shipping-form');

  await stallOn(page);
  await setValue(page, ORPHAN, '北京市', '100080');
  const idShip = (await state(page, ORPHAN)).pendingId;

  await page.locator('#ship-submit').click(); // 发货单因游离控件 pending 而等待
  await expect
    .poll(
      async () =>
        (await page.locator('#shipping-form').getAttribute('data-submission-state')) || '',
      { timeout: 1500 }
    )
    .toBe('waiting');

  await page.locator('#attach-bill').click(); // 等待期间改属到账单
  await expect.poll(() => logText(page)).toContain(
    '提交等待被取消（发货单）: reassociated'
  );
  const sBill = await state(page, ORPHAN);
  expect(sBill.formId).toBe('billing-form');
  expect(sBill.pending).toBe(true); // 新归属下重新校验
  const idBill = sBill.pendingId;
  expect(idBill).not.toBe(idShip);

  // 旧表单的迟到结果到达：不改变控件状态，也不替原表单提交
  await release(page, [idShip]);
  await page.waitForTimeout(200);
  expect((await state(page, ORPHAN)).pending).toBe(true);
  await expect.poll(() => submitCount(page, '发货单')).toBe(0);

  await release(page, [idBill]);
  await waitIdle(page, ORPHAN);

  // 账单数据包含该控件，发货单不再包含
  await page.locator('#bill-title').fill('账单抬头');
  await page.locator('#bill-submit').click();
  await expect.poll(() => submitCount(page, '账单')).toBe(1);
  const billEntries = await lastFormData(page, 'billing-form');
  expect(billEntries).toContainEqual([
    'extraAddress',
    { region: '北京市', postal: '100080' },
  ]);

  await page.evaluate(() => document.getElementById('shipping-form').requestSubmit());
  await expect.poll(() => submitCount(page, '发货单')).toBe(1);
  const shipEntries = await lastFormData(page, 'shipping-form');
  expect(shipEntries.find(([n]) => n === 'extraAddress')).toBeUndefined();

  const led = await ledger(page);
  expect(led.find((r) => r.id === idShip)?.formTag).toBe('shipping');
  expect(led.find((r) => r.id === idBill)?.formTag).toBe('billing');
});

test('6. 直接 requestSubmit 在 pending / 校验失败时被原生阻止，成功后才放行', async ({
  page,
}) => {
  await page.locator('#ship-contact').fill('张三');
  await stallOn(page);
  await setValue(page, SHIP, '上海市', '209999'); // 邮编格式合法但不在许可表
  await waitPending(page, SHIP);

  await page.evaluate(() => document.getElementById('shipping-form').requestSubmit());
  await expect.poll(() => submitCount(page, '发货单'), { timeout: 1000 }).toBe(0);

  const id = (await state(page, SHIP)).pendingId;
  await release(page, [id]);
  await waitIdle(page, SHIP);
  const sBad = await state(page, SHIP);
  expect(sBad.valid).toBe(false);
  expect(sBad.message).toContain('不在演示许可表');

  await page.evaluate(() => document.getElementById('shipping-form').requestSubmit());
  await expect.poll(() => submitCount(page, '发货单'), { timeout: 1000 }).toBe(0);

  // 换成许可值并落定后，直接 requestSubmit 才能成功
  await setValue(page, SHIP, '杭州市', '310013');
  const id2 = (await state(page, SHIP)).pendingId;
  await release(page, [id2]);
  await waitIdle(page, SHIP);
  await page.evaluate(() => document.getElementById('shipping-form').requestSubmit());
  await expect.poll(() => submitCount(page, '发货单')).toBe(1);
});

test('7. 控件内 Enter：等待当前校验后以默认 submitter 原生提交；失败则被拦', async ({
  page,
}) => {
  await page.locator('#ship-contact').fill('张三');
  await stallOn(page);
  await setValue(page, SHIP, '广州市', '510620');
  await waitPending(page, SHIP);

  await page.locator(SHIP).locator('input').focus();
  await page.keyboard.press('Enter');
  await expect
    .poll(
      async () =>
        (await page.locator('#shipping-form').getAttribute('data-submission-state')) || '',
      { timeout: 1500 }
    )
    .toBe('waiting');
  await expect.poll(() => submitCount(page, '发货单'), { timeout: 1000 }).toBe(0);

  await release(page, [(await state(page, SHIP)).pendingId]);
  await waitIdle(page, SHIP);
  await expect.poll(() => submitCount(page, '发货单')).toBe(1);
  expect(await logText(page)).toContain('submitter=button#ship-submit');

  // 等待期间改值取消该次 Enter 提交
  await setValue(page, SHIP, '杭州市', '310013');
  await page.locator(SHIP).locator('input').focus();
  await page.keyboard.press('Enter');
  await setValue(page, SHIP, '杭州市', '310000'); // 等待中改值
  await expect.poll(() => logText(page)).toContain('提交等待被取消');
  await page.waitForTimeout(200);
  await expect.poll(() => submitCount(page, '发货单')).toBe(1);
});

test('8. 两张真实表单互不干扰：不绕开其他控件校验；他单 pending 不阻止本单提交', async ({
  page,
}) => {
  await stallOn(page);
  await setValue(page, BILL, '上海市', '200000');
  await waitPending(page, BILL);

  // 账单在 pending，发货单已有效：提交发货单应立即走原生流程
  await page.locator('#ship-contact').fill('张三');
  await page.locator('#ship-submit').click();
  await expect.poll(() => submitCount(page, '发货单')).toBe(1);
  await expect.poll(() => submitCount(page, '账单'), { timeout: 1000 }).toBe(0);

  // 账单等待结束后地区/邮编有效，但原生必填的账单抬头为空：
  // 点击走的是纯原生路径，协调器不拦截，由浏览器原生约束校验阻止。
  await release(page, [(await state(page, BILL)).pendingId]);
  await waitIdle(page, BILL);
  await page.locator('#bill-submit').click();
  await page.waitForTimeout(300);
  await expect.poll(() => submitCount(page, '账单')).toBe(0);
  // 原生必填控件处于 valueMissing
  const titleValidity = await page
    .locator('#bill-title')
    .evaluate((el) => el.validity.valueMissing);
  expect(titleValidity).toBe(true);

  await page.locator('#bill-title').fill('某公司');
  await page.locator('#bill-submit').click();
  await expect.poll(() => submitCount(page, '账单')).toBe(1);
  const entries = await lastFormData(page, 'billing-form');
  expect(entries).toContainEqual([
    'billAddress',
    { region: '上海市', postal: '200000' },
  ]);
  expect(entries).toContainEqual(['title', '某公司']);
});

test('9. 状态恢复：formStateRestoreCallback 使用恢复值并重新校验（旧状态不沿用）', async ({
  page,
}) => {
  const revBefore = (await state(page, SHIP)).rev;
  await stallOn(page);

  await page.$eval(SHIP, (el) => {
    el.constructor.prototype.formStateRestoreCallback.call(
      el,
      JSON.stringify({ region: '广州市', postal: '510000' }),
      'restore'
    );
  });

  await waitPending(page, SHIP);
  const s = await state(page, SHIP);
  expect(s.value).toEqual({ region: '广州市', postal: '510000' });
  expect(s.valid).toBe(false); // 恢复后重新校验，pending 中不直接有效
  expect(s.rev).toBeGreaterThan(revBefore);
  expect(await page.locator(SHIP).locator('input').inputValue()).toBe('510000');

  await release(page, [s.pendingId]);
  await waitIdle(page, SHIP);
  expect((await state(page, SHIP)).valid).toBe(true);
});

test('10. 无隐藏 input：仅靠 ElementInternals 下发表单值；默认值即初始 JSON', async ({
  page,
}) => {
  // DOM 中不存在同名隐藏/其他 input 冒充值
  const hidden = await page.evaluate(() => {
    return !!document.querySelector(
      'input[name="shipAddress"], input[name="billAddress"], input[name="extraAddress"]'
    );
  });
  expect(hidden).toBe(false);

  const fd = await page.evaluate(() => {
    const f = document.getElementById('shipping-form');
    return [...new FormData(f).entries()];
  });
  // 注：这里构造 FormData 仅用于测试断言；演示日志中的 formdata 来自真实提交流程。
  expect(fd).toContainEqual([
    'shipAddress',
    JSON.stringify({ region: '上海市', postal: '200120' }),
  ]);

  // internals 能力齐全
  const caps = await page.$eval(SHIP, (el) => ({
    formAssociated: el.constructor.formAssociated,
    willValidate: el.willValidate,
    formId: el.form && el.form.id,
  }));
  expect(caps).toEqual({
    formAssociated: true,
    willValidate: true,
    formId: 'shipping-form',
  });
});

test('11. 校验只访问同源固定许可表，不请求外部服务', async ({ page }) => {
  const requests = [];
  page.on('request', (req) => requests.push(new URL(req.url())));

  await page.reload({ waitUntil: 'networkidle' });
  await waitIdle(page, SHIP);

  const hosts = new Set(requests.map((u) => u.host));
  expect(hosts).toEqual(new Set(['127.0.0.1:4173']));
  const paths = requests.map((u) => u.pathname);
  expect(paths).toContain('/data/licenses.json');
  expect(paths).toContain('/workers/validation-worker.js');
  expect(requests.every((u) => u.protocol === 'http:')).toBe(true);
});
