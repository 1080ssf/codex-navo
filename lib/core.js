const path = require('node:path');

function normalizeOperator(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\r\n\t]/g, ' ').trim().slice(0, 40);
}

function validateAccountId(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9-]{2,63}$/.test(value);
}

function isWithin(root, candidate) {
  const rootPath = path.resolve(root);
  const candidatePath = path.resolve(candidate);
  const relative = path.relative(rootPath, candidatePath);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function cleanExpiredLeases(leases, now = Date.now()) {
  const next = { ...leases };
  let changed = false;
  for (const [accountId, lease] of Object.entries(next)) {
    if (!lease || (lease.expiresAt && Date.parse(lease.expiresAt) <= now)) {
      delete next[accountId];
      changed = true;
    }
  }
  return { leases: next, changed };
}

function acquireLease(leases, accountId, operator, launchType, now = Date.now()) {
  const cleaned = cleanExpiredLeases(leases, now).leases;
  const existing = cleaned[accountId];
  if (existing && existing.operator !== operator) {
    return { ok: false, reason: 'occupied', existing, leases: cleaned };
  }

  const lease = existing || {
    accountId,
    operator,
    acquiredAt: new Date(now).toISOString(),
  };
  lease.launchType = launchType;
  delete lease.expiresAt;
  return { ok: true, lease, previous: existing || null, leases: { ...cleaned, [accountId]: lease } };
}

module.exports = {
  acquireLease,
  cleanExpiredLeases,
  isWithin,
  normalizeOperator,
  validateAccountId,
};
