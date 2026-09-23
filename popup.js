const PRESETS = {
  // 依据 DeepSeek 官方文档 (api-docs.deepseek.com)：base_url 不带 /v1，模型用 deepseek-flash（支持图像理解）
  deepseek:    { baseUrl: "https://api.deepseek.com",        model: "deepseek-flash" },
  openrouter:  { baseUrl: "https://openrouter.ai/api/v1",    model: "openai/gpt-4o-mini" },
  siliconflow: { baseUrl: "https://api.siliconflow.cn/v1",   model: "Qwen/Qwen2.5-VL-72B-Instruct" },
  openai:      { baseUrl: "https://api.openai.com/v1",       model: "gpt-4o-mini" },
  custom:      { baseUrl: "",                                model: "" },
};

const defaults = {
  enabled: true,
  hotkeyEnabled: true,
  selMode: "icon",
  inputTargetLang: "en",
  selTargetLang: "zh-CN",
  pageTargetLang: "zh-CN",
  pageMode: "replace",
  autoTranslateSites: [],
  provider: "google",
  aiBaseUrl: PRESETS.deepseek.baseUrl,
  aiModel: PRESETS.deepseek.model,
  aiApiKey: "",
  checkUpdates: true,
};

/* 旧版本配置自动迁移（deepseek-chat / 带 /v1 的旧地址 → deepseek-flash） */
function migrate(s) {
  const fixed = {};
  if (s.aiModel === "deepseek-chat") fixed.aiModel = "deepseek-flash";
  if (s.aiBaseUrl === "https://api.deepseek.com/v1") fixed.aiBaseUrl = "https://api.deepseek.com";
  if (s.aiModel === "deepseek-ai/DeepSeek-V3") fixed.aiModel = "Qwen/Qwen2.5-VL-72B-Instruct";
  if (Object.keys(fixed).length) chrome.storage.sync.set(fixed);
  return { ...s, ...fixed };
}

chrome.storage.sync.get(defaults, (s) => {
  renderUI(migrate(s));
  /* 打开弹窗顺带做一次节流过的更新检查（后台 12 小时内只发一次请求）；自动检查关闭则只提示 */
  if (s.checkUpdates !== false) requestUpdateInfo(false);
  else $("updateStatus").textContent = "自动检查已关闭，可点「检查更新」手动查询。";
});
// 注意：这里不要再 get 一次调用 renderUI，否则会用未迁移的旧值覆盖上面的渲染。

const $ = (id) => document.getElementById(id);
const fields = ["enabled", "hotkeyEnabled", "selMode", "inputTargetLang", "selTargetLang", "pageMode", "provider",
                "aiBaseUrl", "aiModel", "aiApiKey", "checkUpdates"];

function renderUI(s) {
  fields.forEach((id) => {
    const el = $(id);
    if (el.type === "checkbox") el.checked = !!s[id];
    else el.value = Array.isArray(s[id]) ? s[id].join("\n") : (s[id] || "");
  });
  $("aiBox").classList.toggle("show", s.provider === "ai");
  $("engineBadge").textContent = s.provider === "ai" ? "AI 模式" : s.provider === "browser" ? "设备端" : "免费版";

  // 根据当前 base url 高亮预设
  const matched = Object.keys(PRESETS).find(
    (k) => PRESETS[k].baseUrl && PRESETS[k].baseUrl === (s.aiBaseUrl || "")
  );
  $("aiPreset").value = matched || "custom";

  // AI 模式权限状态提示
  if (s.provider === "ai") {
    try {
      const origin = new URL(s.aiBaseUrl).origin + "/*";
      chrome.permissions.contains({ origins: [origin] }, (has) => {
        $("statusHint").innerHTML = has
          ? "AI 翻译已就绪" + (s.aiApiKey ? "" : "（还需填写 API Key）")
          : "需要授权访问 API 域名：切一下下拉框或重新选择 AI 模式即可授权";
      });
    } catch (e) {
      $("statusHint").textContent = "API 地址格式不正确";
    }
  } else if (s.provider === "browser") {
    $("statusHint").textContent = "设备端翻译：免费、离线、无需 Key。需 Chrome 138+，首次使用会下载语言包。";
  } else {
    $("statusHint").textContent = "";
  }
}

