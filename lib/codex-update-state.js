'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CODEX_UPDATE_MANIFEST_URL = 'https://persistent.oaistatic.com/codex-app-prod/windows-store-update.json';
const CODEX_CHANGELOG_URL = 'https://learn.chatgpt.com/docs/changelog';
const CODEX_STORE_PRODUCT_ID = '9PLM9XGG6VKS';
const CODEX_PACKAGE_IDENTITY = 'OpenAI.Codex';
const CODEX_PACKAGE_PUBLISHER = 'CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B';

const CODEX_CHANGELOG_ZH = Object.freeze({
  'codex-2026-08-13-app': {
    title: '电脑历史记录',
    body: '“电脑历史记录”是 ChatGPT macOS 桌面应用中的一项可选功能，可将你在应用和网站中的活动整理为 ChatGPT 与 Codex 可使用的记忆和时间线。你可以选择参与的应用与网站、暂停收集，并随时查看或删除历史记录。该功能面向 ChatGPT Pro、Business 和 Enterprise 用户；Business 与 Enterprise 工作区需要管理员先启用。首批开放地区暂不包括欧洲经济区、瑞士和英国。',
  },
  'codex-2026-08-11-app': {
    title: 'Linux 桌面预览版与代理数据导入',
    body: 'ChatGPT Linux 桌面应用预览版现已支持 x64 与 ARM64 的 Ubuntu、Debian 和 Fedora。桌面应用可从 Claude Code、Claude Cowork 和 Cursor 导入说明、设置、技能、插件、项目及近期工作，并可在“设置 > 导入”中开启自动同步。Codex CLI 也可通过 /import 从 Claude Code 和 Cursor 导入受支持的设置与近期会话。',
  },
  'codex-2026-07-31-app': {
    title: 'Record & Replay 扩展至欧盟、英国和瑞士',
    body: 'Record & Replay 现已在欧盟、英国和瑞士开放。在 macOS 上，你可以演示一套工作流程并将其转换为可复用技能；同时需要已开放并启用 Computer Use。',
  },
  'codex-2026-07-30-app': {
    title: '浏览器升级、多仓库审查与图片编辑 26.727',
    body: '本次 ChatGPT 桌面应用更新改进了内置浏览器和 Chrome 扩展，支持跨多个仓库查看与审查变更，并增强了生成图片的查看和定向编辑体验；同时新增侧边栏活动视图、精简浏览器设置，并提升 Windows 长路径安装的可靠性。',
  },
  'codex-2026-07-23-app': {
    title: 'ChatGPT Voice 与多文件夹项目 26.715',
    body: 'ChatGPT Voice 现可在桌面应用中用于 Chat、Work 和 Codex，并能通过语音启动、查看或调整其他任务。桌面端本地项目现在可包含多个相关文件夹，并指定主文件夹用于新会话、Git 操作及自动发现 AGENTS.md、技能和 config.toml。',
  },
});

const UPDATE_LINE = /Checking Windows Store for package updates[^\r\n]*\bbuildVersion=([0-9.]+)[^\r\n]*\bmanifestBuildVersion=([0-9.]+)/g;

function comparePackageVersions(left, right) {
  const parse = (value) => String(value || '').split('.').map((part) => Number.parseInt(part, 10) || 0);
  const leftParts = parse(left);
  const rightParts = parse(right);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}

function validateCodexUpdateManifest(value) {
  if (!value || Number(value.schemaVersion) < 1) throw new Error('The official Codex update manifest has an invalid schema.');
  const buildVersion = String(value.buildVersion || '').trim();
  const storeProductId = String(value.storeProductId || '').trim();
  const packageIdentity = String(value.packageIdentity || '').trim();
  if (!/^\d+(?:\.\d+){1,4}$/.test(buildVersion)) throw new Error('The official Codex update manifest has an invalid version.');
  if (storeProductId !== CODEX_STORE_PRODUCT_ID) throw new Error('The official Codex update manifest targets an unexpected Store product.');
  if (packageIdentity !== CODEX_PACKAGE_IDENTITY) throw new Error('The official Codex update manifest targets an unexpected package identity.');
  return { schemaVersion: Number(value.schemaVersion), buildVersion, storeProductId, packageIdentity };
}

function buildCodexPackageUrl(buildVersion, architecture = process.arch) {
  if (!['x64', 'arm64'].includes(architecture)) throw new Error(`Codex updates do not provide a package for ${architecture}.`);
  const version = String(buildVersion || '').trim();
  if (!/^\d+(?:\.\d+){1,4}$/.test(version)) throw new Error('A valid Codex build version is required.');
  return new URL(`releases/${encodeURIComponent(version)}/ChatGPT-${architecture}.msix`, CODEX_UPDATE_MANIFEST_URL).toString();
}

