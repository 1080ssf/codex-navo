'use strict';

const CODEX_LOCALES = Object.freeze([
  ['am', 'አማርኛ'], ['ar', 'العربية'], ['bg-BG', 'Български'], ['bn-BD', 'বাংলা'], ['bs-BA', 'Bosanski'],
  ['ca-ES', 'Català'], ['cs-CZ', 'Čeština'], ['da-DK', 'Dansk'], ['de-DE', 'Deutsch'], ['el-GR', 'Ελληνικά'],
  ['en-US', 'English'], ['es-419', 'Español (Latinoamérica)'], ['es-ES', 'Español (España)'], ['et-EE', 'Eesti'], ['fa', 'فارسی'],
  ['fi-FI', 'Suomi'], ['fr-CA', 'Français (Canada)'], ['fr-FR', 'Français (France)'], ['gu-IN', 'ગુજરાતી'], ['hi-IN', 'हिन्दी'],
  ['hr-HR', 'Hrvatski'], ['hu-HU', 'Magyar'], ['hy-AM', 'Հայերեն'], ['id-ID', 'Bahasa Indonesia'], ['is-IS', 'Íslenska'],
  ['it-IT', 'Italiano'], ['ja-JP', '日本語'], ['ka-GE', 'ქართული'], ['kk', 'Қазақ тілі'], ['kn-IN', 'ಕನ್ನಡ'],
  ['ko-KR', '한국어'], ['lt', 'Lietuvių'], ['lv-LV', 'Latviešu'], ['mk-MK', 'Македонски'], ['ml', 'മലയാളം'],
  ['mn', 'Монгол'], ['mr-IN', 'मराठी'], ['ms-MY', 'Bahasa Melayu'], ['my-MM', 'မြန်မာ'], ['nb-NO', 'Norsk bokmål'],
  ['nl-NL', 'Nederlands'], ['pa', 'ਪੰਜਾਬੀ'], ['pl-PL', 'Polski'], ['pt-BR', 'Português (Brasil)'], ['pt-PT', 'Português (Portugal)'],
  ['ro-RO', 'Română'], ['ru-RU', 'Русский'], ['sk-SK', 'Slovenčina'], ['sl-SI', 'Slovenščina'], ['so-SO', 'Soomaali'],
  ['sq-AL', 'Shqip'], ['sr-RS', 'Српски'], ['sv-SE', 'Svenska'], ['sw-TZ', 'Kiswahili'], ['ta-IN', 'தமிழ்'],
  ['te-IN', 'తెలుగు'], ['th-TH', 'ไทย'], ['tl', 'Filipino'], ['tr-TR', 'Türkçe'], ['uk-UA', 'Українська'],
  ['ur', 'اردو'], ['vi-VN', 'Tiếng Việt'], ['zh-CN', '简体中文'], ['zh-HK', '繁體中文（香港）'], ['zh-TW', '繁體中文（台灣）'],
].map(([id, label]) => Object.freeze({ id, label })));

const SUPPORTED_LOCALES = new Set(CODEX_LOCALES.map((item) => item.id));

function resolveLocale(value, fallback = 'en-US') {
  const candidate = String(value || '').trim();
  if (SUPPORTED_LOCALES.has(candidate)) return candidate;
  const lower = candidate.toLowerCase();
  const exact = CODEX_LOCALES.find((item) => item.id.toLowerCase() === lower);
  if (exact) return exact.id;
  if (lower.startsWith('zh')) return lower.includes('tw') ? 'zh-TW' : lower.includes('hk') ? 'zh-HK' : 'zh-CN';
  const sameLanguage = CODEX_LOCALES.find((item) => item.id.toLowerCase().split('-')[0] === lower.split('-')[0]);
  return sameLanguage?.id || fallback;
}

module.exports = { CODEX_LOCALES, SUPPORTED_LOCALES, resolveLocale };
