'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const appFile = path.join(root, 'public', 'app.js');
const appSource = fs.readFileSync(appFile, 'utf8');

function section(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error(`Locale audit could not find ${start}`);
  return source.slice(from, to);
}

const mapSource = section(appSource, 'const englishUi = new Map(', 'const englishUiPatterns');
const mapExpression = mapSource.slice(mapSource.indexOf('new Map('), mapSource.lastIndexOf(');') + 1);
const englishUi = vm.runInNewContext(mapExpression);
const patternSource = section(appSource, 'const englishUiPatterns = ', 'function translateText');
const patternExpression = patternSource.slice(patternSource.indexOf('['), patternSource.lastIndexOf('];') + 1);
const englishUiPatterns = vm.runInNewContext(patternExpression);

function translated(value) {
  const trimmed = String(value || '').trim();
  let result = englishUi.get(trimmed) || trimmed;
  for (const [pattern, replacement] of englishUiPatterns) result = result.replace(pattern, replacement);
  return result !== trimmed;
}

function quotedStrings(source) {
  const values = [];
  const matcher = /'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g;
  for (const match of source.matchAll(matcher)) {
    let value = match[0].slice(1, -1);
    value = value.replace(/\$\{[^}]+\}/g, '1').replace(/\\[nrt]/g, ' ').replace(/\\(['"`\\])/g, '$1');
    if (/\p{Script=Han}/u.test(value)) values.push(value.trim());
  }
  return values;
}

function templateUiText(source) {
  const values = [];
  const add = (value) => {
    const normalized = value.replace(/\$\{[^}]+\}/g, '1').replace(/\s+/g, ' ').trim();
    if (/\p{Script=Han}/u.test(normalized)) values.push(normalized);
  };
  for (const match of source.matchAll(/>([^<>`]*\p{Script=Han}[^<>`]*)</gu)) add(match[1]);
  for (const match of source.matchAll(/(?:title|aria-label|placeholder)=(?:"([^"]+)"|'([^']+)')/g)) add(match[1] || match[2]);
  for (const match of source.matchAll(/`([^`\r\n]*\p{Script=Han}[^`\r\n]*)`/gu)) add(match[1]);
  return values;
}

function htmlText(source) {
  const values = [];
  for (const match of source.matchAll(/>([^<>]+)</g)) {
    const value = match[1].replace(/&amp;/g, '&').trim();
    if (/\p{Script=Han}/u.test(value)) values.push(value);
  }
  for (const match of source.matchAll(/(?:title|aria-label|placeholder|value)="([^"]+)"/g)) {
    if (/\p{Script=Han}/u.test(match[1])) values.push(match[1].trim());
  }
  return values;
}

const appWithoutCatalog = appSource
  .replace(mapSource, '')
  .replace(patternSource, '');
const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const accountHealthSource = section(serverSource, 'function inspectAccountHealth(', 'function saveWakeSettings(');
const candidates = new Set([
  ...quotedStrings(appWithoutCatalog),
  ...templateUiText(appWithoutCatalog),
  ...htmlText(fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8')),
  ...quotedStrings(accountHealthSource),
  ...templateUiText(accountHealthSource),
]);

const ignored = [
  /^zh-(?:CN|HK|TW)$/,
  /^文$/,
  /^约 1 亿$/,
];
const missing = [...candidates]
  .filter((value) => value && !ignored.some((pattern) => pattern.test(value)))
  .filter((value) => !/[<>`;{}]|=>|\.textContent|\.innerHTML|JSON\.stringify|\b(?:const|return|function)\b/.test(value))
  .filter((value) => !/^[),:;]/.test(value))
  .filter((value) => !translated(value))
  .sort((left, right) => left.localeCompare(right, 'zh-CN'));

if (missing.length) {
  console.error(`UI locale audit failed: ${missing.length} Chinese strings have no English mapping.`);
  for (const value of missing) console.error(`- ${value.replace(/\s+/g, ' ').slice(0, 240)}`);
  process.exitCode = 1;
} else {
  console.log(`UI locale audit passed: ${candidates.size} Chinese UI strings are covered.`);
}

const floatingSource = fs.readFileSync(path.join(root, 'public', 'floating.js'), 'utf8');
const floatingHtml = fs.readFileSync(path.join(root, 'public', 'floating.html'), 'utf8');
const messagesSource = section(floatingSource, 'const messages = ', 'function t(');
const messagesExpression = messagesSource.slice(messagesSource.indexOf('{'), messagesSource.lastIndexOf('};') + 1);
const floatingMessages = vm.runInNewContext(`(${messagesExpression})`);
const floatingKeys = new Set([...floatingHtml.matchAll(/data-i18n="([^"]+)"/g)].map((match) => match[1]));
const missingFloating = [...floatingKeys].filter((key) => !floatingMessages.en?.[key] || !floatingMessages['zh-CN']?.[key]);
const unequalFloating = [...new Set([
  ...Object.keys(floatingMessages.en || {}), ...Object.keys(floatingMessages['zh-CN'] || {}),
])].filter((key) => !floatingMessages.en?.[key] || !floatingMessages['zh-CN']?.[key]);
if (missingFloating.length || unequalFloating.length) {
  console.error(`Floating locale audit failed: incomplete keys ${[...new Set([...missingFloating, ...unequalFloating])].join(', ')}`);
  process.exitCode = 1;
} else {
  console.log(`Floating locale audit passed: ${Object.keys(floatingMessages.en).length} message keys are synchronized.`);
}
