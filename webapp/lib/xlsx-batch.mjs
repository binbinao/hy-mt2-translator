/**
 * Dependency-free XLSX batch translation.
 *
 * The reader parses the OOXML ZIP package directly. Translation rewrites only
 * string cells in their original worksheets, preserving formulas, styles,
 * images and unrelated sheets.
 */
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import path from 'node:path';

import {
  CsvBatchError,
  MAX_BATCH_CELLS,
  MAX_CELL_CHARS,
  MAX_BATCH_CHARS,
  buildBatchPrompt,
  detectTranslatableColumns,
  looksLikeText,
  normalizeGlossary,
  protectTokens,
  restoreTokens,
} from './csv-batch.mjs';
import { countChars } from '../public/limit.mjs';
import { streamTranslation } from '../public/translate.mjs';

const LOCAL_FILE = 0x04034b50;
const CENTRAL_FILE = 0x02014b50;
const END_OF_CENTRAL = 0x06054b50;
const MAX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;

let crcTable = null;

function makeCrcTable() {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[i] = value >>> 0;
  }
  return table;
}

function crc32(buffer) {
  crcTable ??= makeCrcTable();
  let value = 0xffffffff;
  for (const byte of buffer) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function findEndOfCentral(buffer) {
  const start = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= start; offset -= 1) {
    if (buffer.readUInt32LE(offset) === END_OF_CENTRAL) return offset;
  }
  throw new CsvBatchError('不是合法的 XLSX 文件：找不到 ZIP 中央目录');
}

export function readZip(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) throw new CsvBatchError('XLSX 文件为空或损坏');
  const end = findEndOfCentral(buffer);
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const entries = [];
  const map = new Map();

  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(offset) !== CENTRAL_FILE) throw new CsvBatchError('XLSX ZIP 中央目录损坏');
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength).replace(/^\/+/, '');

    if (flags & 1) throw new CsvBatchError('不支持加密的 XLSX 文件');
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      throw new CsvBatchError('暂不支持 ZIP64 XLSX 文件');
    }
    if (uncompressedSize > MAX_UNCOMPRESSED_BYTES) {
      throw new CsvBatchError(`XLSX 解压后条目超过 ${MAX_UNCOMPRESSED_BYTES / 1024 / 1024} MB`);
    }
    if (buffer.readUInt32LE(localOffset) !== LOCAL_FILE) throw new CsvBatchError(`XLSX 条目损坏：${name}`);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    let data;
    if (method === 0) data = Buffer.from(compressed);
    else if (method === 8) data = inflateRawSync(compressed);
    else throw new CsvBatchError(`XLSX 使用了不支持的压缩方式：${method}`);
    if (data.length !== uncompressedSize) throw new CsvBatchError(`XLSX 条目大小不一致：${name}`);

    const entry = { name, data };
    entries.push(entry);
    map.set(name, entry);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return { entries, map };
}

