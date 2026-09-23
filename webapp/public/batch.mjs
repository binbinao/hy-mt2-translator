import { LANGUAGES } from './languages.mjs';

const $ = (id) => document.getElementById(id);
const input = $('batchInput');
const output = $('batchOutput');
const target = $('batchTarget');
const runButton = $('batchRun');
const downloadButton = $('batchDownload');

let sourceFormat = 'csv';
let sourceBase64 = null;
let resultFormat = 'csv';
let resultBase64 = null;
let localMode = false;

target.replaceChildren(...LANGUAGES.map((lang) => {
  const option = document.createElement('option');
  option.value = lang.code;
  option.textContent = `${lang.zh} · ${lang.en}`;
  if (lang.code === 'en') option.selected = true;
  return option;
}));

function rowCount(text) {
  return text.trim() ? text.trim().split(/\r?\n/).length : 0;
}

function paintInput() {
  $('batchInputStat').textContent = `${rowCount(input.value)} 行`;
}

function setStatus(text, state = 'idle') {
  $('batchMessage').textContent = text;
  $('batchStatus').querySelector('.chip__dot').dataset.state = state;
  $('batchStatus').querySelector('.chip__text').textContent = text;
}

function setNotice(text) {
  $('batchNotice').textContent = text;
}

function readFileBase64(file) {
  return file.arrayBuffer().then((buffer) => {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
  });
}

function decodeBase64(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function showReport(report) {
  const problemCells = report.cells.filter((cell) => cell.status !== 'translated');
  const lines = [
    `可翻译列：${report.columns.join('、') || '无'}`,
    `翻译单元格：${report.translated}`,
    `保留原文：${report.kept}`,
    ...report.warnings.map((warning) => `批次提示：${warning}`),
    ...problemCells.map((cell) => `第 ${cell.rowNumber} 行「${cell.header}」：${cell.warning}`),
  ];
  $('batchReportText').textContent = lines.join('\n');
  $('batchReport').hidden = false;
}

runButton.addEventListener('click', async () => {
  if (!localMode) {
    setStatus('批量接口仅在本地模式可用', 'error');
    return;
  }
  if (sourceFormat === 'csv' && !input.value.trim()) {
    setStatus('请先粘贴 CSV', 'error');
    return;
  }
  runButton.disabled = true;
  downloadButton.disabled = true;
  setStatus('正在翻译…', 'starting');
  try {
    const body = sourceFormat === 'xlsx'
      ? { data: sourceBase64, target: target.value }
      : { csv: input.value, target: target.value };
    const res = await fetch(sourceFormat === 'xlsx' ? './api/batch/xlsx' : './api/batch/csv', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = await res.json().catch(() => null);
    if (!res.ok) throw new Error(payload?.error ?? `HTTP ${res.status}`);
    if (payload.format === 'xlsx') {
      resultFormat = 'xlsx';
      resultBase64 = payload.data;
      output.value = payload.previewCsv;
    } else {
      resultFormat = 'csv';
      resultBase64 = null;
      output.value = payload.csv;
    }
    $('batchResultStat').textContent = `${payload.report.translated} 格已翻译`;
    showReport(payload.report);
    downloadButton.disabled = false;
    setStatus('翻译完成', 'ready');
  } catch (err) {
    setStatus(String(err.message ?? err), 'error');
  } finally {
    runButton.disabled = !localMode;
  }
});

downloadButton.addEventListener('click', () => {
  const blob = resultFormat === 'xlsx'
    ? new Blob([decodeBase64(resultBase64)], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    })
    : new Blob([output.value], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `translated-${new Date().toISOString().slice(0, 10)}.${resultFormat}`;
  document.body.append(anchor);
  anchor.click();
  setTimeout(() => {
    anchor.remove();
    URL.revokeObjectURL(url);
  }, 60_000);
});

$('batchImport').addEventListener('click', () => $('batchFile').click());
$('batchFile').addEventListener('change', async () => {
  const file = $('batchFile').files?.[0];
  $('batchFile').value = '';
  if (!file) return;
  const name = file.name.toLowerCase();
  try {
    if (name.endsWith('.xlsx')) {
      sourceFormat = 'xlsx';
      sourceBase64 = await readFileBase64(file);
      input.disabled = true;
      input.value = '';
      $('batchFileHint').textContent = `已导入 ${file.name}`;
      $('batchInputStat').textContent = 'Excel';
      setStatus('已导入 Excel', 'ready');
    } else if (name.endsWith('.csv')) {
      sourceFormat = 'csv';
      sourceBase64 = null;
      input.disabled = false;
      input.value = await file.text();
      paintInput();
      $('batchFileHint').textContent = `已导入 ${file.name}`;
      setStatus('已导入 CSV', 'ready');
    } else {
      throw new Error('仅支持 .csv 和 .xlsx 文件');
    }
  } catch (err) {
    setStatus(String(err.message ?? err), 'error');
  }
});

input.addEventListener('input', () => {
  sourceFormat = 'csv';
  sourceBase64 = null;
  output.value = '';
  resultFormat = 'csv';
  resultBase64 = null;
  downloadButton.disabled = true;
  paintInput();
});

(async function boot() {
  try {
    const res = await fetch('./api/config');
    localMode = res.ok;
  } catch {
    localMode = false;
  }
  if (!localMode) {
    input.disabled = true;
    runButton.disabled = true;
    setNotice('批量 CSV / Excel 翻译需要本地模式。静态托管页面没有模型服务，请运行 npm start 后使用。');
    setStatus('需要本地模式', 'error');
  }
})();

paintInput();
