const EXPLICIT_ACCOUNT_SCOPE = 'explicit';
const LEGACY_ALL_ACCOUNT_SCOPE = 'legacy-all';

function normalizeAccountIds(value) {
  const items = Array.isArray(value) ? value : String(value || '').split(/[\s,]+/);
  return [...new Set(items.map((item) => String(item || '').trim()).filter(Boolean))].slice(0, 200);
}

function normalizeApiKeyAccountScope(value = {}, { migrateLegacy = false } = {}) {
  const accountIds = normalizeAccountIds(value.accountIds);
  // Only the persisted-config migration may infer legacy all-account semantics.
  // Missing/unknown markers in requests and an explicit empty list mean none.
  const legacyAll = !accountIds.length && (value.accountScope === LEGACY_ALL_ACCOUNT_SCOPE
    || (migrateLegacy && !Object.hasOwn(value, 'accountScope')));
  return { accountIds, accountScope: legacyAll ? LEGACY_ALL_ACCOUNT_SCOPE : EXPLICIT_ACCOUNT_SCOPE };
}

function resolveApiKeyMembers(key, accounts = [], isEligible = () => true) {
  if (!key) return [];
  const { accountIds, accountScope } = normalizeApiKeyAccountScope(key);
  const byId = new Map(accounts.map((account) => [account.id, account]));
  const ids = accountScope === LEGACY_ALL_ACCOUNT_SCOPE ? [...byId.keys()] : accountIds;
  return ids.map((id) => byId.get(id)).filter((account) => account && isEligible(account));
}

module.exports = {
  EXPLICIT_ACCOUNT_SCOPE,
  LEGACY_ALL_ACCOUNT_SCOPE,
  normalizeAccountIds,
  normalizeApiKeyAccountScope,
  resolveApiKeyMembers,
};
