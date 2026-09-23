/* content.js 行为测试（jsdom）——覆盖消息处理、流式渲染、页面取字、翻译缓存与代际守卫。
 * 运行：node test-content.js  或  npm test
 * 注：jsdom 未实现 innerText/checkVisibility，这里给 innerText 做了近似实现；
 *     生产代码在真实浏览器里使用原生实现。
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const CONTENT = fs.readFileSync(path.join(__dirname, "content.js"), "utf8");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function boot(initialStore = {}) {
  const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
    url: "https://example.com/",
    pretendToBeVisual: true,
    runScripts: "outside-only",   // 允许 window.eval 在页面全局作用域里执行 content.js
  });
  const { window } = dom;
  const doc = window.document;
  // jsdom 无法产生真实用户事件；记录处理器，仅在正向测试中显式模拟可信事件。
  // 攻击测试仍通过原生 dispatchEvent/.click()，isTrusted 保持 false。
  const handlers = new WeakMap();
  const addListener = window.EventTarget.prototype.addEventListener;
  window.EventTarget.prototype.addEventListener = function (type, fn, options) {
    if (!handlers.has(this)) handlers.set(this, {});
    (handlers.get(this)[type] ||= []).push(fn);
    return addListener.call(this, type, fn, options);
  };

  if (!("innerText" in window.HTMLElement.prototype)) {
    Object.defineProperty(window.HTMLElement.prototype, "innerText", {
      configurable: true,
      get() {
        const clone = this.cloneNode(true);
        clone.querySelectorAll("script,style,noscript").forEach((n) => n.remove());
        clone.querySelectorAll('[style*="display:none"],[style*="display: none"]').forEach((n) => n.remove());
        return clone.textContent || "";
      },
    });
  }

  const store = { ...initialStore };
  const sent = [];
  const listeners = [];
  let chatReply = null;
  let writingReply = null;
  const chrome = {
    runtime: {
      lastError: null,
      onMessage: { addListener(fn) { listeners.push(fn); } },
      sendMessage(msg, cb) {
        sent.push(msg);
        let resp = { ok: true };
        if (msg.type === "TRANSLATE") resp = { ok: true, out: "EN:" + msg.text };
        else if (msg.type === "TRANSLATE_BLOCKS") {
          resp = { ok: true, items: (msg.items || []).map((item) => ({ id: item.id, text: "T:" + item.text })), missing: [] };
        }
        else if (msg.type === "AGENT_STATE_GET") resp = { state: null };
        else if (msg.type === "CAPTURE_TAB") resp = { ok: false };
        else if (msg.type === "EXPLAIN_CHAT") {
          resp = chatReply ? chatReply(msg) : { ok: true, answer: '{"action":"done","answer":"完成"}' };
        }
        else if (["DRAFT_REPLY", "CHECK_TRANSLATION", "EXTRACT_OFFER"].includes(msg.type)) resp = writingReply(msg);
        if (cb) cb(resp);
      },
    },
    storage: {
      sync: {
        get(defaults, cb) { cb({ ...defaults, ...store }); },
        set(patch, cb) { Object.assign(store, patch); if (cb) cb(); },
      },
      onChanged: { addListener() {} },
    },
  };
  window.chrome = chrome;
  window.console.log = () => {};   // 静音 content.js 的加载日志，保持测试输出干净
  window.eval(CONTENT);

  const latest = () => listeners[listeners.length - 1];
  return {
    dom, window, doc, store, sent, latest,
    userEvent(el, type, props = {}) {
      const event = { isTrusted: true, target: el, preventDefault() {}, stopPropagation() {}, ...props };
      if (el['on' + type]) el['on' + type](event);
      for (const fn of handlers.get(el)?.[type] || []) fn.call(el, event);
    },
    setChatReply(fn) { chatReply = fn; },
    setWritingReply(fn) { writingReply = fn; },
    asks: (type) => sent.filter((m) => m.type === type),
    send(msg) {
      let resp;
      latest()(msg, {}, (r) => { resp = r; });
      return resp;
    },
  };
}

function selectionSender(env, el) {
  return (text) => {
    el.textContent = text;
    const range = env.doc.createRange();
    range.selectNodeContents(el);
    const sel = env.window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    env.userEvent(env.doc, "mouseup", { target: el, clientX: 5, clientY: 5 });
  };
}

(async () => {
  /* 1. PING 返回当前版本，供弹窗诊断显示 */
  let env = boot();
  assert.equal(env.send({ type: "PING" }).v, "2.1.0");

  /* 2. EXPLAIN_RESULT 把 markdown 渲染进面板并标注来源 */
  env.send({ type: "EXPLAIN_RESULT", text: "**重点**\n\n- 甲\n- 乙", context: "页面文字", vision: true });
  await wait(60);
  let body = env.doc.querySelector(".zhenyi-explain-body");
  assert.ok(body, "应创建解读面板");
  assert.match(body.innerHTML, /<strong>重点<\/strong>/);
  assert.match(body.innerHTML, /<ul><li>甲<\/li><li>乙<\/li><\/ul>/);
  assert.match(body.textContent, /已结合屏幕截图/);

  /* 3. 流式增量会累积；多个 delta 经 rAF 合并后仍完整 */
  env.send({ type: "EXPLAIN_STREAM_START" });
  for (const d of ["你", "好", "世界"]) env.send({ type: "EXPLAIN_STREAM", delta: d });
  await wait(60);
  body = env.doc.querySelector(".zhenyi-explain-body");
  assert.match(body.textContent, /你好世界/);

  /* 4. GET_PAGE_TEXT 只取可见正文，排除 script/style 与隐藏元素 */
  env.doc.body.innerHTML =
    '<script>var secret = 1<\/script><style>.a{}</style>' +
    '<p>正文内容</p><div style="display:none">隐藏内容</div>';
  const pageText = env.send({ type: "GET_PAGE_TEXT" }).text;
  assert.match(pageText, /正文内容/);
  assert.doesNotMatch(pageText, /var secret/);
  assert.doesNotMatch(pageText, /隐藏内容/);

  /* 5. 划词翻译缓存：相同文本只请求一次后台 */
  env = boot({ selMode: "direct", selTargetLang: "zh-CN" });
  const p = env.doc.createElement("p");
  env.doc.body.appendChild(p);
  const selectAndMouseUp = selectionSender(env, p);
  selectAndMouseUp("hello world");
  await wait(20);
  selectAndMouseUp("other text");
  await wait(20);
  selectAndMouseUp("hello world");
  await wait(20);
  const t = env.asks("TRANSLATE");
  assert.equal(t.length, 2, "相同文本应命中缓存，只产生两次后台请求");
  assert.equal(t[0].text, "hello world");
  assert.equal(t[0].target, "zh-CN");

  /* 6. 翻译缓存有上限：超出后淘汰最早条目 */
  env = boot({ selMode: "direct" });
  const p2 = env.doc.createElement("p");
  env.doc.body.appendChild(p2);
  const select2 = selectionSender(env, p2);
  for (let i = 0; i < 305; i++) select2("t" + i);
  await wait(30);
  const before = env.asks("TRANSLATE").length;
  select2("t0");
  await wait(20);
  assert.equal(before, 305);
  assert.equal(env.asks("TRANSLATE").length, 306, "t0 应已被淘汰，需要重新请求");

  /* 7. 代际守卫：扩展重载重新注入后，旧监听器立即让位，不再重复建面板 */
  env = boot();
  const oldListener = env.latest();
  env.window.eval(CONTENT);
  const newListener = env.latest();
  assert.notEqual(oldListener, newListener);
  let oldResp;
  oldListener({ type: "EXPLAIN_STREAM_START" }, {}, (r) => { oldResp = r; });
  assert.equal(oldResp, undefined, "旧代际监听器不应响应");
  assert.equal(env.doc.querySelectorAll(".zhenyi-explain").length, 0);
  newListener({ type: "EXPLAIN_STREAM_START" }, {}, () => {});
  assert.equal(env.doc.querySelectorAll(".zhenyi-explain").length, 1);

  /* 8. CSP script-src-attr 'none'：确认本页拦截内联事件后，操作元素时临时摘除 on*，
   *    触发期间属性不存在（不再触发 CSP 报错），触发后恢复原样。 */
  env = boot();
  const doc8 = env.doc;
  env.window.Element.prototype.getBoundingClientRect = function () {
    return { width: 120, height: 24, top: 60, left: 60, right: 180, bottom: 84, x: 60, y: 60 };
  };
  env.window.Element.prototype.checkVisibility = function () { return true; };   // jsdom 无布局
  env.window.Element.prototype.scrollIntoView = function () {};                   // jsdom 未实现

  const target = doc8.createElement("button");
  target.textContent = "Go";
  target.setAttribute("onclick", "this.setAttribute('data-inline','ran')");
  let attrPresentDuringClick = null;
  let listenerRan = false;
  target.addEventListener("click", () => {
    listenerRan = true;
    attrPresentDuringClick = target.hasAttribute("onclick");
  });
  doc8.body.appendChild(target);

  // 模拟浏览器发出的 CSP 违规事件，让 content.js 记住“本页拦截内联属性”
  const cspEvent = new env.window.Event("securitypolicyviolation");
  Object.defineProperty(cspEvent, "effectiveDirective", { value: "script-src-attr" });
  Object.defineProperty(cspEvent, "violatedDirective", { value: "script-src-attr" });
  doc8.dispatchEvent(cspEvent);

  // 面板进入「操作」模式，发出一次点击指令，随后 done 收尾
  env.send({ type: "EXPLAIN_RESULT", text: "解读", context: "ctx" });
  await wait(60);
  const panel8 = doc8.querySelector(".zhenyi-explain");
  env.userEvent(panel8.querySelector(".zhenyi-explain-agent"), "click");
  panel8.querySelector(".zhenyi-explain-input").value = "点一下按钮";
  let agentCalls = 0;
  env.setChatReply(() => {
    agentCalls += 1;
    return {
      ok: true,
      answer: agentCalls === 1
        ? '{"thought":"点它","action":"click","ref":"e1"}'
        : '{"action":"done","answer":"完成"}',
    };
  });
  env.userEvent(panel8.querySelector(".zhenyi-explain-send"), "click");
  await wait(1500);

  assert.equal(agentCalls, 2, "应由执行一步后 done 收尾");
  assert.equal(listenerRan, true, "addEventListener 绑定的点击处理器仍应执行");
  assert.equal(attrPresentDuringClick, false, "点击期间内联 on* 属性应被临时摘除");
  assert.equal(target.getAttribute("onclick"), "this.setAttribute('data-inline','ran')", "点击后应恢复内联属性");

  /* 9. 延迟翻译：用户编辑、并发请求、超长输入均不能丢失原文。 */
  env = boot();
  const edit = env.doc.createElement("textarea");
  env.doc.body.append(edit);
  edit.focus();
  const pending = [];
  const translateMsgs = [];
  const sendMessage = env.window.chrome.runtime.sendMessage;
  env.window.chrome.runtime.sendMessage = (msg, cb) => {
    if (msg.type === "TRANSLATE") { translateMsgs.push(msg); pending.push(cb); }
    else sendMessage(msg, cb);
  };
  const translateButton = env.doc.querySelector(".zhenyi-input-btn");
  edit.value = "原文";
  env.userEvent(translateButton, "click");
  assert.equal(translateMsgs[0].scene, "chat", "聊天式输入框按聊天场景处理，且只发白名单枚举");
  edit.value = "用户新写的内容";
  pending.shift()({ ok: true, out: "old translation" });
  await wait(0);
  assert.equal(edit.value, "用户新写的内容");
  edit.value = "再次翻译";
  env.userEvent(translateButton, "click");
  env.userEvent(translateButton, "click");
  pending.shift()({ ok: true, out: "stale translation" });
  await wait(0);
  assert.equal(edit.value, "再次翻译", "新请求开始后旧请求不能写回");
  pending.shift()({ ok: true, out: "latest translation" });
  await wait(0);
  assert.equal(edit.value, "再次翻译", "生成译文只预览，不直接替换");
  let preview = env.doc.querySelector(".zhenyi-workbench");
  assert.equal(preview.querySelector('[data-field="result"]').value, "latest translation");
  preview.querySelector('[data-act="apply"]').click();
  assert.equal(edit.value, "再次翻译", "伪造确认点击不能覆盖原文");
  env.userEvent(preview.querySelector('[data-act="apply"]'), "click");
  assert.equal(edit.value, "latest translation");
  env.userEvent(preview.querySelector('[data-act="undo"]'), "click");
  assert.equal(edit.value, "再次翻译", "可一键还原原文");
  edit.value = "用户继续编辑";
  env.userEvent(preview.querySelector('[data-act="apply"]'), "click");
  assert.equal(edit.value, "用户继续编辑", "预览打开后原文变化也不能覆盖");
  env.userEvent(preview.querySelector('[data-act="close"]'), "click");
  assert.equal(env.doc.activeElement, edit, "关闭预览后应恢复网页输入框焦点");
  edit.value = "内容";
  env.userEvent(translateButton, "click");
  edit.dispatchEvent(new env.window.Event("input", { bubbles: true }));
  pending.shift()({ ok: true, out: "should not overwrite" });
  await wait(0);
  assert.equal(edit.value, "内容", "编辑后即使文字相同也不覆盖");
  edit.value = "中".repeat(5001);
  env.userEvent(translateButton, "click");
  await wait(0);
  assert.equal(pending.length, 0, "超长输入不应发给后台或回退 Google");
  assert.equal(edit.value.length, 5001);
  assert.match(translateButton.title, /5000/);
  env.window.close();

  /* 写作面板：上下文回复、差异提示、AI 查漏、通用要点提取及错误态。 */
  env = boot();
  let taskResponse = { ok: true, result: { text: "$12 monthly" } };
  env.setWritingReply(() => taskResponse);
  env.send({ type: "OPEN_WORKBENCH", mode: "reply", selectionText: "Offer: $12 yearly" });
  const work = env.doc.querySelector(".zhenyi-workbench");
  const field = name => work.querySelector('[data-field="' + name + '"]');
  const act = name => work.querySelector('[data-act="' + name + '"]');
  field("source").value = "每年 $12";
  field("tone").value = "firm";
  act("generate").click();
  assert.equal(env.asks("DRAFT_REPLY").length, 0, "伪造生成点击被拦截");
  env.userEvent(act("generate"), "click");
  await wait(0);
  assert.equal(env.asks("DRAFT_REPLY")[0].context, "Offer: $12 yearly");
  assert.equal(env.asks("DRAFT_REPLY")[0].tone, "firm");
  assert.equal(field("result").value, "$12 monthly");
  assert.match(work.querySelector('[data-part="checks"]').textContent, /年付/);
  assert.match(work.querySelector('[data-part="checks"]').textContent, /月付/);
  assert.equal(act("apply").disabled, true, "未绑定网页输入框时只能复制");
  taskResponse = { ok: true, result: { issues: [{ source: "每年", translation: "monthly", reason: "计费周期错误" }] } };
  env.userEvent(act("check"), "click");
  await wait(0);
  assert.match(work.querySelector('[data-part="checks"]').textContent, /计费周期错误/);
  field("result").value = "$12 yearly";
  env.userEvent(field("result"), "input");
  assert.doesNotMatch(work.querySelector('[data-part="checks"]').textContent, /计费周期错误/);
  field("mode").value = "offer";
  env.userEvent(field("mode"), "change");
  assert.equal(work.querySelector('[data-part="focus"]').hidden, false, "提取模式的关注点输入框应可见");
  assert.match(work.querySelector('[data-part="scene"]').textContent, /通用网页/);
  field("focus").value = "价格、退款政策";
  env.userEvent(field("focus"), "input");
  taskResponse = { ok: true, result: { fields: [
    { label: "价格", value: "每年 12 美元", quote: "$12 yearly" },
    { label: "退款政策", value: "未说明", quote: "" },
  ] } };
  env.userEvent(act("generate"), "click");
  await wait(0);
  assert.match(work.querySelector("table").textContent, /原文：\$12 yearly/);
  assert.match(work.querySelector("table").textContent, /退款政策未说明/);
  assert.equal(env.asks("EXTRACT_OFFER").at(-1).focus, "价格、退款政策");
  assert.equal(env.asks("EXTRACT_OFFER").at(-1).scene, "generic");
  assert.equal(act("copy").disabled, false);
  field("source").value = "另一篇帖子";
  env.userEvent(field("source"), "input");
  assert.equal(act("copy").disabled, true, "修改原文后不能复制过期提取结果");
  assert.equal(work.querySelector("table"), null);
  taskResponse = { ok: false, error: "请先配置 AI Key" };
  env.userEvent(act("generate"), "click");
  await wait(0);
  assert.match(work.querySelector('[role="status"]').textContent, /配置 AI Key/);
  assert.equal(act("generate").disabled, false, "失败后可重试");
  env.window.close();

  /* 10. 场景推断：只认标准元数据与页面结构，跨进程只发白名单枚举。 */
  for (const [meta, scene, label] of [
    ['<meta property="og:type" content="product">', "product", /商品/],
    ['<script type="application/ld+json">{"@type":"JobPosting","title":"Dev"}</script>', "job", /招聘/],
    ['<meta property="og:type" content="article">', "article", /文章/],
  ]) {
    env = boot();
    env.doc.head.innerHTML = meta;
    env.setWritingReply(() => ({ ok: true, result: { text: "ok" } }));
    env.send({ type: "OPEN_WORKBENCH", mode: "reply", selectionText: "hello" });
    const sceneWork = env.doc.querySelector(".zhenyi-workbench");
    assert.match(sceneWork.querySelector('[data-part="scene"]').textContent, label);
    sceneWork.querySelector('[data-field="source"]').value = "你好";
    env.userEvent(sceneWork.querySelector('[data-act="generate"]'), "click");
    await wait(0);
    assert.equal(env.asks("DRAFT_REPLY").at(-1).scene, scene);
    env.window.close();
  }

  /* 11. 页面伪造的鼠标/键盘事件不能翻译、发送 AI 请求或开启操作模式。 */
  env = boot({ selMode: "direct" });
  env.doc.body.innerHTML = '<textarea>中文</textarea><p>hello world</p>';
  const unsafeInput = env.doc.querySelector("textarea");
  unsafeInput.focus();
  env.doc.querySelector(".zhenyi-input-btn").click();
  unsafeInput.dispatchEvent(new env.window.KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
  const range = env.doc.createRange();
  range.selectNodeContents(env.doc.querySelector("p"));
  env.window.getSelection().addRange(range);
  env.doc.querySelector("p").dispatchEvent(new env.window.MouseEvent("mouseup", { bubbles: true }));
  env.doc.querySelector(".zhenyi-sel-icon").click();
  env.send({ type: "OPEN_AI_CHAT" });
  const safePanel = env.doc.querySelector(".zhenyi-explain");
  const question = safePanel.querySelector(".zhenyi-explain-input");
  question.value = "forged prompt";
  safePanel.querySelector(".zhenyi-explain-agent").click();
  assert.equal(safePanel.querySelector(".zhenyi-explain-agent").classList.contains("on"), false);
  safePanel.querySelector(".zhenyi-explain-send").click();
  question.dispatchEvent(new env.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  assert.equal(env.asks("TRANSLATE").length, 0);
  assert.equal(env.asks("EXPLAIN_CHAT").length, 0);
  env.userEvent(safePanel.querySelector(".zhenyi-explain-send"), "click");
  assert.equal(env.asks("EXPLAIN_CHAT").length, 1, "可信点击仍可正常追问");
  env.window.close();

  /* 12. 密码、验证码、银行卡字段不进入 AI 请求或保存的快照。 */
  env = boot();
  env.window.Element.prototype.getBoundingClientRect = () => ({ width: 120, height: 24, top: 60, left: 60, right: 180, bottom: 84 });
  env.window.Element.prototype.checkVisibility = () => true;
  env.doc.body.innerHTML = '<input type="password" value="FAKE_PASSWORD"><input autocomplete="one-time-code" value="FAKE_OTP"><input autocomplete="section-pay cc-number" value="FAKE_CARD"><input name="verificationCode" value="FAKE_CODE"><input value="safe value">';
  env.send({ type: "OPEN_AI_CHAT" });
  const privatePanel = env.doc.querySelector(".zhenyi-explain");
  env.userEvent(privatePanel.querySelector(".zhenyi-explain-agent"), "click");
  privatePanel.querySelector(".zhenyi-explain-input").value = "读一下页面";
  env.userEvent(privatePanel.querySelector(".zhenyi-explain-send"), "click");
  await wait(30);
  for (const type of ["EXPLAIN_CHAT", "AGENT_STATE_SET"]) {
    assert.ok(env.asks(type).length);
    const payload = JSON.stringify(env.asks(type));
    assert.doesNotMatch(payload, /FAKE_PASSWORD|FAKE_OTP|FAKE_CARD|FAKE_CODE/);
    assert.match(payload, /safe value/);
  }
  env.window.close();

  /* 13. 划词方式立即保存，重新打开弹窗仍使用保存值。 */
  const popupStore = {};
  const popupMsgs = [];
  const openPopup = async () => {
    const dom = new JSDOM(fs.readFileSync(path.join(__dirname, "popup.html"), "utf8"), { runScripts: "outside-only" });
    dom.window.chrome = {
      storage: { sync: {
        get: (defaults, cb) => setTimeout(() => cb({ ...defaults, ...popupStore }), 0),
        set: (patch) => Object.assign(popupStore, patch),
      }, local: { get: (_defaults, cb) => cb({ glossary: "" }) } },
      tabs: { query: (_q, cb) => cb([]) },
      runtime: {
        lastError: null,
        getManifest: () => ({ version: "2.2.0" }),
        sendMessage: (msg, cb) => {
          popupMsgs.push(msg);
          setTimeout(() => cb && cb({ ok: true, result: {
            status: "ok", current: "2.2.0", latest: "2.2.0", updateAvailable: false,
            lastCheck: Date.now(),
            downloadUrl: "https://example.test/update.zip",
            commitsUrl: "https://example.test/commits",
          } }), 0);
        },
      },
    };
    dom.window.eval(fs.readFileSync(path.join(__dirname, "popup.js"), "utf8"));
    await wait(10);
    return dom;
  };
  let popup = await openPopup();
  const mode = popup.window.document.getElementById("selMode");
  for (const value of ["direct", "off"]) {
    mode.value = value;
    mode.dispatchEvent(new popup.window.Event("change"));
    assert.equal(popupStore.selMode, value);
  }
  popup.window.close();
  popup = await openPopup();
  assert.equal(popup.window.document.getElementById("selMode").value, "off");
  popup.window.close();

  /* 13b. 在线更新：打开弹窗自动节流检查，手动按钮强制检查；关掉自动检查后不再发。 */
  const autoBefore = popupMsgs.length;
  let updPopup = await openPopup();
  assert.ok(popupMsgs.slice(autoBefore).some(m => m.type === "CHECK_UPDATE" && m.force === false), "打开弹窗应自动做一次节流检查");
  assert.equal(updPopup.window.document.getElementById("versionBadge").textContent, "v2.2.0");
  updPopup.window.document.getElementById("checkUpdateBtn").click();
  await wait(20);
  assert.ok(popupMsgs.slice(autoBefore).some(m => m.type === "CHECK_UPDATE" && m.force === true), "手动点击应强制检查");
  assert.match(updPopup.window.document.getElementById("updateStatus").textContent, /已是最新版本/);
  updPopup.window.close();

  const autoSwitch = updPopup.window.document.getElementById("checkUpdates");
  autoSwitch.checked = false;
  autoSwitch.dispatchEvent(new updPopup.window.Event("change"));
  assert.equal(popupStore.checkUpdates, false);
  const offBefore = popupMsgs.length;
  const offPopup = await openPopup();
  assert.equal(popupMsgs.slice(offBefore).filter(m => m && m.type === "CHECK_UPDATE").length, 0, "关闭自动检查后打开弹窗不得再查");
  assert.match(offPopup.window.document.getElementById("updateStatus").textContent, /自动检查已关闭/);
  offPopup.window.close();
  delete popupStore.checkUpdates; /* 不影响后续用例的弹窗状态 */

  /* 整页翻译测试用的小工具：控制片、状态文案，以及不含文字的结构签名。 */
  const pagebarOf = (e) => e.doc.documentElement.querySelector(".zhenyi-pagebar");
  const pageStatusOf = (e) => pagebarOf(e)?.querySelector(".zhenyi-pagebar-status").textContent;
  const structureSignature = (root) => {
    const lines = [];
    const walk = (el, depth) => {
      const attrs = [...el.attributes].map((a) => a.name + "=" + a.value).sort().join(",");
      lines.push(depth + "|" + el.tagName + "|" + attrs);
      for (const child of el.children) walk(child, depth + 1);
    };
    walk(root, 0);
    return lines.join("\n");
  };

  /* 14. 整页翻译跳过规则：代码、no-translate、表单控件、已是中文的段落都不进请求，
   *     只把英文正文的原文本节点原位换成译文。 */
  env = boot();
  env.doc.body.innerHTML =
    '<p id="en">Hello world, please translate this sentence.</p>' +
    '<pre><code>const secret = "code text here";</code></pre>' +
    '<p id="attr" translate="no">Never translate this attribute text.</p>' +
    '<p id="cls" class="notranslate">Never translate this class text.</p>' +
    '<button>Ignore button label</button>' +
    '<input value="ignore input value">' +
    '<p id="zh">这是一段不需要翻译的中文。</p>';
  const skipTextBefore = {
    code: env.doc.querySelector("code").firstChild.nodeValue,
    attr: env.doc.getElementById("attr").firstChild.nodeValue,
    cls: env.doc.getElementById("cls").firstChild.nodeValue,
    button: env.doc.querySelector("button").firstChild.nodeValue,
    zh: env.doc.getElementById("zh").firstChild.nodeValue,
  };
  env.send({ type: "TRANSLATE_PAGE", target: "zh-CN" });
  await wait(40);
  assert.equal(env.doc.getElementById("en").firstChild.nodeValue, "T:Hello world, please translate this sentence.", "英文段落应在自己的文本节点里写入译文");
  assert.equal(env.doc.querySelector("code").firstChild.nodeValue, skipTextBefore.code, "pre/code 原文不变");
  assert.equal(env.doc.getElementById("attr").firstChild.nodeValue, skipTextBefore.attr, "translate=no 原文不变");
  assert.equal(env.doc.getElementById("cls").firstChild.nodeValue, skipTextBefore.cls, "notranslate 原文不变");
  assert.equal(env.doc.querySelector("button").firstChild.nodeValue, skipTextBefore.button, "按钮文案不变");
  assert.equal(env.doc.getElementById("zh").firstChild.nodeValue, skipTextBefore.zh, "已是中文的段落不变");
  assert.equal(env.doc.querySelector("input").getAttribute("value"), "ignore input value");
  const skipPayload = JSON.stringify(env.asks("TRANSLATE_BLOCKS"));
  assert.doesNotMatch(skipPayload, /code text here|Never translate|Ignore button|ignore input|不需要翻译/);
  assert.match(skipPayload, /please translate this sentence/);
  assert.equal(env.asks("TRANSLATE").length, 0, "跳过的内容也不应走单条接口");
  env.window.close();

  /* 15. 原位替换零结构改动：元素、属性与嵌套完全不变，html 不加 class，
   *     正文里不出现扩展节点，控制片只挂在 documentElement 上。 */
  env = boot();
  env.doc.body.innerHTML = '<div id="wrap"><p>Hello <b>bold</b> text.</p><form action="/x"><input type="text" value="x"></form></div>';
  const bodySigBefore = structureSignature(env.doc.body);
  const htmlClassBefore = env.doc.documentElement.getAttribute("class");
  assert.equal(htmlClassBefore, null);
  env.send({ type: "TRANSLATE_PAGE", target: "zh-CN" });
  await wait(40);
  assert.equal(env.doc.querySelector("p").textContent, "T:Hello T:bold T:text.", "文本节点应各自原位替换");
  assert.equal(structureSignature(env.doc.body), bodySigBefore, "元素/属性/嵌套不得变化");
  assert.equal(env.doc.documentElement.getAttribute("class"), htmlClassBefore, "不得给 html 加 class");
  assert.equal(env.doc.body.querySelector("[data-zhenyi-src]"), null, "正文里不得出现扩展标记");
  assert.equal(env.doc.body.querySelector(".zhenyi-page-trans"), null, "正文里不得出现译文容器");
  const structureChip = pagebarOf(env);
  assert.ok(structureChip, "控制片应存在");
  assert.equal(structureChip.parentNode, env.doc.documentElement, "控制片应挂在 documentElement 上");
  assert.equal(env.doc.body.querySelector(".zhenyi-pagebar"), null, "控制片不得插进 body");
  env.window.close();

  /* 16. 分批协议：短段合并成一批、id 从 1 递增、每批 ≤12 段且 ≤1500 字符；
   *     批量失败或缺项改走单条 strict 重试。 */
  env = boot();
  env.doc.body.innerHTML = "<p>Alpha block one.</p><p>Beta block two.</p><p>Gamma block three.</p>";
  env.send({ type: "TRANSLATE_PAGE", target: "zh-CN" });
  await wait(40);
  const batches = env.asks("TRANSLATE_BLOCKS");
  assert.equal(batches.length, 1, "三段短文本应合并成一批");
  assert.deepEqual(Array.from(batches[0].items, (item) => item.id), [1, 2, 3], "同一批内 id 从 1 递增");
  assert.equal(batches[0].target, "zh-CN");
  assert.ok(batches[0].items.reduce((n, item) => n + item.text.length, 0) <= 1500, "一批不超过 1500 字符");
  assert.deepEqual([...env.doc.querySelectorAll("p")].map((p) => p.firstChild.nodeValue), ["T:Alpha block one.", "T:Beta block two.", "T:Gamma block three."]);
  env.window.close();

  env = boot();
  env.doc.body.innerHTML = Array.from({ length: 15 }, (_, i) => "<p>Paragraph number " + (i + 1) + " body.</p>").join("");
  env.send({ type: "TRANSLATE_PAGE", target: "zh-CN" });
  await wait(40);
  const cappedBatches = env.asks("TRANSLATE_BLOCKS");
  assert.ok(cappedBatches.length >= 2, "15 段应拆成多批");
  for (const req of cappedBatches) assert.ok(req.items.length <= 12, "每批最多 12 段");
  assert.deepEqual(Array.from(cappedBatches.flatMap((req) => Array.from(req.items, (item) => item.id))), Array.from({ length: 15 }, (_, i) => i + 1), "全页 id 连续递增");
  env.window.close();

  env = boot();   // 批量失败 → 单条 strict 重试
  env.doc.body.innerHTML = "<p>Retry this paragraph please.</p>";
  let failFirstBatch = true;
  const retrySend = env.window.chrome.runtime.sendMessage;
  env.window.chrome.runtime.sendMessage = (msg, cb) => {
    if (msg.type === "TRANSLATE_BLOCKS" && failFirstBatch) { failFirstBatch = false; cb({ ok: false, error: "batch boom" }); return; }
    retrySend(msg, cb);
  };
  env.send({ type: "TRANSLATE_PAGE", target: "zh-CN" });
  await wait(40);
  const retrySingles = env.asks("TRANSLATE");
  assert.equal(retrySingles.length, 1, "批量失败应改走单条重试");
  assert.equal(retrySingles[0].strict, true);
  assert.equal(retrySingles[0].text, "Retry this paragraph please.");
  assert.equal(env.doc.querySelector("p").firstChild.nodeValue, "EN:Retry this paragraph please.", "单条结果应回填");
  env.window.close();

  env = boot();   // 批量缺项 → 只对缺失的段单条 strict 重试
  env.doc.body.innerHTML = "<p>Keep me translated.</p><p>Drop me from the batch.</p>";
  const partialSend = env.window.chrome.runtime.sendMessage;
  env.window.chrome.runtime.sendMessage = (msg, cb) => {
    if (msg.type === "TRANSLATE_BLOCKS") { cb({ ok: true, items: msg.items.slice(0, 1).map((item) => ({ id: item.id, text: "T:" + item.text })) }); return; }
    partialSend(msg, cb);
  };
  env.send({ type: "TRANSLATE_PAGE", target: "zh-CN" });
  await wait(40);
  assert.equal(env.asks("TRANSLATE").length, 1, "只重试缺失的那段");
  assert.equal(env.asks("TRANSLATE")[0].text, "Drop me from the batch.");
  assert.equal(env.asks("TRANSLATE")[0].strict, true);
  assert.deepEqual([...env.doc.querySelectorAll("p")].map((p) => p.firstChild.nodeValue), ["T:Keep me translated.", "EN:Drop me from the batch."]);
  env.window.close();

  /* 17. 跨行内元素翻译：每个文本节点按「前导空白 + 译文 + 尾随空白」写回，
   *     段间空白不丢、链接元素与位置不变。 */
  env = boot();
  env.doc.body.innerHTML = '<p id="x">Wait <a href="#t">TOKEN</a> now.</p>';
  const anchorBefore = env.doc.querySelector("#x a");
  env.send({ type: "TRANSLATE_PAGE", target: "zh-CN" });
  await wait(40);
  const inlineP = env.doc.getElementById("x");
  assert.deepEqual(Array.from(env.asks("TRANSLATE_BLOCKS")[0].items, (item) => item.text), ["Wait", "TOKEN", "now."], "行内文本按节点分别成单元");
  assert.equal(inlineP.childNodes.length, 3, "不得新增或合并节点");
  assert.equal(inlineP.childNodes[0].nodeValue, "T:Wait ", "前导空白应保留在译文前");
  assert.equal(inlineP.childNodes[2].nodeValue, " T:now.", "尾随空白应保留在译文后");
  assert.equal(inlineP.textContent, "T:Wait T:TOKEN T:now.", "拼接后段间空白仍在，不得粘成一坨");
  assert.match(inlineP.textContent, /T:Wait\s+T:TOKEN\s+T:now\./);
  assert.equal(inlineP.querySelector("a"), anchorBefore, "链接元素本身不变");
  assert.equal(inlineP.childNodes[1], anchorBefore, "链接位置不变");
  assert.equal(anchorBefore.getAttribute("href"), "#t");
  assert.equal(anchorBefore.textContent, "T:TOKEN");
  env.window.close();

  /* 18. 控制片：默认收起、展开切换 class/aria、计数与状态文案；
   *     停止后按钮变「继续」且不再发请求，继续后待翻内容照常完成。 */
  env = boot();
  env.doc.body.innerHTML = "<p>Translate this paragraph for the chip.</p>";
  env.send({ type: "TRANSLATE_PAGE", target: "zh-CN" });
  const chip = pagebarOf(env);
  assert.ok(chip, "控制片应挂在 html 上");
  assert.equal(chip.parentNode, env.doc.documentElement);
  assert.equal(env.doc.body.querySelector(".zhenyi-pagebar"), null, "控制片不得插进 body");
  assert.ok(chip.classList.contains("zhenyi-collapsed"), "默认应收起");
  assert.ok(chip.querySelector(".zhenyi-pagebar-panel"), "应包含面板");
  assert.equal(chip.querySelector(".zhenyi-pagebar-status").getAttribute("role"), "status");
  assert.equal(chip.querySelector('select[data-page="target"]').value, "zh-CN");
  assert.equal(chip.querySelector('button[data-page="stop"]').textContent, "停止");
  assert.ok(chip.querySelector('button[data-page="restore"]'));
  const pageToggle = chip.querySelector('[data-page="toggle"]');
  const pageCount = chip.querySelector('[data-page="count"]');
  assert.equal(pageToggle.getAttribute("aria-expanded"), "false");
  assert.equal(pageStatusOf(env), "正在翻译 0/1 处 · 1 次请求");
  env.userEvent(pageToggle, "click");
  assert.equal(chip.classList.contains("zhenyi-collapsed"), false, "展开后应移除收起状态");
  assert.equal(pageToggle.getAttribute("aria-expanded"), "true");
  env.userEvent(pageToggle, "click");
  assert.ok(chip.classList.contains("zhenyi-collapsed"), "再次点击应收起");
  assert.equal(pageToggle.getAttribute("aria-expanded"), "false");
  await wait(40);
  assert.equal(pageCount.textContent, "1/1", "计数应显示 已完成/总数");
  assert.equal(pageStatusOf(env), "完成 · 1 处 · 1 次请求");
  env.window.close();

  env = boot();   // 没有可翻正文
  env.doc.body.innerHTML = "<p>这是一段中文。</p>";
  env.send({ type: "TRANSLATE_PAGE", target: "zh-CN" });
  await wait(40);
  assert.equal(pageStatusOf(env), "没有找到需要翻译的正文");
  assert.equal(pagebarOf(env).querySelector('[data-page="count"]').textContent, "");
  env.window.close();

  env = boot();   // 用可见性门控制造真实的待翻队列，验证停止/继续
  env.doc.body.innerHTML = '<p id="s1">First visible block.</p><p id="s2">Second pending block.</p>';
  let stopIoFire = null;
  env.window.IntersectionObserver = class {
    constructor(callback) { stopIoFire = callback; }
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  env.send({ type: "TRANSLATE_PAGE", target: "zh-CN" });
  await wait(20);
  stopIoFire([{ isIntersecting: true, target: env.doc.getElementById("s1") }]);
  await wait(200);
  const stopBtn = pagebarOf(env).querySelector('[data-page="stop"]');
  assert.equal(env.asks("TRANSLATE_BLOCKS").length, 1);
  env.userEvent(stopBtn, "click");
  assert.equal(pageStatusOf(env), "已停止 · 已翻 1/2 处");
  assert.equal(stopBtn.textContent, "继续");
  assert.equal(env.asks("TRANSLATE_BLOCKS").length, 1, "停止后不得再发请求");
  env.userEvent(stopBtn, "click");
  assert.equal(stopBtn.textContent, "停止");
  assert.doesNotMatch(pageStatusOf(env), /已停止/);
  stopIoFire([{ isIntersecting: true, target: env.doc.getElementById("s2") }]);
  await wait(200);
  assert.equal(env.doc.getElementById("s2").firstChild.nodeValue, "T:Second pending block.", "继续后待翻内容应完成");
  assert.equal(pageStatusOf(env), "完成 · 2 处 · 2 次请求");
  env.window.close();

  /* 19. 还原保真：body 逐字节回到翻译前、控制片移除且能再次整页翻译；
   *     网站自己改过的文本在还原时不被覆盖。 */
  env = boot();
  env.doc.body.innerHTML = "<p>Restore byte for byte.</p><p>Second block stays too.</p>";
  const htmlBeforePage = env.doc.body.innerHTML;
  env.send({ type: "TRANSLATE_PAGE", target: "zh-CN" });
  await wait(40);
  assert.deepEqual([...env.doc.querySelectorAll("p")].map((p) => p.firstChild.nodeValue), ["T:Restore byte for byte.", "T:Second block stays too."]);
  env.userEvent(pagebarOf(env).querySelector('[data-page="restore"]'), "click");
  assert.equal(env.doc.body.innerHTML, htmlBeforePage, "还原后 body 必须与翻译前逐字节一致");
  assert.equal(pagebarOf(env), null, "控制片应被移除");
  env.send({ type: "TRANSLATE_PAGE", target: "zh-CN" });
  await wait(40);
  assert.equal(env.doc.querySelector("p").firstChild.nodeValue, "T:Restore byte for byte.", "还原后应能重新开始整页翻译");
  assert.equal(env.doc.documentElement.querySelectorAll(".zhenyi-pagebar").length, 1, "重新开始只应有一个控制片");
  env.window.close();

  env = boot();
  env.doc.body.innerHTML = "<p>Restore byte for byte.</p><p>Second block stays too.</p>";
  const pageOriginals = [...env.doc.querySelectorAll("p")].map((p) => p.firstChild.nodeValue);
  env.send({ type: "TRANSLATE_PAGE", target: "zh-CN" });
  await wait(40);
  const siteEditedP = env.doc.querySelectorAll("p")[0];
  siteEditedP.firstChild.nodeValue = "SITE EDIT";
  env.userEvent(pagebarOf(env).querySelector('[data-page="restore"]'), "click");
  assert.equal(siteEditedP.firstChild.nodeValue, "SITE EDIT", "网站改过的文本还原时不能覆盖");
  assert.equal(env.doc.querySelectorAll("p")[1].firstChild.nodeValue, pageOriginals[1], "其余节点应回到原文");
  env.window.close();

  /* 20. 可见优先：只翻 IntersectionObserver 报告进入视口的块，其余保持原文等自己的相交通知。 */
  env = boot();
  env.doc.body.innerHTML = '<p id="v1">First visible block.</p><p id="v2">Second pending block.</p>';
  const observedTargets = [];
  let ioFire = null;
  env.window.IntersectionObserver = class {
    constructor(callback) { ioFire = callback; }
    observe(el) { observedTargets.push(el); }
    unobserve() {}
    disconnect() {}
  };
  env.send({ type: "TRANSLATE_PAGE", target: "zh-CN" });
  await wait(20);
  assert.equal(observedTargets.length, 2, "两个块都应被观察");
  assert.equal(env.asks("TRANSLATE_BLOCKS").length, 0, "未报告相交前不得发请求");
  assert.equal(env.doc.getElementById("v1").firstChild.nodeValue, "First visible block.");
  assert.equal(env.doc.getElementById("v2").firstChild.nodeValue, "Second pending block.");
  ioFire([{ isIntersecting: true, target: env.doc.getElementById("v1") }]);
  await wait(200);   // 合批防抖：相交回调后稍等再发请求
  const visibleReqs = env.asks("TRANSLATE_BLOCKS");
  assert.equal(visibleReqs.length, 1);
  assert.deepEqual(Array.from(visibleReqs[0].items, (item) => item.text), ["First visible block."], "只请求相交的那个块");
  assert.equal(env.doc.getElementById("v1").firstChild.nodeValue, "T:First visible block.");
  assert.equal(env.doc.getElementById("v2").firstChild.nodeValue, "Second pending block.", "未相交的块保持原文");
  ioFire([{ isIntersecting: true, target: env.doc.getElementById("v2") }]);
  await wait(200);
  assert.equal(env.doc.getElementById("v2").firstChild.nodeValue, "T:Second pending block.", "补相交后应补翻");
  assert.equal(env.asks("TRANSLATE_BLOCKS").length, 2);
  assert.equal(pageStatusOf(env), "完成 · 2 处 · 2 次请求");
  env.window.close();

  /* 21. 超长文本节点按 ~3000 字符切片请求，全部回来后仍写回同一个文本节点（不新增节点）；
   *     动态追加的内容在 MutationObserver 防抖后也会被翻译。 */
  env = boot();
  const longText = "Renewal price support policy details are listed in this section. ".repeat(120);
  assert.ok(longText.length > 3000, "构造的段落应超过单片上限");
  env.doc.body.innerHTML = '<p id="long"></p>';
  const longP = env.doc.getElementById("long");
  longP.textContent = longText;
  const childCountBefore = longP.childNodes.length;
  env.send({ type: "TRANSLATE_PAGE", target: "zh-CN" });
  await wait(200);
  const longRequests = env.asks("TRANSLATE_BLOCKS");
  assert.ok(longRequests.length >= 2, "超长节点应拆成多次请求");
  for (const req of longRequests) {
    for (const item of req.items) assert.ok(item.text.length <= 3000, "单片不超过 3000 字符");
    assert.ok(req.items.reduce((n, item) => n + item.text.length, 0) <= 3000, "每批总量不超过约 3000 字符");
  }
  assert.equal(longP.childNodes.length, childCountBefore, "回填不得新增节点");
  assert.equal(longP.childNodes.length, 1, "整段仍是单个文本节点");
  const longNode = longP.firstChild;
  assert.equal(longNode.nodeType, 3, "回填后仍是文本节点");
  const longValue = longNode.nodeValue;
  assert.ok((longValue.match(/T:/g) || []).length >= 2, "多片译文都写进了同一个节点");
  assert.equal(longValue.replace(/T:/g, "").replace(/\s+/g, " ").trim(), longText.replace(/\s+/g, " ").trim(), "拼回的内容应覆盖整段原文");
  env.window.close();

  env = boot();
  env.doc.body.innerHTML = "<p>Seed paragraph.</p>";
  env.send({ type: "TRANSLATE_PAGE", target: "zh-CN" });
  await wait(40);
  const dynamicBefore = env.asks("TRANSLATE_BLOCKS").length;
  const liveP = env.doc.createElement("p");
  liveP.textContent = "Freshly appended paragraph to translate.";
  env.doc.body.appendChild(liveP);
  await wait(700);   // MutationObserver 400ms 防抖 + 合批 120ms
  assert.equal(env.asks("TRANSLATE_BLOCKS").length, dynamicBefore + 1, "动态追加的段落应产生一次新请求");
  assert.deepEqual(Array.from(env.asks("TRANSLATE_BLOCKS").at(-1).items, (item) => item.text), ["Freshly appended paragraph to translate."]);
  assert.equal(liveP.firstChild.nodeValue, "T:Freshly appended paragraph to translate.", "动态内容也应在原节点翻好");
  assert.equal(pageStatusOf(env), "完成 · 2 处 · 2 次请求");
  env.window.close();

  /* 22. 还原之后到达的旧响应必须作废：不能在“还原”之后又把页面翻一遍，
   *     否则会留下既没有控制片、也无法撤销的译文。 */
  env = boot();
  env.doc.body.innerHTML = "<p>Late response must be dropped.</p>";
  const heldBlocks = [];
  const sendBefore22 = env.window.chrome.runtime.sendMessage;
  env.window.chrome.runtime.sendMessage = (msg, cb) => {
    if (msg.type === "TRANSLATE_BLOCKS") { heldBlocks.push({ msg, cb }); return; }
    return sendBefore22(msg, cb);
  };
  env.send({ type: "TRANSLATE_PAGE", target: "zh-CN" });
  await wait(40);
  assert.equal(heldBlocks.length, 1, "应发出批量请求并挂住回调");
  env.userEvent(pagebarOf(env).querySelector('[data-page="restore"]'), "click");
  assert.equal(env.doc.body.innerHTML, "<p>Late response must be dropped.</p>", "还原后应立刻回到原文");
  heldBlocks[0].cb({ ok: true, items: [{ id: heldBlocks[0].msg.items[0].id, text: "迟到的译文" }] });
  await wait(40);
  assert.equal(env.doc.querySelector("p").firstChild.nodeValue, "Late response must be dropped.", "还原后到达的旧响应不得改动页面");
  assert.equal(pagebarOf(env), null, "还原后不应重新出现控制片");
  env.window.close();

  /* 23. 停止→继续：已经在飞的段落不得被重新入队，否则会重复请求且计数超过总数。 */
  env = boot();
  env.doc.body.innerHTML = "<p>First pending block.</p><p>Second pending block.</p>";
  const heldInFlight = [];
  let blockCalls = 0;
  const sendBefore23 = env.window.chrome.runtime.sendMessage;
  env.window.chrome.runtime.sendMessage = (msg, cb) => {
    if (msg.type === "TRANSLATE_BLOCKS") { blockCalls++; heldInFlight.push({ msg, cb }); return; }
    return sendBefore23(msg, cb);
  };
  env.send({ type: "TRANSLATE_PAGE", target: "zh-CN" });
  await wait(40);
  assert.equal(heldInFlight.length, 1, "两个短段应合成一批");
  const resumeBar = pagebarOf(env);
  env.userEvent(resumeBar.querySelector('[data-page="stop"]'), "click");
  env.userEvent(resumeBar.querySelector('[data-page="stop"]'), "click");   // 继续
  await wait(40);
  assert.equal(blockCalls, 1, "在飞的段落不应被重新发送");
  heldInFlight[0].cb({ ok: true, items: heldInFlight[0].msg.items.map((item) => ({ id: item.id, text: "T:" + item.text })) });
  await wait(60);
  assert.equal(pageStatusOf(env), "完成 · 2 处 · 1 次请求", "请求数与完成数都应准确，不能出现 4/2");
  assert.deepEqual(
    [...env.doc.querySelectorAll("p")].map((p) => p.firstChild.nodeValue),
    ["T:First pending block.", "T:Second pending block."]
  );
  env.window.close();

  console.log("content ok");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
