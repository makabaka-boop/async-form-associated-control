# 地区/邮编复合控件：Form-Associated 自定义元素 + 统一提交协调

一个**通过 `ElementInternals` 原生参与表单**的地区+邮编复合控件，演示并测试它在
异步后台校验（同源 Web Worker）与多表单场景下如何避免：

- “看起来通过校验，却在后台校验未结束时提交旧值”；
- 控件被 `form` 属性移到另一张表单后，仍替原表单提交或被旧表单的迟到结果污染；
- 直接调用 `requestSubmit()` 绕过待校验状态。

**不使用任何隐藏 input**。表单数据与约束完全由 `attachInternals()` 下发，
成功提交日志只来自真实的 `submit` / `formdata` 流程。

## 运行

```bash
npm install
npx playwright install chromium      # 浏览器
npm start                            # http://localhost:4173
npm test                             # Playwright 浏览器测试（自动起服务）
```

> 受限（无 root）环境若缺少 Chromium 系统库，可把 deb 依赖解压到用户目录
> （`apt-get download <libs>` 后 `dpkg-deb -x` 到某前缀），
> 再用 `CHROME_LIBS` 指向该前缀（见 `scripts/run-tests.sh`）。

## 目录

```
data/licenses.json            固定演示许可表（唯一数据源，随仓库）
workers/validation-worker.js  同源经典 Worker：查许可表 + 挂起/放行返回顺序
public/
  index.html                  两张真实表单（发货单/账单）+ 游离控件 + 调试面板
  region-postal-field.js      form-associated 自定义元素 <region-postal-field>
  worker-client.js            Worker 单例客户端（请求台账、挂起/放行）
  submit-coordinator.js       统一提交协调器（点击 / 控件内 Enter）
  demo.js                     真实 submit/formdata 日志、演示操作
scripts/server.mjs            零依赖同源静态服务器 + /submit-sink
tests/browser/region-postal.spec.js  11 项浏览器测试
```

## 控件如何原生参与表单

`static formAssociated = true` + `attachInternals()`：

- **数据**：`internals.setFormValue(json, json)`。控件以一个具名 JSON 值提交：
  `shipAddress = {"region":"上海市","postal":"200120"}`。第二参数用于浏览器状态恢复。
  `formdata` 事件中自动出现，无隐藏 input；`new FormData(form)` 同样可见。
- **约束校验**：`internals.setValidity(...)` + `validationMessage`，
  因此原生 `requestSubmit()` / 提交按钮在无效时会被浏览器拦截并提示。
- **生命周期**：
  - `formAssociatedCallback`——`form` 属性改属；
  - `formResetCallback`——reset 回到 `value` 属性默认值；
  - `formDisabledCallback`——属性 `disabled` 与祖先 `fieldset[disabled]` 合成；
  - `formStateRestoreCallback`——历史导航/自动填充恢复。

## 关键并发规则

1. **输入变化立即撤销**：每次值修订推进单调递增的 `rev`，作废在途请求、
   撤销“已确认”、并向协调器发 `region-postal:invalidated`。
2. **请求绑定修订与归属**：每次 Worker 请求携带 `{ id, rev, formTag }`。
   结果到达时四重防护：`rev` 必须未变、`formTag` 必须仍是当前表单、
   `id` 必须仍是在途请求、控件不得处于 disabled。迟到结果只进台账，不改状态。
3. **pending 即无效**：校验未结束时挂 `customError: true`（“正在校验…”），
   所以无论点击还是直接 `form.requestSubmit()`，原生提交都会被阻止。
4. **禁用语义**：禁用时 `setFormValue(null)` + 清除 validity，不参与数据与校验；
   恢复后**不沿用旧校验结果**，以当前值重新发起一轮校验（pending 期间仍无效）。

## 统一提交协调器（`submit-coordinator.js`）

- **点击提交按钮**：document 捕获阶段识别 submitter；其表单存在 pending 控件时
  `preventDefault` 并等待，否则完全不干预（其他控件的原生校验照常）。
- **控件内 Enter**：先阻止默认提交，回调协调器；无 pending 时直接
  `form.requestSubmit(defaultSubmitter)`。
- 等待的控件全部落定后，用**原 submitter** 调 `form.requestSubmit(submitter)`，
  重新走完整原生流程，不绕开任何其他控件校验。
- 等待期间发生 **改值 / reset / 禁用或恢复 / form 改属** → 本次等待立即取消
  （`region-postal:submission-cancelled`，原因含 `reset` / `reassociated` / `invalidated`）。
- 直接调用 `form.requestSubmit()` 不经协调器，pending 时由原生有效性阻止。

## Worker 与返回顺序控制

Worker 仅同源 `fetch('/data/licenses.json')` 一次并缓存，之后本地求值；
不请求任何外部服务。调试/测试通过：

```js
window.__demo.configureWorker({ stall: true }); // 挂起
setValue(field, ...)                            // 产生挂起结果 r1, r2...
window.__demo.releaseResults(['r2']);           // 先放新结果
window.__demo.releaseResults(['r1']);           // 再放迟到旧结果
window.__demo.getLedger();                      // 每条结果的 id/rev/formTag/ok/reason
```

演示表单 `action="/submit-sink" target="submit-sink"`（同源隐藏 iframe），
因此 `submit` 不被 `preventDefault`，真实 `formdata` 与提交都发生，而主页面不导航。

## 测试覆盖（浏览器内、控制 Worker 返回顺序）

1. 具名 JSON 值经真实 formdata 提交；等待 pending 后用原 submitter 原生提交，请求带 rev/formTag；
2. 迟到旧结果不翻转新状态；**一次确认只提交那次确认对应的值**；
3. 等待期间 reset 取消提交，reset 回默认值并重新校验；
4. disabled fieldset 不参与数据与校验；恢复后旧结果不直接算有效，pending 阻止直接 `requestSubmit`；
5. 待校验中 `form` 属性改属：取消原表单等待、旧结果不污染、数据只随新表单提交；
6. 直接 `requestSubmit()` 在 pending / 失败时被原生阻止；
7. 控件内 Enter 等待校验后以默认 submitter 原生提交；等待中改值取消；
8. 两张真实表单互不干扰；他单 pending 不阻止本单；原生必填控件不被绕开；
9. `formStateRestoreCallback` 使用恢复值并重新校验；
10. DOM 中无同名隐藏 input，值仅来自 ElementInternals；
11. 所有请求均为同源（含许可表与 Worker 脚本），无外部服务。
