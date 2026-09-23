/**
 * Structured CSV translation for catalog and master-data workflows.
 *
 * This module deliberately stays dependency-free: it parses/serializes CSV,
 * identifies likely text columns, protects machine-readable tokens, and
 * translates only the cells that need language work.
 */
import { countChars } from '../public/limit.mjs';
import { streamTranslation } from '../public/translate.mjs';

export const MAX_BATCH_CELLS = 200;
export const MAX_CELL_CHARS = 2000;
export const MAX_BATCH_CHARS = 20_000;

const TEXT_HEADER = /(name|title|description|summary|label|caption|message|content|text|备注|名称|标题|描述|说明|内容)/i;
const IDENTIFIER_HEADER = /(^|[\s_-])(id|sku|code|url|uri|link|email|phone|mobile|price|amount|currency|qty|quantity|count|date|time|timestamp|uuid|guid|hash|path|image|img|slug|status|state)([\s_-]|$)/i;
const PROTECTED_TOKEN = /(\{\{[^{}\n]+\}\}|\$\{[^{}\n]+\}|%[sdif]|\{[A-Za-z_][\w.]*\}|<[^>\n]+>|https?:\/\/[^\s]+|[\w.+-]+@[\w.-]+\.\w+)/g;
const NUMERIC = /^[-+]?(?:\d+(?:[.,]\d+)?|\.\d+)$/;
const DATE_LIKE = /^\d{4}[-/.]\d{1,2}(?:[-/.]\d{1,2})?(?:[T\s].*)?$/;

export class CsvBatchError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'CsvBatchError';
    this.status = status;
  }
}

function assertString(value, name) {
  if (typeof value !== 'string') throw new CsvBatchError(`${name} 必须是字符串`);
  return value;
}

export function inferDelimiter(text) {
  const line = text.split(/\r?\n/).find((row) => row.trim()) ?? '';
  const candidates = [',', '\t', ';'];
  let best = ',';
  let bestCount = -1;
  for (const candidate of candidates) {
    let count = 0;
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === '"') quoted = !quoted;
      else if (!quoted && ch === candidate) count += 1;
    }
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

