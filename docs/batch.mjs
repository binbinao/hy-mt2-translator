import { LANGUAGES } from './languages.mjs';

const $ = (id) => document.getElementById(id);
const input = $('batchInput');
const output = $('batchOutput');
const target = $('batchTarget');

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

$('batchRun').addEventListener('click', async () => {
  const csv = input.value;
  if (!csv.trim()) {
    setStatus('请先粘贴 CSV', 'error');
    return;
  }
  $('batchRun').disabled = true;
  $('batchDownload').disabled = true;
  setStatus('正在翻译…', 'starting');
  try {
    const res = await fetch('./api/batch/csv', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ csv, target: target.value }),
    });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error ?? `HTTP ${res.status}`);
    output.value = payload.csv;
    $('batchResultStat').textContent = `${payload.report.translated} 格已翻译`;
    showReport(payload.report);
    $('batchDownload').disabled = false;
    setStatus('翻译完成', 'ready');
  } catch (err) {
    setStatus(String(err.message ?? err), 'error');
  } finally {
    $('batchRun').disabled = false;
  }
});

$('batchDownload').addEventListener('click', () => {
  const blob = new Blob([output.value], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `translated-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.append(anchor);
  anchor.click();
  setTimeout(() => {
    anchor.remove();
    URL.revokeObjectURL(url);
  }, 60_000);
});

input.addEventListener('input', paintInput);
paintInput();
