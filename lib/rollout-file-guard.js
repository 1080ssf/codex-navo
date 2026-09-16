const fs = require('node:fs');
const path = require('node:path');

const activeMaintenance = new Set();

function fileFingerprint(file) {
  try {
    const stat = fs.statSync(file, { bigint: true });
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function changedError() {
  return Object.assign(new Error('会话文件在处理期间发生变化，已停止操作；请退出正在写入的 Codex 后重试'), { code: 'ROLLOUT_CHANGED' });
}

function assertUnchanged(file, expected) {
  if (fileFingerprint(file) !== expected) throw changedError();
}

function beginRolloutMaintenance(file, options = {}) {
  const resolved = path.resolve(file);
  const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  const checkActive = () => {
    if (options.isFileActive?.(resolved) === true) {
      throw Object.assign(new Error('会话仍在运行，已停止处理；请先退出 Codex'), { code: 'ROLLOUT_BUSY' });
    }
  };
  if (activeMaintenance.has(key)) throw Object.assign(new Error('该会话正在备份、优化或恢复，请稍后重试'), { code: 'ROLLOUT_BUSY' });
  checkActive();
  const originalFingerprint = fileFingerprint(resolved);
  activeMaintenance.add(key);
  const started = performance.now();
  let lastStageAt = started;
  let previousStage = 'preflight';
  const timingsMs = {};
  return {
    originalFingerprint,
    assertCurrent() {
      checkActive();
      assertUnchanged(resolved, originalFingerprint);
    },
    async checkpoint(stage) {
      const now = performance.now();
      timingsMs[previousStage] = Math.round(now - lastStageAt);
      previousStage = stage;
      lastStageAt = now;
      await options.onProgress?.({ stage, elapsedMs: Math.round(now - started) });
      this.assertCurrent();
    },
    metadata() {
      const now = performance.now();
      return { durationMs: Math.round(now - started), timingsMs: { ...timingsMs, [previousStage]: Math.round(now - lastStageAt) } };
    },
    release() { activeMaintenance.delete(key); },
  };
}

function existingAncestor(target) {
  let current = path.resolve(target);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (current === parent) break;
    current = parent;
  }
  return current;
}

function freeBytesAt(target) {
  try {
    const stat = fs.statfsSync(existingAncestor(target));
    return Number(stat.bavail) * Number(stat.bsize);
  } catch { return null; }
}

function checkRolloutSpace(requirements, options = {}) {
  const volumes = new Map();
  for (const requirement of requirements) {
    const location = existingAncestor(requirement.path);
    const volume = String(fs.statSync(location).dev);
    const entry = volumes.get(volume) || { path: location, bytes: 1024 * 1024 };
    entry.bytes += requirement.bytes;
    volumes.set(volume, entry);
  }
  const details = [...volumes.values()].map((entry) => {
    const freeBytes = (options.getFreeBytes || freeBytesAt)(entry.path);
    if (Number.isFinite(freeBytes) && freeBytes < entry.bytes) {
      throw Object.assign(new Error('磁盘可用空间不足，未改写会话；请先为临时文件和完整备份保留空间'), { code: 'ROLLOUT_NO_SPACE' });
    }
    return { requiredFreeBytes: entry.bytes, freeBytesBefore: Number.isFinite(freeBytes) ? freeBytes : null };
  });
  return {
    requiredFreeBytes: details.reduce((sum, entry) => sum + entry.requiredFreeBytes, 0),
    freeBytesBefore: details.every((entry) => entry.freeBytesBefore != null)
      ? details.reduce((sum, entry) => sum + entry.freeBytesBefore, 0) : null,
  };
}

function rolloutBackupStorage(backupRoot) {
  let backupRootBytes = 0;
  let backupCount = 0;
  if (fs.existsSync(backupRoot)) {
    for (const entry of fs.readdirSync(backupRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.bak(?:\.json)?$/.test(entry.name)) continue;
      try {
        backupRootBytes += fs.statSync(path.join(backupRoot, entry.name)).size;
        if (entry.name.endsWith('.bak')) backupCount += 1;
      } catch {}
    }
  }
  return { backupRootBytes, backupCount, freeBytes: freeBytesAt(backupRoot) };
}

module.exports = { assertUnchanged, beginRolloutMaintenance, checkRolloutSpace, fileFingerprint, rolloutBackupStorage };