function save(patch) {
  chrome.storage.sync.set(patch);
}

/* 开关/下拉：保存并刷新提示 */
["enabled", "hotkeyEnabled", "selMode", "inputTargetLang", "selTargetLang", "pageMode", "provider", "checkUpdates"].forEach((id) => {
  $(id).addEventListener("change", () => {
    const value = $(id).type === "checkbox" ? $(id).checked : $(id).value;
    save({ [id]: value });
    renderUI({ ...defaults, ...currentValues() });
    if (id === "provider" && value === "ai") ensurePermission();
  });
});

/* 文本输入：防抖保存 */
["aiBaseUrl", "aiModel", "aiApiKey"].forEach((id) => {
  $(id).addEventListener("change", () => save({ [id]: $(id).value.trim() }));
  $(id).addEventListener("input", debounce(() => save({ [id]: $(id).value.trim() }), 600));
});

/* 预设切换：自动填充地址和模型 */
$("aiPreset").addEventListener("change", () => {
  const p = PRESETS[$("aiPreset").value];
  if (!p.baseUrl) return; // 自定义：不覆盖
  $("aiBaseUrl").value = p.baseUrl;
  $("aiModel").value = p.model;
  save({ aiBaseUrl: p.baseUrl, aiModel: p.model });
  renderUI({ ...defaults, ...currentValues() });
  ensurePermission();
});

/* 向浏览器申请访问 AI API 域名的权限（manifest 已声明全网 host 权限，这里只做状态检测） */
function ensurePermission() {
  let origin;
  try {
    origin = new URL($("aiBaseUrl").value.trim()).origin + "/*";
  } catch (e) {
    return;
  }
  chrome.permissions.contains({ origins: [origin] }, (has) => {
    if (!has) {
      try { chrome.permissions.request({ origins: [origin] }, () => renderCurrent()); } catch (e) {}
    }
  });
}

/* ---- 当前页面连接状态诊断 ---- */
function checkTab() {
  const el = $("tabStatus");
  if (!el) return;
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (!tab || !tab.id || !/^https?:/.test(tab.url || "")) {
      el.textContent = "当前页面不支持扩展（浏览器内部页）";
      el.className = "tab-status";
      return;
    }
    chrome.tabs.sendMessage(tab.id, { type: "PING" }, (r) => {
      if (chrome.runtime.lastError || !r) {
        el.innerHTML = '当前页面未注入，翻译功能不可用 —— <a href="#" id="fixTabLink">点我修复</a>';
        el.className = "tab-status bad";
        const a = document.getElementById("fixTabLink");
        if (a) {
          a.onclick = (ev) => {
            ev.preventDefault();
            el.textContent = "正在注入…";
            el.className = "tab-status";
            chrome.runtime.sendMessage({ type: "INJECT_TAB", tabId: tab.id }, () => {
              setTimeout(checkTab, 700);
            });
          };
        }
      } else {
        el.textContent = "当前页面已连接，功能正常 (v" + (r.v || "?") + ")";
        el.className = "tab-status ok";
      }
    });
  });
}
checkTab();

