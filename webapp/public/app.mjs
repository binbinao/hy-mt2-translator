/**
 * 译稿台 — desk behaviour.
 *
 * Runs in two modes, detected at boot:
 *   local  — served by webapp/server.mjs: validation and model lifecycle are
 *            server-side, translations stream from /api/translate.
 *   static — served as plain files (e.g. GitHub Pages): no backend exists, so
 *            the browser talks straight to a user-supplied OpenAI-compatible
 *            endpoint.
 *
 * Length policy, language table and prompts come from the shared modules
 * (/limit.mjs, /languages.mjs, /translate.mjs), so both modes agree.
 */
import { measure, rejection, countChars } from './limit.mjs';
import { LANGUAGES } from './languages.mjs';
import { buildPrompt, streamTranslation } from './translate.mjs';

const $ = (id) => document.getElementById(id);

const el = {
  chip: $('modelChip'), dot: $('modelDot'), modelText: $('modelText'), modeChip: $('modeChip'),
  limitChip: $('limitChip'), blankLimit: $('blankLimit'), fileHint: $('fileHint'),
  importBtn: $('importBtn'), fileInput: $('fileInput'),
  target: $('target'), mdToggle: $('mdToggle'),
  translateBtn: $('translateBtn'), cancelBtn: $('cancelBtn'), clearBtn: $('clearBtn'),
  notice: $('notice'), source: $('source'), output: $('output'), outBlank: $('outBlank'),
  srcStat: $('srcStat'), dstStat: $('dstStat'), dstMeta: $('dstMeta'),
  ruler: $('ruler'), rulerFill: $('rulerFill'), rulerText: $('rulerText'),
  seal: $('seal'), status: $('status'), copyBtn: $('copyBtn'), downloadBtn: $('downloadBtn'),
  veil: $('veil'),
  conn: $('conn'), connEndpoint: $('connEndpoint'), connKey: $('connKey'),
  connSave: $('connSave'), connTest: $('connTest'), connHint: $('connHint'),
};

const ACCEPTED = ['.txt', '.text', '.md', '.markdown'];
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const AUTO_DEBOUNCE_MS = 700;
const CONN_KEY = 'hy-mt2.endpoint';
const DEFAULT_ENDPOINT = 'http://127.0.0.1:8080';

let appMode = 'local';    // 'local' | 'static'
let endpoint = DEFAULT_ENDPOINT;
let apiKey = '';
let maxChars = 2000;
let ctrl = null;          // in-flight request
let pendingTimer = null;
let lastKey = null;       // target|mode|text of the last successful request
let resultText = '';
let resultMode = 'plain';
let pollTimer = null;

/* ------------------------------------------------------------------ meter */

const report = () => measure(el.source.value, maxChars);

function paint() {
  const r = report();
  el.srcStat.textContent = `${r.chars} 字符 · ${r.han} 汉字`;
  el.rulerFill.style.width = `${Math.min(100, (r.chars / r.max) * 100)}%`;
  el.rulerText.textContent = `${r.chars} / ${r.max}`;
  el.ruler.classList.toggle('is-over', r.over);
  el.rulerText.classList.toggle('is-over', r.over);
  el.translateBtn.disabled = r.empty || r.over || Boolean(ctrl);
  if (r.over) showNotice(rejection(r), 'length');
  else if (el.notice.dataset.kind === 'length') hideNotice();
  return r;
}

function showNotice(message, kind = 'warn', action = null) {
  el.notice.textContent = message;
  el.notice.dataset.kind = kind;
  el.notice.classList.toggle('notice--info', kind === 'info');
  el.notice.hidden = false;
  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn--sm';
    btn.textContent = action.label;
    btn.addEventListener('click', action.run, { once: true });
    el.notice.append(' ', btn);
  }
}

function hideNotice() {
  el.notice.hidden = true;
  delete el.notice.dataset.kind;
}

const setStatus = (text) => { el.status.textContent = text; };

/* ----------------------------------------------------------- model status */

function paintModel(model) {
  const state = model?.state ?? 'idle';
  el.dot.dataset.state = state;
  el.chip.title = model?.detail ?? '';
  if (state === 'ready' || state === 'external') {
    el.modelText.textContent = state === 'external' ? '模型已就绪（复用现有服务）' : '模型已就绪';
  } else if (state === 'starting' || state === 'probing' || state === 'idle') {
    el.modelText.textContent = model?.detail ?? '检测模型服务…';
  } else {
    el.modelText.textContent = '模型未就绪';
  }
}

async function refreshStatus() {
  try {
    const res = await fetch('./api/status');
    const { model } = await res.json();
    paintModel(model);
    return model;
  } catch {
    el.dot.dataset.state = 'error';
    el.modelText.textContent = '无法连接本地服务';
    return null;
  }
}

