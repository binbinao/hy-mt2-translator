/**
 * Length policy for the translation desk.
 *
 * The budget is counted in Unicode code points (so an emoji or a rare
 * ideograph costs exactly 1). 2000 code points is the same budget as
 * "2000 汉字" for Chinese input, and keeps any other input bounded too.
 *
 * This module is the single source of truth for the limit: the browser
 * imports it from `/limit.mjs`, the server imports the same file from
 * disk, so the two can never disagree.
 */

export const MAX_CHARS = 2000;

const HAN = /\p{Script=Han}/u;

/** Code points, not UTF-16 units: counts astral characters as one. */
export function countChars(text) {
  let n = 0;
  for (const _ of text) n += 1;
  return n;
}

/** Ideographs only — CJK punctuation (，。！) is not a 汉字. */
export function countHan(text) {
  let n = 0;
  for (const ch of text) if (HAN.test(ch)) n += 1;
  return n;
}

/**
 * @returns {{chars: number, han: number, max: number, remaining: number,
 *            over: boolean, empty: boolean, ok: boolean}}
 */
export function measure(text, max = MAX_CHARS) {
  const chars = countChars(text);
  const han = countHan(text);
  const over = chars > max;
  return { chars, han, max, remaining: max - chars, over, empty: chars === 0, ok: chars > 0 && !over };
}

/** Stable, human-readable reason an input may not be translated. */
export function rejection(report) {
  if (report.empty) return '请输入或导入需要翻译的内容。';
  if (report.over) return `超出上限 ${report.chars - report.max} 字符（当前 ${report.chars} / 上限 ${report.max}），请精简后再翻译。`;
  return null;
}