export function writeZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const dosTime = 0;
  const dosDate = (1 << 5) | 1;

  for (const entry of entries) {
    const name = Buffer.from(entry.name.replace(/^\/+/, ''), 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const compressed = deflateRawSync(data);
    const useDeflate = compressed.length < data.length;
    const method = useDeflate ? 8 : 0;
    const payload = useDeflate ? compressed : data;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_FILE, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    chunks.push(local, name, payload);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(CENTRAL_FILE, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt16LE(dosTime, 12);
    header.writeUInt16LE(dosDate, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(payload.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);
    offset += local.length + name.length + payload.length;
  }

  const centralOffset = offset;
  const centralSize = central.reduce((sum, item) => sum + item.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([...chunks, ...central, end]);
}

function decodeXml(text) {
  return String(text)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => String.fromCodePoint(Number.parseInt(num, 10)))
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function escapeXml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function attr(tag, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = tag.match(new RegExp(`\\s${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`));
  return match ? decodeXml(match[1] ?? match[2] ?? '') : null;
}

function textContent(xml) {
  const values = [];
  for (const match of xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) values.push(decodeXml(match[1]));
  return values.join('');
}

function columnIndex(letters) {
  let value = 0;
  for (const ch of letters.toUpperCase()) value = (value * 26) + (ch.charCodeAt(0) - 64);
  return value - 1;
}

function columnName(index) {
  let value = index + 1;
  let name = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

function parseRef(ref) {
  const match = /^([A-Z]+)(\d+)$/i.exec(ref);
  if (!match) return null;
  return { column: columnIndex(match[1]), row: Number.parseInt(match[2], 10) - 1 };
}

function normalizeTarget(base, target) {
  const clean = String(target).replaceAll('\\', '/').replace(/^\/+/, '');
  const raw = clean.startsWith('xl/') ? clean : `${base}/${clean}`;
  return path.posix.normalize(raw).replace(/^\/+/, '');
}

function relationshipMap(xml) {
  const map = new Map();
  for (const match of xml.matchAll(/<Relationship\b[^>]*\/?>/g)) {
    const id = attr(match[0], 'Id');
    const target = attr(match[0], 'Target');
    if (id && target) map.set(id, target);
  }
  return map;
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  const strings = [];
  for (const match of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) strings.push(textContent(match[1]));
  return strings;
}

function parseSheetCells(xml, sharedStrings) {
  const cells = [];
  for (const rowMatch of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const rowAttrs = rowMatch[1];
    const rowNumber = Number.parseInt(attr(rowAttrs, 'r') ?? '0', 10);
    let lastRow = rowNumber > 0 ? rowNumber - 1 : 0;
    let nextColumn = 0;
    for (const cellMatch of rowMatch[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cellMatch[1];
      const body = cellMatch[2] ?? '';
      const ref = attr(attrs, 'r') ?? `${columnName(nextColumn)}${lastRow + 1}`;
      const parsed = parseRef(ref);
      if (!parsed) continue;
      lastRow = parsed.row;
      nextColumn = parsed.column + 1;
      const type = attr(attrs, 't') ?? '';
      const rawValue = body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/)?.[1] ?? '';
      let value = decodeXml(rawValue);
      if (type === 's') value = sharedStrings[Number.parseInt(rawValue, 10)] ?? '';
      else if (type === 'inlineStr') value = textContent(body.match(/<is\b[^>]*>([\s\S]*?)<\/is>/)?.[1] ?? '');
      else if (type === 'b') value = value === '1' ? 'TRUE' : 'FALSE';
      cells.push({
        ref,
        row: parsed.row,
        column: parsed.column,
        value,
        type,
        formula: /<f\b/.test(body),
      });
    }
  }
  return cells;
}

function matrixFromCells(cells) {
  const rows = cells.reduce((max, cell) => Math.max(max, cell.row + 1), 0);
  const columns = cells.reduce((max, cell) => Math.max(max, cell.column + 1), 0);
  const matrix = Array.from({ length: rows }, () => Array(columns).fill(''));
  for (const cell of cells) matrix[cell.row][cell.column] = cell.value;
  return matrix;
}

function parseWorkbook(buffer) {
  const archive = readZip(buffer);
  const workbookEntry = archive.map.get('xl/workbook.xml');
  const relsEntry = archive.map.get('xl/_rels/workbook.xml.rels');
  if (!workbookEntry || !relsEntry) throw new CsvBatchError('XLSX 缺少 workbook 定义');

  const rels = relationshipMap(relsEntry.data.toString('utf8'));
  const sheets = [];
  for (const match of workbookEntry.data.toString('utf8').matchAll(/<sheet\b[^>]*>/g)) {
    const name = attr(match[0], 'name');
    const id = attr(match[0], 'r:id') ?? attr(match[0], 'id');
    const target = id ? rels.get(id) : null;
    if (!name || !target) continue;
    const sheetPath = normalizeTarget('xl', target);
    const entry = archive.map.get(sheetPath);
    if (!entry) continue;
    sheets.push({ name, path: sheetPath, entry });
  }
  if (sheets.length === 0) throw new CsvBatchError('XLSX 中没有可读取的工作表');

  const sharedStrings = parseSharedStrings(archive.map.get('xl/sharedStrings.xml')?.data.toString('utf8'));
  for (const sheet of sheets) {
    sheet.cells = parseSheetCells(sheet.entry.data.toString('utf8'), sharedStrings);
    sheet.matrix = matrixFromCells(sheet.cells);
  }
  return { archive, sharedStrings, sheets };
}

function resolveSelected(headers, dataRows, requested) {
  if (requested == null) return detectTranslatableColumns([headers, ...dataRows]);
  if (!Array.isArray(requested)) throw new CsvBatchError('columns 必须是字符串或数字数组');
  return headers.map((header, index) => requested.some((item) => item === header || item === index));
}

export function planXlsxBatch({ buffer, columns = null, headerRow = 0 }) {
  const workbook = parseWorkbook(buffer);
  const header = Number.parseInt(headerRow, 10);
  if (!Number.isInteger(header) || header < 0) throw new CsvBatchError('headerRow 必须是非负整数');

  const cells = [];
  const warnings = [];
  const columnsBySheet = {};
  let totalChars = 0;

  for (const sheet of workbook.sheets) {
    if (sheet.matrix.length <= header) {
      warnings.push(`工作表「${sheet.name}」没有表头行，已跳过`);
      columnsBySheet[sheet.name] = [];
      continue;
    }
    const headers = sheet.matrix[header].map((value, index) => value || `column_${index + 1}`);
    const dataRows = sheet.matrix.slice(header + 1);
    const selected = resolveSelected(headers, dataRows, columns);
    columnsBySheet[sheet.name] = headers.filter((_, index) => selected[index]);
    const cellMap = new Map(sheet.cells.map((cell) => [cell.ref, cell]));

    for (let rowIndex = header + 1; rowIndex < sheet.matrix.length; rowIndex += 1) {
      for (let column = 0; column < headers.length; column += 1) {
        if (!selected[column]) continue;
        const ref = `${columnName(column)}${rowIndex + 1}`;
        const cell = cellMap.get(ref);
        if (!cell || cell.formula || typeof cell.value !== 'string' || !looksLikeText(cell.value)) continue;
        const chars = countChars(cell.value);
        if (chars > MAX_CELL_CHARS) {
          warnings.push(`工作表「${sheet.name}」${ref} 超过单格上限，已保留原文`);
          continue;
        }
        totalChars += chars;
        if (totalChars > MAX_BATCH_CHARS) throw new CsvBatchError('批次总字符数超过 20000，请拆分文件', 413);
        cells.push({
          sheetName: sheet.name,
          sheetPath: sheet.path,
          ref,
          rowIndex,
          column,
          rowNumber: rowIndex + 1,
          header: headers[column],
          source: cell.value,
          type: cell.type,
        });
      }
    }
  }

  if (cells.length === 0) throw new CsvBatchError('没有找到需要翻译的单元格');
  if (cells.length > MAX_BATCH_CELLS) throw new CsvBatchError(`单次最多翻译 ${MAX_BATCH_CELLS} 个单元格，请拆分文件`, 413);
  return { workbook, headerRow: header, cells, warnings, columns: columnsBySheet };
}

function formatReport({ report, plan, translated, kept }) {
  return {
    format: 'xlsx',
    columns: Object.entries(plan.columns).map(([sheet, columns]) => `${sheet}: ${columns.join('、') || '无'}`),
    total: report.length,
    translated,
    kept,
    warnings: plan.warnings,
    cells: report,
  };
}

async function translateCell({ url, headers, glossary, lang, source }) {
  let output = '';
  await streamTranslation({
    url,
    headers,
    prompt: buildBatchPrompt({ text: source, lang, glossary }),
    onDelta: (delta) => { output += delta; },
  });
  return output.trim();
}

function replaceSheetStrings(xml, updates, sharedStrings, sharedState) {
  return xml.replace(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g, (match, attrs, body = '') => {
    const ref = attr(attrs, 'r');
    if (!ref || !updates.has(ref)) return match;
    const translated = escapeXml(updates.get(ref));
    const type = attr(attrs, 't') ?? '';
    if (type === 's') {
      const index = sharedStrings.push(translated) - 1;
      sharedState.changed = true;
      return `<c${attrs}><v>${index}</v></c>`;
    }
    if (type === 'inlineStr') {
      return `<c${attrs}><is><t xml:space="preserve">${translated}</t></is></c>`;
    }
    if (type === 'str') return `<c${attrs}><v>${translated}</v></c>`;
    const nextAttrs = attrs.replace(/\st="[^"]*"/, '');
    return `<c${nextAttrs} t="inlineStr"><is><t xml:space="preserve">${translated}</t></is></c>`;
  });
}

function serializeSharedStrings(strings) {
  const items = strings.map((value) => `<si><t xml:space="preserve">${escapeXml(value)}</t></si>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${items}</sst>`;
}

function applyUpdates(workbook, translated) {
  const updatesBySheet = new Map();
  for (const [ref, value] of translated) {
    const cell = workbook.plan.cells.find((item) => `${item.sheetPath}!${item.ref}` === ref);
    if (!cell) continue;
    if (!updatesBySheet.has(cell.sheetPath)) updatesBySheet.set(cell.sheetPath, new Map());
    updatesBySheet.get(cell.sheetPath).set(cell.ref, value);
  }

  const sharedStrings = [...workbook.sharedStrings];
  const sharedState = { changed: false };
  const replacements = new Map();
  for (const [sheetPath, updates] of updatesBySheet) {
    const entry = workbook.archive.map.get(sheetPath);
    replacements.set(sheetPath, replaceSheetStrings(entry.data.toString('utf8'), updates, sharedStrings, sharedState));
  }
  if (sharedState.changed) {
    replacements.set('xl/sharedStrings.xml', serializeSharedStrings(sharedStrings));
  }
  const entries = workbook.archive.entries.map((entry) => (
    replacements.has(entry.name)
      ? { name: entry.name, data: Buffer.from(replacements.get(entry.name), 'utf8') }
      : entry
  ));
  return writeZip(entries);
}

export async function translateXlsxPlan({
  plan,
  glossary,
  lang,
  url,
  headers = {},
  concurrency = 2,
}) {
  const terms = normalizeGlossary(glossary);
  const report = [];
  const translatedValues = new Map();
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
        translatedValues.set(`${cell.sheetPath}!${cell.ref}`, restored.text);
        report.push({ ...cell, translated: restored.text, status: 'translated' });
      } catch (err) {
        report.push({ ...cell, translated: cell.source, status: 'error', warning: String(err.message ?? err) });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, plan.cells.length)) }, worker));
  const translated = report.filter((item) => item.status === 'translated').length;
  for (const cell of report) {
    if (cell.status === 'translated') {
      const sheet = plan.workbook.sheets.find((item) => item.name === cell.sheetName);
      if (sheet) sheet.matrix[cell.rowIndex][cell.column] = cell.translated;
    }
  }
  const workbook = { plan, archive: plan.workbook.archive, sharedStrings: plan.workbook.sharedStrings };
  const output = applyUpdates(workbook, translatedValues);
  const previewRows = [];
  for (const sheet of plan.workbook.sheets) {
    previewRows.push([`# ${sheet.name}`]);
    for (const row of sheet.matrix) previewRows.push(row);
    previewRows.push([]);
  }
  const preview = previewRows.map((row) => row.map((value) => {
    const text = String(value ?? '');
    return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  }).join(',')).join('\n');
  return {
    buffer: output,
    previewCsv: preview,
    report: formatReport({ report, plan, translated, kept: report.length - translated }),
  };
}