function validateCodexPackageMetadata(value, buildVersion, architecture = process.arch) {
  const metadata = {
    name: String(value?.Name || value?.name || '').trim(),
    publisher: String(value?.Publisher || value?.publisher || '').trim(),
    version: String(value?.Version || value?.version || '').trim(),
    architecture: String(value?.Architecture || value?.architecture || '').trim().toLowerCase(),
  };
  if (metadata.name !== CODEX_PACKAGE_IDENTITY) throw new Error(`The downloaded package identity is ${metadata.name || 'missing'}.`);
  if (metadata.publisher !== CODEX_PACKAGE_PUBLISHER) throw new Error('The downloaded package publisher does not match OpenAI.');
  if (comparePackageVersions(metadata.version, buildVersion) !== 0) throw new Error(`The downloaded package version is ${metadata.version || 'missing'}, expected ${buildVersion}.`);
  if (metadata.architecture !== architecture) throw new Error(`The downloaded package architecture is ${metadata.architecture || 'missing'}, expected ${architecture}.`);
  return metadata;
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&#(\d+);/g, (_match, number) => String.fromCodePoint(Number(number)))
    .replace(/&#x([\da-f]+);/gi, (_match, number) => String.fromCodePoint(Number.parseInt(number, 16)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function htmlToText(value) {
  return decodeHtml(String(value || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function parseCodexChangelog(content, limit = 5) {
  const entries = [];
  const pattern = /<li id="(?<id>codex-[^"]+-app)"[^>]*data-codex-topics="(?<topics>[^"]*codex-app[^"]*)"[^>]*>[\s\S]*?<time[^>]*>(?<date>[^<]+)<\/time>[\s\S]*?<h3[^>]*>[\s\S]*?<span>(?<title>[\s\S]*?)<\/span>[\s\S]*?<article[^>]*>(?<body>[\s\S]*?)<\/article>[\s\S]*?<\/li>/gi;
  for (const match of String(content || '').matchAll(pattern)) {
    const id = String(match.groups.id || '').trim();
    const translated = CODEX_CHANGELOG_ZH[id] || null;
    entries.push({
      id,
      date: htmlToText(match.groups.date),
      en: { title: htmlToText(match.groups.title), body: htmlToText(match.groups.body) },
      zh: translated,
    });
    if (entries.length >= limit) break;
  }
  return entries;
}

function parseCodexUpdateLog(content) {
  let latest = null;
  for (const match of String(content || '').matchAll(UPDATE_LINE)) {
    const candidate = { installedVersion: match[1], manifestVersion: match[2] };
    if (!latest || comparePackageVersions(candidate.manifestVersion, latest.manifestVersion) > 0) latest = candidate;
  }
  return latest;
}

function collectRecentLogs(root, limit = 40) {
  const files = [];
  const visit = (directory, depth) => {
    if (depth > 4) return;
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target, depth + 1);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.log')) {
        try { files.push({ target, modifiedAt: fs.statSync(target).mtimeMs }); }
        catch {}
      }
    }
  };
  visit(root, 0);
  return files.sort((left, right) => right.modifiedAt - left.modifiedAt).slice(0, limit);
}

function readLogEdges(file, edgeBytes = 256 * 1024) {
  const handle = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(handle).size;
    const headLength = Math.min(size, edgeBytes);
    const head = Buffer.alloc(headLength);
    fs.readSync(handle, head, 0, headLength, 0);
    if (size <= edgeBytes) return head.toString('utf8');
    const tailLength = Math.min(size - headLength, edgeBytes);
    const tail = Buffer.alloc(tailLength);
    fs.readSync(handle, tail, 0, tailLength, size - tailLength);
    return `${head.toString('utf8')}\n${tail.toString('utf8')}`;
  } finally {
    fs.closeSync(handle);
  }
}

function readLatestCodexUpdateSignal({ localAppData = process.env.LOCALAPPDATA, packageFamilyName = '' } = {}) {
  if (!localAppData || !packageFamilyName) return null;
  const logRoot = path.join(localAppData, 'Packages', packageFamilyName, 'LocalCache', 'Local', 'Codex', 'Logs');
  let latest = null;
  for (const file of collectRecentLogs(logRoot)) {
    try {
      const candidate = parseCodexUpdateLog(readLogEdges(file.target));
      if (candidate && (!latest || comparePackageVersions(candidate.manifestVersion, latest.manifestVersion) > 0)) {
        latest = { ...candidate, detectedAt: new Date(file.modifiedAt).toISOString() };
      }
    } catch {}
  }
  return latest;
}

module.exports = {
  CODEX_CHANGELOG_URL,
  CODEX_PACKAGE_IDENTITY,
  CODEX_PACKAGE_PUBLISHER,
  CODEX_STORE_PRODUCT_ID,
  CODEX_UPDATE_MANIFEST_URL,
  buildCodexPackageUrl,
  comparePackageVersions,
  parseCodexChangelog,
  parseCodexUpdateLog,
  readLatestCodexUpdateSignal,
  validateCodexPackageMetadata,
  validateCodexUpdateManifest,
};
