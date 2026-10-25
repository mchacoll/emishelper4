import { EMIS_ORIGIN } from "./emis-webview-types";

export type CrawlRecord = { fields: Record<string, string>; profileUrl?: string };

export type CrawlMessage =
  | { type: "emis-crawl-progress"; message: string; done: number; total: number; page: number }
  | { type: "emis-crawl-records"; records: CrawlRecord[] }
  | { type: "emis-crawl-done"; total: number; pages: number; cancelled: boolean; diagnostics: string }
  | { type: "emis-crawl-error"; message: string; diagnostics: string };

/**
 * Background reader. Runs inside the EMIS page (after the user has signed in by themselves),
 * walks the visible student table page by page, opens each student's details the same way a user
 * would (clicking the row's view button / link), reads the visible labels, closes it, and moves on.
 * It never touches password fields, storage or network APIs, and only runs on the official origin.
 */
export const EMIS_CRAWLER_SCRIPT = String.raw`(function () {
  var ORIGIN = "https://emis.moedu.gov.iq";
  if (location.origin !== ORIGIN) return;
  if (window.__emisCrawl && window.__emisCrawl.running) return;
  var state = window.__emisCrawl = { running: true, cancel: false };

  var MAX_PAGES = 300, MAX_RECORDS = 6000;
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var clean = function (v) { return String(v == null ? "" : v).replace(/\s+/g, " ").trim(); };
  var txt = function (n) { return clean(n && (n.innerText || n.textContent)); };
  var visible = function (n) {
    if (!n || !n.getBoundingClientRect) return false;
    var b = n.getBoundingClientRect();
    if (b.width <= 0 || b.height <= 0) return false;
    var s = window.getComputedStyle(n);
    return s.display !== "none" && s.visibility !== "hidden";
  };
  var post = function (o) { try { window.ReactNativeWebView.postMessage(JSON.stringify(o)); } catch (e) {} };
  var diag = { url: location.href, notes: [] };
  var note = function (s) { if (diag.notes.length < 40) diag.notes.push(s); };

  var waitFor = async function (fn, timeout, step) {
    var t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (state.cancel) return null;
      var v = fn();
      if (v) return v;
      await sleep(step || 150);
    }
    return null;
  };

  var PLACEHOLDER_RE = /^(اختر|إختر|أدخل|ادخل|إدخل|select|choose|enter|اضغط|انقر|لا يوجد|--)(\s|$)/i;
  var ACTION_BAD = /(حذف|تعديل|طباعة|نقل|تصدير|delete|remove|edit|print|transfer|export|إضافة|اضافة|add)/i;
  var ACTION_VIEW = /(عرض|تفاصيل|ملف|معلومات|بطاقة|view|detail|show|eye|profile|info|open)/i;
  var NEXT_RE = /(التالي|الصفحة التالية|next|›|»|>|chevron-left|angle-left|arrow-left)/i;
  var CLOSE_RE = /(اغلاق|إغلاق|close|إلغاء|الغاء|cancel|رجوع|back|×|✕|x)/i;

  // ---------- table reading ----------
  var pickTable = function () {
    var tables = Array.from(document.querySelectorAll("table")).filter(visible);
    var best = null, bestN = 0;
    tables.forEach(function (t) {
      var n = readTable(t).length;
      if (n > bestN) { best = t; bestN = n; }
    });
    return best;
  };
  var headersOf = function (table) {
    var ths = Array.from(table.querySelectorAll("thead tr")).filter(visible);
    var row = null;
    for (var i = 0; i < ths.length; i++) {
      var hasInput = ths[i].querySelector("input,select");
      var cells = ths[i].querySelectorAll("th,td");
      if (cells.length && !hasInput && txt(ths[i])) { row = ths[i]; break; }
    }
    if (!row) { var first = table.querySelector("tr"); row = first; }
    return row ? Array.from(row.querySelectorAll("th,td")).map(function (c, i) { return txt(c) || ("حقل " + (i + 1)); }) : [];
  };
  var readTable = function (table) {
    var headers = headersOf(table);
    var rows = [];
    var trs = Array.from(table.querySelectorAll("tbody tr")).filter(visible);
    if (!trs.length) trs = Array.from(table.querySelectorAll("tr")).filter(visible).slice(1);
    trs.forEach(function (tr) {
      if (tr.querySelector("input:not([type='checkbox']), select")) return; // filter row
      var cells = Array.from(tr.children).filter(function (c) { return /^t[dh]$/i.test(c.tagName); });
      if (cells.length < 2) return;
      var f = {}, filled = 0;
      cells.forEach(function (c, i) {
        var v = txt(c);
        if (v) { f[headers[i] || ("حقل " + (i + 1))] = v; filled++; }
      });
      if (filled >= 2) rows.push({ tr: tr, fields: f });
    });
    return rows;
  };
  var signature = function (rows) { return rows.map(function (r) { return Object.keys(r.fields).map(function (k) { return r.fields[k]; }).join("|"); }).join("§"); };

  // ---------- detail reading ----------
  var MODAL_SEL = ".modal.show, .modal.in, .modal[style*='display: block'], [role='dialog'], [role='alertdialog'], .p-dialog, .mat-dialog-container, .cdk-overlay-pane, .el-dialog, .ant-modal, .swal2-popup, dialog[open]";
  var findModal = function () {
    var list = Array.from(document.querySelectorAll(MODAL_SEL)).filter(visible);
    return list.length ? list[list.length - 1] : null;
  };
  var extractFields = function (root) {
    var fields = {};
    var add = function (k, v) {
      k = clean(k).replace(/\s*\*+\s*/g, " ").replace(/[：:]+$/, "").trim(); v = clean(v);
      if (!k || !v || k.length > 90 || v.length > 1500) return;
      if (/كلمة المرور|password/i.test(k)) return;
      if (PLACEHOLDER_RE.test(v) || v === k) return;
      if (!fields[k]) fields[k] = v;
    };
    // labels with controls
    Array.from(root.querySelectorAll("label")).filter(visible).forEach(function (l) {
      var c = l.control || (l.htmlFor ? document.getElementById(l.htmlFor) : null);
      if (c && c.type === "password") return;
      if (c && typeof c.value === "string" && c.value) { add(txt(l), c.value); return; }
      var s = l.nextElementSibling;
      if (s && !s.matches("label")) { var t = txt(s); if (t) add(txt(l), t); }
    });
    // inputs / selects: label by for=, by the nearest single <label> in the same group, then aria/name/placeholder
    var labelFor = function (c) {
      if (c.id) { var l = root.querySelector("label[for='" + c.id + "']"); if (l) return txt(l); }
      var p = c.parentElement;
      for (var i = 0; p && i < 4; i++, p = p.parentElement) {
        var ls = p.querySelectorAll("label");
        if (ls.length === 1) return txt(ls[0]);
        if (ls.length > 1) break;
      }
      return "";
    };
    Array.from(root.querySelectorAll("input:not([type='password']):not([type='hidden']):not([type='checkbox']):not([type='radio']):not([type='file']), textarea, select")).filter(visible).forEach(function (c) {
      var key = labelFor(c) || clean(c.getAttribute("aria-label") || c.getAttribute("name") || "") || clean(c.getAttribute("placeholder") || "").replace(/^(أدخل|ادخل|اختر|إختر)\s+/, "");
      var val = c.tagName === "SELECT" ? txt(c.options && c.options[c.selectedIndex]) : c.value;
      if (key && val) add(key, val);
    });
    // definition lists
    Array.from(root.querySelectorAll("dt")).filter(visible).forEach(function (dt) {
      var dd = dt.nextElementSibling; if (dd && /^dd$/i.test(dd.tagName)) add(txt(dt), txt(dd));
    });
    // two-cell rows (key / value tables)
    Array.from(root.querySelectorAll("tr")).filter(visible).forEach(function (tr) {
      var cells = Array.from(tr.children).filter(function (c) { return /^t[dh]$/i.test(c.tagName); });
      if (cells.length === 2) add(txt(cells[0]), txt(cells[1]));
    });
    // "key: value" siblings and common grid patterns
    Array.from(root.querySelectorAll("div,span,p,li,strong,b,small")).filter(visible).forEach(function (n) {
      if (n.children.length > 0) return;
      var t = txt(n);
      if (!t) return;
      var m = t.match(/^(.{2,60}?)\s*[：:]\s*(.+)$/);
      if (m) { add(m[1], m[2]); return; }
      if (/[：:]$/.test(t) && n.nextElementSibling) { var v = txt(n.nextElementSibling); if (v && v.length < 400) add(t, v); }
    });
    return fields;
  };

  var rowActionLabels = function (tr) {
    return Array.from(tr.querySelectorAll("a,button,[role='button'],i,svg,span[class*='icon']")).filter(visible).map(function (n) {
      var l = clean([n.getAttribute("aria-label"), n.getAttribute("title"), n.getAttribute("mattooltip"), typeof n.className === "string" ? n.className : "", txt(n)].filter(Boolean).join(" "));
      return l.slice(0, 60);
    });
  };
  var labelOf = function (n) { return clean([n.getAttribute("aria-label"), n.getAttribute("title"), n.getAttribute("mattooltip"), typeof n.className === "string" ? n.className : "", txt(n), n.innerHTML && n.innerHTML.length < 400 ? n.innerHTML : ""].filter(Boolean).join(" ")); };
  var pickTriggers = function (tr) {
    var cands = Array.from(tr.querySelectorAll("a,button,[role='button']")).filter(visible);
    var out = [];
    var push = function (n) { if (n && out.indexOf(n) < 0) out.push(n); };
    var good = cands.filter(function (n) { return !ACTION_BAD.test(labelOf(n)); });
    push(good.find(function (n) { return ACTION_VIEW.test(labelOf(n)); }));
    push(good.find(function (n) { var h = n.getAttribute("href"); return n.tagName.toLowerCase() === "a" && h && h !== "#" && !/^javascript/i.test(h); }));
    var nameCell = Array.from(tr.children).find(function (c) { return txt(c).length > 6 && !c.querySelector("button"); });
    push(nameCell || tr);
    // last resort: the row's edit button (opened only to read; the crawler never presses save/submit)
    push(cands.find(function (n) { var l = labelOf(n); return /(تعديل|edit)/i.test(l) && !/(حذف|delete|remove)/i.test(l); }));
    return out;
  };

  // multi-step forms: read every step by pressing only "next", never save/submit
  var STEP_NEXT = /(التالي|الخطوة التالية|متابعة|next|continue)/i;
  var STEP_BAD = /(حفظ|save|submit|إرسال|ارسال|تأكيد|تاكيد|إنهاء|انهاء|finish|حذف|delete|إلغاء|الغاء|cancel|السابق|previous|prev|back|رجوع)/i;
  var findStepNext = function (root) {
    var nodes = Array.from(root.querySelectorAll("button,a,[role='button'],input[type='button']")).filter(visible);
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var l = clean([n.getAttribute("aria-label"), n.getAttribute("title"), n.value, txt(n)].filter(Boolean).join(" "));
      if (STEP_NEXT.test(l) && !STEP_BAD.test(l) && !disabledNode(n)) return n;
    }
    return null;
  };
  var readSteps = async function (root) {
    var fields = extractFields(root);
    var steps = 1;
    if (!diag.detailButtons) diag.detailButtons = Array.from(root.querySelectorAll("button,a,[role='button']")).filter(visible).map(function (n) { return clean(txt(n) || n.getAttribute("aria-label") || n.getAttribute("title")).slice(0, 30); }).filter(Boolean).slice(0, 25);
    for (var s = 0; s < 6 && !state.cancel; s++) {
      var nb = findStepNext(root);
      if (!nb) break;
      nb.click();
      await sleep(800);
      var scope = document.contains(root) ? root : document.body;
      var more = extractFields(scope), added = 0;
      Object.keys(more).forEach(function (k) { if (!(k in fields)) { fields[k] = more[k]; added++; } });
      steps++;
      if (!added) break;
    }
    diag.maxSteps = Math.max(diag.maxSteps || 0, steps);
    return fields;
  };
  var domSig = function () { return location.href + "#" + (document.body ? document.body.innerText.length : 0); };

  var closeDetail = async function (urlBefore, modal) {
    if (modal && document.contains(modal) && visible(modal)) {
      var btn = Array.from(modal.querySelectorAll("button,[role='button'],a,.close,[data-dismiss],[data-bs-dismiss]")).filter(visible).find(function (b) {
        return CLOSE_RE.test(clean([b.getAttribute("aria-label"), b.getAttribute("title"), txt(b), typeof b.className === "string" ? b.className : ""].join(" ")));
      });
      if (btn) btn.click();
      else document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true }));
      await waitFor(function () { return !document.contains(modal) || !visible(modal); }, 2500);
    }
    if (location.href !== urlBefore) {
      history.back();
      await waitFor(function () { return location.href === urlBefore; }, 3000);
    }
    await waitFor(function () { var t = pickTable(); return t && readTable(t).length > 0; }, 8000);
  };

  var readDetail = async function (tr, urlBefore) {
    var triggers = pickTriggers(tr);
    for (var t = 0; t < triggers.length; t++) {
      if (state.cancel) break;
      var beforeSig = domSig();
      var hadModal = !!findModal();
      triggers[t].click();
      var opened = await waitFor(function () {
        if (location.href !== urlBefore) return "route";
        var m = findModal(); if (m && !hadModal) return "modal";
        if (domSig() !== beforeSig) return "dom";
        return null;
      }, 3500);
      if (!opened) continue;
      await sleep(900); // let the details render
      var modal = findModal();
      var root = (opened === "modal" && modal) ? modal : document.body;
      var fields = await readSteps(root);
      await closeDetail(urlBefore, modal);
      return { fields: fields, kind: opened, trigger: t };
    }
    return { fields: null, kind: "none" };
  };

  // ---------- pagination ----------
  var disabledNode = function (n) {
    if (n.disabled || n.getAttribute("aria-disabled") === "true") return true;
    var c = (typeof n.className === "string" ? n.className : "") + " " + (n.parentElement && typeof n.parentElement.className === "string" ? n.parentElement.className : "");
    return /disabled|inactive/i.test(c);
  };
  var findNext = function () {
    var nodes = Array.from(document.querySelectorAll("a,button,li,[role='button'],.pagination *,[class*='paginat'] *,[class*='next']")).filter(visible);
    var picks = nodes.filter(function (n) {
      var l = clean([n.getAttribute("aria-label"), n.getAttribute("title"), n.getAttribute("rel"), typeof n.className === "string" ? n.className : "", txt(n)].join(" "));
      if (!NEXT_RE.test(l)) return false;
      if (/(previous|prev|السابق|first|last|الأول|الأخير|per-page|page-size)/i.test(l)) return false;
      return true;
    });
    for (var i = 0; i < picks.length; i++) {
      var n = picks[i];
      var target = n.matches("li") ? (n.querySelector("a,button") || n) : n;
      if (!disabledNode(n) && !disabledNode(target)) return target;
    }
    return null;
  };

  // ---------- main ----------
  (async function () {
    var all = [], seen = {}, page = 0, total = 0, done = 0, fatal = "";
    try {
      var table = await waitFor(pickTable, 12000);
      if (!table) { post({ type: "emis-crawl-error", message: "لم أجد جدول الطلاب في الصفحة.", diagnostics: JSON.stringify(diag) }); state.running = false; return; }
      while (!state.cancel && page < MAX_PAGES && done < MAX_RECORDS) {
        page++;
        table = pickTable();
        var rows = table ? readTable(table) : [];
        if (!rows.length) { note("page " + page + ": no rows"); break; }
        if (page === 1) {
          diag.headers = headersOf(table);
          diag.firstRowFields = rows[0].fields;
          diag.firstRowActions = rowActionLabels(rows[0].tr);
        }
        var pageSig = signature(rows);
        total += rows.length;
        post({ type: "emis-crawl-progress", message: "قراءة الصفحة " + page, done: done, total: total, page: page });
        for (var i = 0; i < rows.length; i++) {
          if (state.cancel) break;
          // re-resolve the row after returning from a detail view
          var current = pickTable() ? readTable(pickTable()) : [];
          var sigI = signature([rows[i]]);
          var row = current.find(function (c) { return signature([c]) === sigI; }) || null;
          if (!row) { note("row lost p" + page + " i" + i); all.push({ fields: rows[i].fields }); continue; }
          var key = signature([row]);
          if (seen[key]) continue;
          seen[key] = true;
          var merged = Object.assign({}, row.fields);
          var detail = { fields: null, kind: "none" };
          try { detail = await readDetail(row.tr, location.href); } catch (e) { note("detail error: " + (e && e.message)); }
          if (detail.fields) Object.keys(detail.fields).forEach(function (k) { if (!merged[k]) merged[k] = detail.fields[k]; });
          if (detail.fields) diag.detailOk = (diag.detailOk || 0) + 1; else diag.detailFail = (diag.detailFail || 0) + 1;
          if (page === 1 && i === 0) { diag.firstDetailKind = detail.kind; diag.firstTrigger = detail.trigger; diag.firstDetailFields = detail.fields ? Object.keys(detail.fields) : []; }
          all.push({ fields: merged });
          done++;
          post({ type: "emis-crawl-records", records: [{ fields: merged }] });
          post({ type: "emis-crawl-progress", message: "قراءة ملف الطالب " + done + " من " + total, done: done, total: total, page: page });
        }
        if (state.cancel) break;
        var next = findNext();
        if (!next) break;
        next.click();
        var changed = await waitFor(function () { var t = pickTable(); return t && signature(readTable(t)) !== pageSig && readTable(t).length > 0; }, 6000);
        if (!changed) { note("pagination did not change"); break; }
        await sleep(300);
      }
    } catch (e) { fatal = (e && e.message) || String(e); }
    state.running = false;
    diag.pages = page;
    if (fatal) post({ type: "emis-crawl-error", message: "تعطلت القراءة: " + fatal, diagnostics: JSON.stringify(diag) });
    else post({ type: "emis-crawl-done", total: done, pages: page, cancelled: state.cancel, diagnostics: JSON.stringify(diag) });
  })();
})(); true;`;

export function parseCrawlMessage(raw: string): CrawlMessage | null {
  try {
    const parsed = JSON.parse(raw) as { type?: string };
    if (!parsed.type || !parsed.type.startsWith("emis-crawl-")) return null;
    return parsed as CrawlMessage;
  } catch { return null; }
}

export const EMIS_CRAWLER_CANCEL_SCRIPT = `window.__emisCrawl && (window.__emisCrawl.cancel = true); true;`;
export { EMIS_ORIGIN };