function currentValues() {
  const v = {};
  fields.forEach((id) => {
    v[id] = $(id).type === "checkbox" ? $(id).checked : $(id).value;
  });
  return v;
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/* AI 看屏幕解读按钮 */
$("explainBtn").addEventListener("click", () => {
  chrome.storage.sync.get(defaults, (s) => {
    if (s.provider !== "ai" || !s.aiApiKey) {
      if (!confirm("AI 看屏幕需要先启用 AI 模式并填写 API Key。\n现在先试一次（未配置会提示错误）？")) return;
    }
    // 先发消息给后台，后台确认接收后再关弹窗（关早了消息会丢！）
    chrome.runtime.sendMessage({ type: "EXPLAIN_PAGE" }, () => {
      void chrome.runtime.lastError;
      try { window.close(); } catch (e) {}
    });
  });
});

function renderCurrent() {
  renderUI({ ...defaults, ...currentValues() });
}

chrome.storage.local.get({ glossary: "" }, data => { $("glossary").value = data.glossary; });
$("glossary").addEventListener("input", () => {
  $("glossaryStatus").textContent = "有未保存的修改";
  $("glossaryStatus").classList.remove("error");
});
$("saveGlossary").addEventListener("click", () => {
  $("saveGlossary").disabled = true;
  chrome.runtime.sendMessage({ type: "SAVE_GLOSSARY", text: $("glossary").value }, response => {
    const error = chrome.runtime.lastError?.message || (!response?.ok ? response?.error || "保存失败，请重试" : "");
    $("glossaryStatus").textContent = error || "已保存，将应用于下一次翻译和回复。";
    $("glossaryStatus").classList.toggle("error", !!error);
    $("saveGlossary").disabled = false;
  });
});
for (const [id, mode] of [["replyBtn", "reply"], ["offerBtn", "offer"]]) {
  $(id).addEventListener("click", () => {
    $(id).disabled = true;
    chrome.runtime.sendMessage({ type: "OPEN_WORKBENCH_REQUEST", mode }, response => {
      const error = chrome.runtime.lastError?.message || (!response?.ok ? response?.error || "打开失败，请刷新网页后重试" : "");
      if (error) {
        $("toolStatus").textContent = error; $("toolStatus").classList.add("error"); $(id).disabled = false;
      } else window.close();
    });
  });
}

/* 整页翻译：交给后台注入并通知内容脚本，开始后页面右下角出现页栏 */
$("pageBtn").addEventListener("click", () => {
  const btn = $("pageBtn");
  btn.disabled = true;
  chrome.runtime.sendMessage({ type: "TRANSLATE_PAGE_REQUEST" }, response => {
    const error = chrome.runtime.lastError?.message || (!response?.ok ? response?.error || "无法开始整页翻译，请刷新网页后重试" : "");
    if (error) {
      $("toolStatus").textContent = error; $("toolStatus").classList.add("error"); btn.disabled = false;
    } else window.close();
  });
});

/* ---- 在线更新：当前版本 + 手动检查 + 后台返回结果渲染 ---- */
$("versionBadge").textContent = "v" + chrome.runtime.getManifest().version;

function requestUpdateInfo(manual) {
  const btn = $("checkUpdateBtn");
  btn.disabled = true;
  $("updateStatus").classList.remove("error");
  $("updateStatus").textContent = "正在向 GitHub 检查更新…";
  chrome.runtime.sendMessage({ type: "CHECK_UPDATE", force: manual }, (r) => {
    btn.disabled = false;
    renderUpdateInfo(r, manual);
  });
}

function renderUpdateInfo(r, manual) {
  const el = $("updateStatus");
  el.classList.remove("error");
  const err = chrome.runtime.lastError?.message || (!r?.ok ? r?.error || "后台无响应" : "");
  const info = err ? null : r.result;
  /* 后台对 latest/current 做过严格数字校验，可以安全内插进 innerHTML */
  if (!info) {
    el.textContent = manual ? "检查失败：" + err : "";
    if (manual) el.classList.add("error");
    return;
  }
  const when = info.lastCheck ? "（" + formatWhen(info.lastCheck) + "检查）" : "";
  if (info.updateAvailable) {
    el.innerHTML =
      "发现新版本 <b>v" + info.latest + "</b>（当前 v" + info.current + "）" +
      (info.status === "error" ? "（本次离线，显示上次检查结果）" : "") + "<br>" +
      '<a href="' + info.downloadUrl + '" target="_blank" rel="noopener">下载更新包</a> · ' +
      '<a href="' + info.commitsUrl + '" target="_blank" rel="noopener">更新内容</a><br>' +
      "zip 解压后覆盖本地扩展目录，到 chrome://extensions 重新加载；git 用户直接 pull。";
    return;
  }
  if (info.status === "error") {
    if (info.lastCheck) {
      el.textContent = "已是最新版本 v" + info.current + when + "；本次检查未完成（" + info.error + "）";
    } else {
      el.textContent = manual ? "检查失败：" + info.error : "";
      if (manual) el.classList.add("error");
    }
    return;
  }
  el.textContent = info.latest === info.current
    ? "已是最新版本 v" + info.current + when
    : "已是最新版本（本地 v" + info.current + "，GitHub v" + info.latest + "）" + when;
}

function formatWhen(ts) {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return d.getMonth() + 1 + "月" + d.getDate() + "日 " + hh + ":" + mm + " ";
}

$("checkUpdateBtn").addEventListener("click", () => requestUpdateInfo(true));

/* ---- 本月翻译用量（仅本地统计） ---- */
function formatUsage(u) {
  if (!u || !u.month) return "—";
  const chars = u.chars >= 10000 ? (u.chars / 10000).toFixed(1) + "万" : String(u.chars || 0);
  return chars + " 字符 · " + (u.reqs || 0) + " 次";
}
chrome.storage.local.get("usage", (obj) => { $("usageBadge").textContent = formatUsage(obj && obj.usage); });

/* ---- 术语表导出 / 导入 ---- */
$("exportGlossary").addEventListener("click", () => {
  const text = $("glossary").value;
  if (!text.trim()) {
    $("glossaryStatus").textContent = "术语表为空，无可导出内容。";
    $("glossaryStatus").classList.remove("error");
    return;
  }
  try {
    downloadTextFile("中英互译术语表.txt", text);
    $("glossaryStatus").textContent = "已导出当前编辑框内容。";
    $("glossaryStatus").classList.remove("error");
  } catch (e) {
    $("glossaryStatus").textContent = "导出失败：" + (e && e.message);
    $("glossaryStatus").classList.add("error");
  }
});

$("importGlossaryBtn").addEventListener("click", () => $("importGlossaryFile").click());
$("importGlossaryFile").addEventListener("change", (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = "";
  if (!file) return;
  if (file.size > 60000) { glossaryStatusError("文件过大，不是术语表文件。", "glossaryStatus"); return; }
  const reader = new FileReader();
  reader.onload = () => {
    $("glossary").value = String(reader.result || "").slice(0, 12000);
    $("glossaryStatus").textContent = "已载入，检查后点「保存术语表」生效。";
    $("glossaryStatus").classList.remove("error");
  };
  reader.onerror = () => glossaryStatusError("读取文件失败。", "glossaryStatus");
  reader.readAsText(file, "utf-8");
});

function glossaryStatusError(text, id) {
  $(id).textContent = text;
  $(id).classList.add("error");
}

function downloadTextFile(name, text) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) {} }, 5000);
}

