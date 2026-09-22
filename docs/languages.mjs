/**
 * Target languages, transcribed from the "Supported Languages" table of
 * ./README.md. `zh` is the Chinese name and `en` the English name — the
 * prompt language follows the target (see lib/translate.mjs), because the
 * model card requires full language names in the matching language.
 *
 * `script: 'hans'` marks Chinese-script targets; those take the Chinese
 * prompt template, everything else takes the English one.
 */
export const LANGUAGES = [
  { code: 'zh', zh: '中文', en: 'Chinese', script: 'hans' },
  { code: 'zh-Hant', zh: '繁体中文', en: 'Traditional Chinese', script: 'hans' },
  { code: 'yue', zh: '粤语', en: 'Cantonese', script: 'hans' },
  { code: 'en', zh: '英语', en: 'English' },
  { code: 'ja', zh: '日语', en: 'Japanese' },
  { code: 'ko', zh: '韩语', en: 'Korean' },
  { code: 'fr', zh: '法语', en: 'French' },
  { code: 'de', zh: '德语', en: 'German' },
  { code: 'es', zh: '西班牙语', en: 'Spanish' },
  { code: 'pt', zh: '葡萄牙语', en: 'Portuguese' },
  { code: 'it', zh: '意大利语', en: 'Italian' },
  { code: 'ru', zh: '俄语', en: 'Russian' },
  { code: 'uk', zh: '乌克兰语', en: 'Ukrainian' },
  { code: 'pl', zh: '波兰语', en: 'Polish' },
  { code: 'cs', zh: '捷克语', en: 'Czech' },
  { code: 'nl', zh: '荷兰语', en: 'Dutch' },
  { code: 'tr', zh: '土耳其语', en: 'Turkish' },
  { code: 'ar', zh: '阿拉伯语', en: 'Arabic' },
  { code: 'fa', zh: '波斯语', en: 'Persian' },
  { code: 'he', zh: '希伯来语', en: 'Hebrew' },
  { code: 'hi', zh: '印地语', en: 'Hindi' },
  { code: 'bn', zh: '孟加拉语', en: 'Bengali' },
  { code: 'gu', zh: '古吉拉特语', en: 'Gujarati' },
  { code: 'mr', zh: '马拉地语', en: 'Marathi' },
  { code: 'ta', zh: '泰米尔语', en: 'Tamil' },
  { code: 'te', zh: '泰卢固语', en: 'Telugu' },
  { code: 'ur', zh: '乌尔都语', en: 'Urdu' },
  { code: 'th', zh: '泰语', en: 'Thai' },
  { code: 'vi', zh: '越南语', en: 'Vietnamese' },
  { code: 'id', zh: '印尼语', en: 'Indonesian' },
  { code: 'ms', zh: '马来语', en: 'Malay' },
  { code: 'tl', zh: '菲律宾语', en: 'Filipino' },
  { code: 'km', zh: '高棉语', en: 'Khmer' },
  { code: 'my', zh: '缅甸语', en: 'Burmese' },
  { code: 'bo', zh: '藏语', en: 'Tibetan' },
  { code: 'kk', zh: '哈萨克语', en: 'Kazakh' },
  { code: 'mn', zh: '蒙古语', en: 'Mongolian' },
  { code: 'ug', zh: '维吾尔语', en: 'Uyghur' },
];

export const DEFAULT_TARGET = 'en';

export function findLanguage(code) {
  return LANGUAGES.find((l) => l.code === code) ?? null;
}
