const fs = require('node:fs');
const path = require('node:path');
const { TextDecoder } = require('node:util');

const ROOT = path.resolve(__dirname, '..');
const SKIPPED_DIRECTORIES = new Set([
  '.cache', '.git', '.playwright-mcp', '.tmp', 'data', 'node_modules',
  'profiles', 'release', 'vendor', 'verification',
]);
const TEXT_EXTENSIONS = new Set([
  '.bat', '.cjs', '.css', '.html', '.js', '.json', '.md', '.mjs', '.nsh',
  '.ps1', '.toml', '.txt', '.yaml', '.yml',
]);
const TEXT_NAMES = new Set(['.editorconfig', '.gitattributes', '.gitignore']);
const MOJIBAKE_PATTERNS = [
  /\uFFFD/u,
  /\u951f\u65a4\u62f7/u,
  /\u935a\ue21a\u59e9/u,
  /\u7487\u950b/u,
  /\u7ed4\ue21a\u5f5b/u,
  /\u5997\u5c84\u6f70/u,
  /\u7490\ufe40\u5f7f/u,
  /\u93c3\u72b3\u7876/u,
  /\u9286[\u4fd9?]/u,
  /\u950d[\u4fd9?]/u,
];

function collect(directory, found = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIPPED_DIRECTORIES.has(entry.name)) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) collect(file, found);
    else if (entry.isFile() && (TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) || TEXT_NAMES.has(entry.name))) {
      found.push(file);
    }
  }
  return found;
}

const decoder = new TextDecoder('utf-8', { fatal: true });
const failures = [];
for (const file of collect(ROOT)) {
  const relative = path.relative(ROOT, file);
  const bytes = fs.readFileSync(file);
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    failures.push(`${relative}: UTF-8 BOM is not allowed`);
    continue;
  }
  let source;
  try {
    source = decoder.decode(bytes);
  } catch (error) {
    failures.push(`${relative}: invalid UTF-8 (${error.message})`);
    continue;
  }
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (MOJIBAKE_PATTERNS.some((pattern) => pattern.test(lines[index]))) {
      failures.push(`${relative}:${index + 1}: probable mojibake`);
    }
  }
}

if (failures.length) {
  process.stderr.write(`UTF-8 validation failed:\n${failures.map((item) => `- ${item}`).join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('UTF-8 validation passed.\n');
}