function watchModel() {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    const model = await refreshStatus();
    if (model && (model.state === 'ready' || model.state === 'external')) {
      clearInterval(pollTimer);
      pollTimer = setInterval(refreshStatus, 15_000);
    }
  }, 1500);
}

async function startModel() {
  setStatus('正在启动模型…');
  showNotice('正在拉起 llama-server，首次加载需要几秒…', 'info');
  try {
    const res = await fetch('./api/model/start', { method: 'POST' });
    const body = await res.json();
    paintModel(body.model);
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    hideNotice();
    setStatus('模型就绪');
  } catch (err) {
    const detail = String(err.message ?? err);
    paintModel({ state: 'error', detail });
    showNotice(detail, 'warn', { label: '重试启动', run: startModel });
    setStatus('模型未就绪');
  }
  watchModel();
}

/* ------------------------------------------------------- endpoints/modes */

function paintConn() {
  el.connEndpoint.value = endpoint;
  el.connKey.value = apiKey;
  el.connHint.textContent = `直连模式不会经过任何中间服务器，浏览器直接把请求发往 ${endpoint}/v1/chat/completions。`;
}

function saveConn() {
  endpoint = el.connEndpoint.value.trim().replace(/\/+$/, '') || DEFAULT_ENDPOINT;
  apiKey = el.connKey.value.trim();
  try {
    localStorage.setItem(CONN_KEY, JSON.stringify({ endpoint, apiKey }));
  } catch { /* private mode: keep it in memory only */ }
  paintConn();
  setStatus('连接设置已保存');
}

const STATIC_HELP = 'https 页面无法访问 http://127.0.0.1：浏览器会按本地网络访问策略直接拦截，现象是 Failed to fetch。\n'
  + '本地模型请用本地模式 cd webapp && npm start；要用这个页面，端点必须是 HTTPS 公网地址。';

/** Single wording for every "the browser could not reach your endpoint" path. */
function showStaticFailure(detail) {
  showNotice(`${detail}\n${STATIC_HELP}`, 'warn', { label: '测试连接', run: testConn });
}

async function testConn() {
  saveConn();
  setStatus('正在测试连接…');
  const started = Date.now();
  try {
    const res = await fetch(`${endpoint}/v1/models`, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    el.dot.dataset.state = 'external';
    el.modelText.textContent = '模型已就绪（直连）';
    hideNotice();
    setStatus(`连接成功 · ${Date.now() - started}ms`);
  } catch (err) {
    el.dot.dataset.state = 'error';
    el.modelText.textContent = '连接失败';
    showStaticFailure(`无法连接 ${endpoint}：${String(err.message ?? err)}`);
    setStatus('连接失败');
  }
}

/* -------------------------------------------------------------- translate */

const currentKey = () => `${el.target.value}|${el.mdToggle.checked ? 'md' : 'plain'}|${el.source.value}`;

function scheduleAuto() {
  clearTimeout(pendingTimer);
  const r = paint();
  if (r.empty || r.over) return;
  pendingTimer = setTimeout(() => {
    if (currentKey() !== lastKey) translate();
  }, AUTO_DEBOUNCE_MS);
}

/** Streams one translation, whichever mode we are in. */
async function runRequest({ text, target, mode, signal, onDelta }) {
  const lang = LANGUAGES.find((l) => l.code === target) ?? LANGUAGES[0];

  if (appMode === 'static') {
    const t0 = Date.now();
    let ttft = null;
    const { chars } = await streamTranslation({
      url: `${endpoint}/v1/chat/completions`,
      prompt: buildPrompt({ text, lang, mode }),
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal,
      onDelta: (delta) => {
        ttft ??= Date.now() - t0;
        onDelta(delta);
      },
    });
    return { chars, ms: Date.now() - t0, ttft };
  }

  const res = await fetch('./api/translate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, target, mode }),
    signal,
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    paintModel(payload.model);
    throw Object.assign(new Error(payload.error ?? `HTTP ${res.status}`), { needsModel: res.status === 503 });
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let stats = null;

  while (!stats) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      const name = frame.match(/^event:\s*(.+)$/m)?.[1]?.trim();
      const dataLine = frame.match(/^data:\s*(.+)$/m)?.[1];
      if (!name || !dataLine) continue;
      const data = JSON.parse(dataLine);
      if (name === 'delta') onDelta(data.text);
      else if (name === 'done') stats = data;
      else if (name === 'error') throw new Error(data.message ?? '翻译失败');
    }
  }
  if (!stats) throw new Error('连接中断，未收到完成信号');
  return stats;
}