/* ---- 生词本 ---- */
function renderVocab(list) {
  const box = $("vocabList");
  box.replaceChildren();
  if (!Array.isArray(list) || !list.length) {
    const p = document.createElement("p");
    p.className = "vocab-empty";
    p.textContent = "还没有收藏。划词翻译后，点气泡里的「收」。";
    box.appendChild(p);
    return;
  }
  for (const item of list) {
    const row = document.createElement("div");
    row.className = "vocab-item";
    const text = document.createElement("div");
    text.className = "v-text";
    const src = document.createElement("div");
    src.className = "v-src"; src.textContent = item.text;
    const dst = document.createElement("div");
    dst.className = "v-dst"; dst.textContent = "→ " + item.tr;
    text.append(src, dst);
    const del = document.createElement("button");
    del.type = "button"; del.className = "v-del"; del.title = "删除"; del.textContent = "×";
    del.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "VOCAB_DELETE", id: item.id }, () => {
        void chrome.runtime.lastError;
        loadVocab();
      });
    });
    row.append(text, del);
    box.appendChild(row);
  }
}

function loadVocab() {
  chrome.storage.local.get("vocab", (obj) => {
    renderVocab(obj && obj.vocab);
    $("exportVocab").disabled = !Array.isArray(obj?.vocab) || !obj.vocab.length;
  });
}
loadVocab();

