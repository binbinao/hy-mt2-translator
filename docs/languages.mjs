/**
 * Target languages offered by this frontend. `zh` is the Chinese name and
 * `en` the English name — the prompt language follows the target (see
 * lib/translate.mjs), because the model card requires full language names in
 * the matching language.
 *
 * `script: 'hans'` marks Chinese-script targets; those take the Chinese
 * prompt template, everything else takes the English one.
 */
export const LANGUAGES = [
  { code: 'zh', zh: '中文', en: 'Chinese', script: 'hans' },
  { code: 'ja', zh: '日语', en: 'Japanese' },
  { code: 'en', zh: '英语', en: 'English' },
  { code: 'de', zh: '德语', en: 'German' },
];

export const DEFAULT_TARGET = 'en';

export function findLanguage(code) {
  return LANGUAGES.find((l) => l.code === code) ?? null;
}