async function translate() {
  clearTimeout(pendingTimer);
  const text = el.source.value;
  const r = report();
  if (r.empty || r.over) { showNotice(rejection(r)); return; }
  if (ctrl) ctrl.abort();

  const key = currentKey();
  const mode = el.mdToggle.checked ? 'markdown' : 'plain';
  const target = el.target.value;

  ctrl = new AbortController();
  el.cancelBtn.hidden = false;
  el.translateBtn.disabled = true;
  el.output.dataset.busy = '1';
  el.output.setAttribute('aria-busy', 'true');
  el.outBlank.hidden = true;
  el.output.replaceChildren();
  const span = document.createElement('span');
  el.output.append(span);
  el.seal.classList.remove('is-on');
  el.copyBtn.disabled = true;
  el.downloadBtn.disabled = true;
  resultText = '';
  el.dstStat.textContent = '—';
  el.dstMeta.textContent = '';
  setStatus(`正在翻译为 ${el.target.selectedOptions[0]?.dataset.zh ?? target}…`);
  hideNotice();

  try {
    const stats = await runRequest({
      text, target, mode,
      signal: ctrl.signal,
      onDelta: (delta) => {
        resultText += delta;
        span.append(document.createTextNode(delta));
        el.dstStat.textContent = `${countChars(resultText)} 字符`;
        el.output.scrollTop = el.output.scrollHeight;
      },
    });

    if (resultText.length === 0) throw new Error('模型没有返回任何内容，请重试。');
    lastKey = key;
    el.dstStat.textContent = `${countChars(resultText)} 字符`;
    el.dstMeta.textContent = `${(stats.ms / 1000).toFixed(1)}s` + (stats.ttft ? ` · 首字 ${stats.ttft}ms` : '');
    el.seal.classList.add('is-on');
    resultMode = mode;
    el.copyBtn.disabled = false;
    el.downloadBtn.disabled = false;
    setStatus(`已译 · ${el.target.selectedOptions[0]?.textContent ?? target}`);
  } catch (err) {
    if (err.name === 'AbortError') {
      setStatus('已停止');
    } else {
      lastKey = null;
      const message = String(err.message ?? err);
      if (err.needsModel) showNotice(message, 'warn', { label: '启动模型', run: startModel });
      else if (appMode === 'static') showStaticFailure(`直连 ${endpoint} 失败：${message}`);
      else showNotice(message);
      setStatus('出错');
    }
  } finally {
    ctrl = null;
    el.cancelBtn.hidden = true;
    delete el.output.dataset.busy;
    el.output.setAttribute('aria-busy', 'false');
    if (resultText.length > 0) {
      el.copyBtn.disabled = false;
      el.downloadBtn.disabled = false;
    }
    paint();
  }
}

/* ------------------------------------------------------------- file input */

async function decodeFile(file) {
  const buf = await file.arrayBuffer();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    // Windows-exported .txt is often GBK; browsers ship that decoder.
    try { return new TextDecoder('gbk').decode(buf); }
    catch { return new TextDecoder('utf-8').decode(buf); }
  }
}

async function importFile(file) {
  const name = file.name.toLowerCase();
  const ext = ACCEPTED.find((e) => name.endsWith(e));
  if (!ext) {
    showNotice(`仅支持 ${ACCEPTED.join(' / ')} 文件，收到「${file.name}」。`);
    setStatus('已拒绝该文件');
    return;
  }
  if (file.size > MAX_FILE_BYTES) {
    showNotice(`文件过大（${(file.size / 1024 / 1024).toFixed(1)} MB），上限 2 MB。`);
    return;
  }

  const text = await decodeFile(file);
  const isMd = ext === '.md' || ext === '.markdown';
  el.mdToggle.checked = isMd;
  el.source.value = text;

  const r = paint();
  el.fileHint.textContent = `已导入 ${file.name}（${r.chars} 字符 · ${r.han} 汉字）`;

  if (r.over) {
    showNotice(`「${file.name}」共 ${r.chars} 字符，超出上限 ${r.chars - r.max} 字符。请精简后再翻译——不会自动截断。`);
    setStatus('超出长度上限');
    return;
  }
  translate();
}

/* ---------------------------------------------------------------- exports */