$("exportVocab").addEventListener("click", () => {
  chrome.storage.local.get("vocab", (obj) => {
    const list = obj && obj.vocab;
    if (!Array.isArray(list) || !list.length) { vocabError("生词本为空。"); return; }
    const tsv = list.map(v => v.text + "\t" + v.tr).join("\n");
    try {
      downloadTextFile("生词本-Anki.txt", tsv);
      $("vocabStatus").textContent = "已导出 Anki 可导入的 TSV（制表符分隔）。";
      $("vocabStatus").classList.remove("error");
    } catch (e) { vocabError("导出失败：" + (e && e.message)); }
  });
});

function vocabError(text) {
  $("vocabStatus").textContent = text;
  $("vocabStatus").classList.add("error");
}

let vocabClearArmed = 0;
$("clearVocabBtn").addEventListener("click", () => {
  if (Date.now() - vocabClearArmed > 3000) {
    vocabClearArmed = Date.now();
    $("clearVocabBtn").textContent = "确认清空？";
    $("vocabStatus").textContent = "再点一次确认清空生词本（不可撤销）。";
    setTimeout(() => { if (Date.now() - vocabClearArmed >= 3000) $("clearVocabBtn").textContent = "清空生词本"; }, 3200);
    return;
  }
  vocabClearArmed = 0;
  $("clearVocabBtn").textContent = "清空生词本";
  chrome.runtime.sendMessage({ type: "VOCAB_CLEAR" }, () => {
    void chrome.runtime.lastError;
    loadVocab();
    $("vocabStatus").textContent = "已清空。";
    $("vocabStatus").classList.remove("error");
  });
});

/* ---- 自动翻译站点 ---- */
let autoSitesHost = "";
function hostMatches(host, pat) {
  host = String(host || "").toLowerCase().trim();
  pat = String(pat || "").toLowerCase().trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
  if (!host || !pat) return false;
  return host === pat || host.endsWith("." + pat);
}

function currentHost(cb) {
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    try { cb(tab && tab.url ? new URL(tab.url).hostname : ""); } catch { cb(""); }
  });
}

chrome.storage.sync.get({ autoTranslateSites: [] }, (s) => {
  const sites = Array.isArray(s.autoTranslateSites) ? s.autoTranslateSites : [];
  $("autoSitesText").value = sites.join("\n");
  currentHost((host) => {
    autoSitesHost = host;
    $("autoSiteLabel").textContent = host ? "在 " + host + " 自动整页翻译" : "本站自动整页翻译（非网页）";
    $("autoSite").disabled = !host;
    $("autoSite").checked = host && sites.some(pat => hostMatches(host, pat));
  });
});

$("autoSite").addEventListener("change", () => {
  const add = $("autoSite").checked;
  chrome.storage.sync.get({ autoTranslateSites: [] }, (s) => {
    let sites = Array.isArray(s.autoTranslateSites) ? [...s.autoTranslateSites] : [];
    if (add) {
      if (!sites.includes(autoSitesHost)) sites.push(autoSitesHost);
    } else {
      sites = sites.filter(pat => !hostMatches(autoSitesHost, pat));
    }
    chrome.storage.sync.set({ autoTranslateSites: sites }, () => {
      $("autoSitesText").value = sites.join("\n");
      $("autoSitesStatus").textContent = add
        ? "已开启：下次打开该站点自动整页翻译。"
        : "已关闭该站点的自动翻译。";
    });
  });
});

$("saveAutoSites").addEventListener("click", () => {
  const sites = $("autoSitesText").value.split(/\n/).map(l => l.trim()).filter(Boolean).slice(0, 50);
  chrome.storage.sync.set({ autoTranslateSites: sites }, () => {
    $("autoSitesStatus").textContent = "已保存 " + sites.length + " 个站点。";
    currentHost((host) => {
      autoSitesHost = host;
      $("autoSite").checked = host && sites.some(pat => hostMatches(host, pat));
    });
  });
});