export function parseCsv(text, delimiter = inferDelimiter(text)) {
  assertString(text, 'csv');
  if (text.length === 0) throw new CsvBatchError('CSV 内容为空');

  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }

  if (quoted) throw new CsvBatchError('CSV 中存在未闭合的引号');
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function serializeCsv(rows, delimiter = ',') {
  const escape = (value) => {
    const text = value == null ? '' : String(value);
    return text.includes(delimiter) || /["\r\n]/.test(text)
      ? `"${text.replaceAll('"', '""')}"`
      : text;
  };
  return rows.map((row) => row.map(escape).join(delimiter)).join('\n');
}

function hasCjk(text) {
  return /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(text);
}

function looksLikeIdentifier(value) {
  const text = value.trim();
  if (!text) return true;
  if (NUMERIC.test(text) || DATE_LIKE.test(text)) return true;
  if (/^(?:https?:\/\/|mailto:)/i.test(text)) return true;
  if (/^[\w.+-]+@[\w.-]+\.\w+$/.test(text)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(text)) return true;
  if (/^[A-Z0-9][A-Z0-9._/-]{3,}$/.test(text) && /\d/.test(text) && !hasCjk(text)) return true;
  if (!/\s/.test(text) && /[_/\\:[\]{}()]/.test(text) && /\d/.test(text) && !hasCjk(text)) return true;
  return false;
}

function looksLikeText(value) {
  const text = value.trim();
  if (text.length < 2 || looksLikeIdentifier(text)) return false;
  const letters = Array.from(text).filter((ch) => /\p{L}/u.test(ch)).length;
  if (letters < 2) return false;
  return hasCjk(text) || /\s/.test(text) || text.length >= 8;
}

export function detectTranslatableColumns(rows) {
  const headers = rows[0] ?? [];
  const width = Math.max(...rows.map((row) => row.length), headers.length);
  return Array.from({ length: width }, (_, index) => {
    const header = String(headers[index] ?? `column_${index + 1}`).trim();
    if (IDENTIFIER_HEADER.test(header)) return false;
    if (TEXT_HEADER.test(header)) return true;
    const values = rows.slice(1).map((row) => row[index]).filter((value) => String(value ?? '').trim());
    if (values.length === 0) return false;
    const textCount = values.filter((value) => looksLikeText(String(value))).length;
    return textCount / values.length >= 0.3;
  });
}

function normalizeHeaders(rows) {
  const headers = (rows[0] ?? []).map((value, index) => {
    const header = String(value ?? '').trim();
    return header || `column_${index + 1}`;
  });
  const seen = new Map();
  return headers.map((header) => {
    const count = (seen.get(header) ?? 0) + 1;
    seen.set(header, count);
    return count === 1 ? header : `${header}_${count}`;
  });
}

function resolveColumns(headers, requested) {
  if (requested == null) return detectTranslatableColumns([headers]);
  if (!Array.isArray(requested)) throw new CsvBatchError('columns 必须是字符串或数字数组');
  return headers.map((header, index) => requested.some((item) => item === header || item === index));
}

export function planCsvBatch({ csv, columns = null, delimiter = null }) {
  const text = assertString(csv, 'csv');
  const separator = delimiter ?? inferDelimiter(text);
  if (![',', '\t', ';'].includes(separator)) throw new CsvBatchError('仅支持逗号、分号或制表符分隔的 CSV');

  const rows = parseCsv(text, separator);
  if (rows.length < 2) throw new CsvBatchError('CSV 至少需要表头和一行数据');
  const headers = normalizeHeaders(rows);
  const dataRows = rows.slice(1).map((row) => Array.from({ length: headers.length }, (_, index) => row[index] ?? ''));
  const selected = resolveColumns(headers, columns);
  if (!selected.some(Boolean)) throw new CsvBatchError('没有识别到可翻译列，请通过 columns 明确指定');

  const cells = [];
  const warnings = [];
  let totalChars = 0;
  for (let rowIndex = 0; rowIndex < dataRows.length; rowIndex += 1) {
    for (let column = 0; column < headers.length; column += 1) {
      if (!selected[column]) continue;
      const source = dataRows[rowIndex][column];
      if (!looksLikeText(source)) continue;
      const chars = countChars(source);
      if (chars > MAX_CELL_CHARS) {
        warnings.push(`第 ${rowIndex + 2} 行「${headers[column]}」超过单格上限，已保留原文`);
        continue;
      }
      totalChars += chars;
      if (totalChars > MAX_BATCH_CHARS) throw new CsvBatchError('批次总字符数超过 20000，请拆分文件', 413);
      cells.push({ rowIndex, column, rowNumber: rowIndex + 2, header: headers[column], source });
    }
  }
  if (cells.length === 0) throw new CsvBatchError('没有找到需要翻译的单元格');
  if (cells.length > MAX_BATCH_CELLS) throw new CsvBatchError(`单次最多翻译 ${MAX_BATCH_CELLS} 个单元格，请拆分文件`, 413);

  return { headers, dataRows, selected, cells, warnings, delimiter: separator };
}

export function protectTokens(text) {
  const tokens = [];
  const protectedText = text.replace(PROTECTED_TOKEN, (token) => {
    const marker = `__HY_MT2_TOKEN_${tokens.length}__`;
    tokens.push(token);
    return marker;
  });
  return { text: protectedText, tokens };
}

export function restoreTokens(text, tokens) {
  const missing = [];
  let restored = text;
  tokens.forEach((token, index) => {
    const marker = `__HY_MT2_TOKEN_${index}__`;
    if (!restored.includes(marker)) {
      missing.push(token);
      return;
    }
    restored = restored.replaceAll(marker, token);
  });
  return { text: restored, missing };
}

function normalizeGlossary(glossary) {
  if (glossary == null) return [];
  if (!Array.isArray(glossary)) throw new CsvBatchError('glossary 必须是数组');
  if (glossary.length > 50) throw new CsvBatchError('术语表最多 50 条');
  return glossary.map((entry) => {
    if (!entry || typeof entry.source !== 'string' || typeof entry.target !== 'string') {
      throw new CsvBatchError('glossary 每项必须包含 source 和 target 字符串');
    }
    const source = entry.source.trim();
    const target = entry.target.trim();
    if (!source || !target || source.length > 200 || target.length > 200) {
      throw new CsvBatchError('术语表条目长度必须在 1 到 200 字符之间');
    }
    return { source, target };
  });
}

function buildCsvPrompt({ text, lang, glossary }) {
  const base = lang.script === 'hans'
    ? `将以下文本翻译为 ${lang.zh}，注意只需要输出翻译后的结果，不要额外解释：\n\n${text}`
    : `Translate the following text into ${lang.en}. Note that you should only output the translated result without any additional explanation:\n\n${text}`;
  if (glossary.length === 0) return base;
  const lines = glossary.map(({ source, target }) => `${source} => ${target}`).join('\n');
  return lang.script === 'hans'
    ? `参考下面的翻译：\n${lines}\n\n${base}`
    : `Reference the following translations:\n${lines}\n\n${base}`;
}

async function translateCell({ url, headers, glossary, lang, source }) {
  let output = '';
  await streamTranslation({
    url,
    headers,
    prompt: buildCsvPrompt({ text: source, lang, glossary }),
    onDelta: (delta) => { output += delta; },
  });
  return output.trim();
}

export async function translateCsvBatch({
  csv,
  columns,
  delimiter,
  glossary,
  lang,
  url,
  headers = {},
  concurrency = 2,
}) {
  const plan = planCsvBatch({ csv, columns, delimiter });
  const terms = normalizeGlossary(glossary);
  const report = [];
  let cursor = 0;

  async function worker() {
    while (cursor < plan.cells.length) {
      const cell = plan.cells[cursor];
      cursor += 1;
      const guarded = protectTokens(cell.source);
      try {
        const raw = await translateCell({
          url,
          headers,
          glossary: terms,
          lang,
          source: guarded.text,
        });
        const restored = restoreTokens(raw, guarded.tokens);
        if (!raw) {
          report.push({ ...cell, translated: cell.source, status: 'kept', warning: '模型返回空结果' });
          continue;
        }
        if (restored.missing.length > 0) {
          report.push({ ...cell, translated: cell.source, status: 'kept', warning: `占位符丢失：${restored.missing.join(', ')}` });
          continue;
        }
        plan.dataRows[cell.rowIndex][cell.column] = restored.text;
        report.push({ ...cell, translated: restored.text, status: 'translated' });
      } catch (err) {
        report.push({ ...cell, translated: cell.source, status: 'error', warning: String(err.message ?? err) });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, plan.cells.length)) }, worker));
  const translated = report.filter((item) => item.status === 'translated').length;
  const kept = report.length - translated;
  return {
    csv: serializeCsv([plan.headers, ...plan.dataRows], plan.delimiter),
    report: {
      delimiter: plan.delimiter,
      columns: plan.headers.filter((_, index) => plan.selected[index]),
      total: report.length,
      translated,
      kept,
      warnings: plan.warnings,
      cells: report,
    },
  };
}