function download() {
  if (!resultText) return;
  const md = resultMode === 'markdown';
  const blob = new Blob([resultText], { type: md ? 'text/markdown;charset=utf-8' : 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `translation-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.${md ? 'md' : 'txt'}`;
  document.body.append(a);
  a.click();
  // Revoking the object URL too early can cancel the download before the
  // browser has read the blob, so hold it for a minute.
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 60_000);
}

/* ------------------------------------------------------------------ wiring */

el.importBtn.addEventListener('click', () => el.fileInput.click());
el.fileInput.addEventListener('change', () => {
  const file = el.fileInput.files?.[0];
  el.fileInput.value = '';
  if (file) importFile(file);
});

el.source.addEventListener('input', scheduleAuto);
el.source.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); translate(); }
});
el.target.addEventListener('change', () => { lastKey = null; scheduleAuto(); });
el.mdToggle.addEventListener('change', () => { lastKey = null; scheduleAuto(); });
el.translateBtn.addEventListener('click', () => { clearTimeout(pendingTimer); translate(); });
el.cancelBtn.addEventListener('click', () => ctrl?.abort());
el.clearBtn.addEventListener('click', () => {
  ctrl?.abort();
  el.source.value = '';
  el.output.replaceChildren();
  el.outBlank.hidden = false;
  el.output.append(el.outBlank);
  resultText = '';
  lastKey = null;
  el.seal.classList.remove('is-on');
  el.dstStat.textContent = '—';
  el.dstMeta.textContent = '';
  el.copyBtn.disabled = true;
  el.downloadBtn.disabled = true;
  el.fileHint.textContent = '或直接拖入窗口 / 粘贴文本';
  hideNotice();
  setStatus('就绪');
  paint();
  el.source.focus();
});

el.connSave.addEventListener('click', saveConn);
el.connTest.addEventListener('click', testConn);

el.copyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(resultText);
    setStatus('译文已复制到剪贴板');
  } catch {
    showNotice('浏览器拒绝了剪贴板访问，请手动选择译文复制。');
  }
});
el.downloadBtn.addEventListener('click', download);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && ctrl) ctrl.abort();
});

/* drag & drop over the whole window */
let dragDepth = 0;
const hasFiles = (e) => Array.from(e.dataTransfer?.types ?? []).includes('Files');

function showVeil() { el.veil.hidden = false; }
function hideVeil() { dragDepth = 0; el.veil.hidden = true; }

window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth += 1;
  showVeil();
});
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('dragleave', (e) => {
  if (!hasFiles(e) && e.relatedTarget !== null) return;
  dragDepth -= 1;
  // relatedTarget === null means the pointer left the window entirely: the
  // browser owes us no further dragleave, so reset instead of trusting the count.
  if (dragDepth <= 0 || e.relatedTarget === null) hideVeil();
});
window.addEventListener('dragend', hideVeil);
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) { hideVeil(); return; }
  e.preventDefault();
  const file = e.dataTransfer.files?.[0];
  hideVeil();
  if (file) importFile(file);
});

/* ------------------------------------------------------------------- boot */

function fillTargets(defaultTarget) {
  el.target.replaceChildren(...LANGUAGES.map((l) => {
    const opt = document.createElement('option');
    opt.value = l.code;
    opt.textContent = `${l.zh} · ${l.en}`;
    opt.dataset.zh = l.zh;
    if (l.code === defaultTarget) opt.selected = true;
    return opt;
  }));
}

(async function boot() {
  try {
    const stored = JSON.parse(localStorage.getItem(CONN_KEY) ?? 'null');
    if (stored?.endpoint) endpoint = stored.endpoint;
    if (stored?.apiKey) apiKey = stored.apiKey;
  } catch { /* ignore malformed storage */ }

  let cfg = null;
  try {
    const res = await fetch('./api/config');
    if (res.ok) cfg = await res.json();
  } catch { /* no backend */ }

  if (cfg) {
    appMode = 'local';
    el.modeChip.textContent = '本地模式 · 自带模型服务';
    el.conn.hidden = true;
    maxChars = cfg.maxChars;
    el.limitChip.textContent = maxChars;
    el.blankLimit.textContent = maxChars;
    fillTargets(cfg.defaultTarget);
    paintModel(cfg.model);
    if (cfg.model?.state !== 'ready' && cfg.model?.state !== 'external') watchModel();
  } else {
    appMode = 'static';
    el.modeChip.textContent = '直连模式 · 浏览器直连端点';
    el.dot.dataset.state = apiKey || endpoint !== DEFAULT_ENDPOINT ? 'external' : 'idle';
    el.modelText.textContent = '直连端点（未测试）';
    el.limitChip.textContent = maxChars;
    el.blankLimit.textContent = maxChars;
    fillTargets('en');
    paintConn();
    el.conn.hidden = false;
    showNotice(
      '这是静态托管版本：没有后端。请填入一个能从本页访问的 OpenAI 兼容端点。\n'
      + '· 本地模型请改用本地模式：cd webapp && npm start（浏览器会拦截 https 页面对 http://127.0.0.1 的请求）；\n'
      + '· 想在这个页面上直接用远端模型，端点必须是 HTTPS 公网地址。',
      'info',
    );
    setStatus('等待配置端点');
  }

  paint();
  el.source.focus();
})();
