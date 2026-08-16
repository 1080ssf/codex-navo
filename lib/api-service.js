const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { estimateCost } = require('./codex-usage');

const DEFAULT_GATEWAY_PORT = 18300;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const ACCOUNT_POOL_PROVIDER_ID = 'codex-navo-account-pool';

function normalizeModels(value) {
  const items = Array.isArray(value) ? value : String(value || '').split(/[\s,]+/);
  return [...new Set(items.map((item) => String(item || '').trim()).filter(Boolean))].slice(0, 100);
}

function normalizeAccountIds(value) {
  const items = Array.isArray(value) ? value : String(value || '').split(/[\s,]+/);
  return [...new Set(items.map((item) => String(item || '').trim()).filter(Boolean))].slice(0, 200);
}

function localUsageDateKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function normalizeUsage(value = {}, previous = {}) {
  return {
    requests: Math.max(0, Number(value.requests ?? previous.requests) || 0),
    inputTokens: Math.max(0, Number(value.inputTokens ?? previous.inputTokens) || 0),
    cachedInputTokens: Math.max(0, Number(value.cachedInputTokens ?? previous.cachedInputTokens) || 0),
    cacheWriteInputTokens: Math.max(0, Number(value.cacheWriteInputTokens ?? previous.cacheWriteInputTokens) || 0),
    outputTokens: Math.max(0, Number(value.outputTokens ?? previous.outputTokens) || 0),
    reasoningOutputTokens: Math.max(0, Number(value.reasoningOutputTokens ?? previous.reasoningOutputTokens) || 0),
    estimatedCostUsd: Math.max(0, Number(value.estimatedCostUsd ?? previous.estimatedCostUsd) || 0),
    pricedRequests: Math.max(0, Number(value.pricedRequests ?? previous.pricedRequests) || 0),
    unpricedRequests: Math.max(0, Number(value.unpricedRequests ?? previous.unpricedRequests) || 0),
    estimatedCostApproximate: value.estimatedCostApproximate === true || previous.estimatedCostApproximate === true,
    costVersion: Math.max(0, Number(value.costVersion ?? previous.costVersion) || 0),
    lastUsedAt: value.lastUsedAt || previous.lastUsedAt || null,
  };
}

const DAILY_USAGE_VERSION = 2;

function normalizeDailyUsage(value, version) {
  // Versions before 2 seeded the latest local day with the complete lifetime
  // total. Lifetime data has no reliable per-day timestamps, so discard those
  // synthetic buckets and start daily accounting from this upgrade onward.
  const parsedVersion = Number(version);
  if (!Number.isFinite(parsedVersion) || parsedVersion < DAILY_USAGE_VERSION) return [];
  const buckets = Array.isArray(value) ? value : [];
  return buckets
    .map((item) => ({ date: localUsageDateKey(`${item?.date || ''}T12:00:00`), usage: normalizeUsage(item?.usage || {}) }))
    .filter((item) => item.date)
    .sort((left, right) => left.date.localeCompare(right.date))
    .slice(-62);
}

function usageForLocalDate(record = {}, date = new Date()) {
  const dateKey = localUsageDateKey(date);
  const bucket = Array.isArray(record.dailyUsage)
    ? record.dailyUsage.find((item) => item?.date === dateKey)
    : null;
  return normalizeUsage(bucket?.usage || {});
}

function normalizeKeyRecord(value = {}, previous = {}) {
  const usage = normalizeUsage(value.usage || {}, previous.usage || {});
  return {
    id: String(value.id || previous.id || crypto.randomUUID()).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 64),
    name: String(value.name ?? previous.name ?? '').trim().slice(0, 80) || '未命名密钥',
    prefix: String(value.prefix || previous.prefix || ''),
    salt: String(value.salt || previous.salt || ''),
    hash: String(value.hash || previous.hash || ''),
    launchSalt: String(value.launchSalt || previous.launchSalt || ''),
    launchHash: String(value.launchHash || previous.launchHash || ''),
    enabled: value.enabled !== false,
    providerIds: [ACCOUNT_POOL_PROVIDER_ID],
    accountIds: normalizeAccountIds(value.accountIds ?? previous.accountIds),
    showInAccounts: true,
    modelAllowlist: normalizeModels(value.modelAllowlist ?? previous.modelAllowlist),
    requestLimit: Math.max(0, Number.parseInt(value.requestLimit ?? previous.requestLimit ?? 0, 10) || 0),
    tokenLimit: Math.max(0, Number.parseInt(value.tokenLimit ?? previous.tokenLimit ?? 0, 10) || 0),
    expiresAt: value.expiresAt === null || value.expiresAt === '' ? null : String(value.expiresAt ?? previous.expiresAt ?? '') || null,
    usage,
    dailyUsageVersion: DAILY_USAGE_VERSION,
    dailyUsage: normalizeDailyUsage(
      value.dailyUsage ?? previous.dailyUsage,
      value.dailyUsageVersion ?? previous.dailyUsageVersion,
    ),
    createdAt: previous.createdAt || value.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function publicKey(record) {
  const { salt, hash, launchSalt, launchHash, ...safe } = record;
  return safe;
}

function hashGatewayKey(secret, salt) {
  return crypto.scryptSync(secret, salt, 32).toString('base64url');
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function extractUsage(payload) {
  const usage = payload?.usage || payload?.response?.usage || {};
  const inputDetails = usage.input_tokens_details || usage.prompt_tokens_details || {};
  return {
    inputTokens: Number(usage.input_tokens ?? usage.prompt_tokens) || 0,
    cachedInputTokens: Number(inputDetails.cached_tokens) || 0,
    cacheWriteInputTokens: Number(inputDetails.cache_write_tokens ?? usage.cache_write_tokens) || 0,
    outputTokens: Number(usage.output_tokens ?? usage.completion_tokens) || 0,
    reasoningOutputTokens: Number(usage.output_tokens_details?.reasoning_tokens ?? usage.completion_tokens_details?.reasoning_tokens) || 0,
  };
}

class ApiServiceManager {
  constructor({ runtimeRoot, writeJsonAtomic, readJson, audit = () => {}, poolForwarder = null, gatewayPort = DEFAULT_GATEWAY_PORT }) {
    this.directory = path.join(runtimeRoot, 'api-service');
    this.configFile = path.join(this.directory, 'config.json');
    this.providersFile = path.join(this.directory, 'providers.json');
    this.keysFile = path.join(this.directory, 'keys.json');
    this.writeJsonAtomic = writeJsonAtomic;
    this.readJson = readJson;
    this.audit = audit;
    this.poolForwarder = poolForwarder;
    this.gatewayPort = Number.isInteger(gatewayPort) && gatewayPort > 0 && gatewayPort <= 65_535
      ? gatewayPort
      : DEFAULT_GATEWAY_PORT;
    fs.mkdirSync(this.directory, { recursive: true });
    this.config = this.normalizeConfig(readJson(this.configFile, {}));
    this.providers = [];
    const storedKeys = readJson(this.keysFile, []);
    const requiresDailyUsageMigration = storedKeys.some((item) => {
      const version = Number(item?.dailyUsageVersion);
      return item && item.hidden !== true && (!Number.isFinite(version) || version < DAILY_USAGE_VERSION);
    });
    this.keys = storedKeys
      .filter((item) => item && item.hidden !== true)
      .map((item) => normalizeKeyRecord(item, item));
    if (requiresDailyUsageMigration) this.saveKeys();
  }

  normalizeConfig(value = {}) {
    const remoteAccess = value.remoteAccess === true;
    return {
      enabled: value.enabled === true,
      remoteAccess,
      host: remoteAccess ? '0.0.0.0' : '127.0.0.1',
      port: this.gatewayPort,
      defaultProviderId: ACCOUNT_POOL_PROVIDER_ID,
    };
  }

  saveConfig(value) {
    this.config = this.normalizeConfig({ ...this.config, ...value });
    this.writeJsonAtomic(this.configFile, this.config);
    return this.publicState();
  }

  saveProviders() {
    this.writeJsonAtomic(this.providersFile, this.providers);
  }

  saveKeys() {
    this.writeJsonAtomic(this.keysFile, this.keys);
  }

  publicState() {
    return {
      config: this.config,
      providers: this.providers,
      keys: this.keys.map(publicKey),
      baseUrl: `http://127.0.0.1:${this.config.port}/v1`,
    };
  }

  ensureAccountPool(models = []) {
    const availableModels = normalizeModels(models);
    if (!availableModels.length) availableModels.push('gpt-5.6-codex');
    const previous = this.providers[0];
    const provider = {
      id: ACCOUNT_POOL_PROVIDER_ID,
      name: 'Codex Navo 账号池',
      type: 'navo-pool',
      vendor: 'navo-pool',
      baseUrl: '',
      models: availableModels,
      defaultModel: availableModels.includes(previous?.defaultModel) ? previous.defaultModel : availableModels[0],
      enabled: true,
      builtIn: true,
      createdAt: previous?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.providers = [provider];

    let keysChanged = false;
    for (const key of this.keys) {
      if (key.providerIds.length !== 1 || key.providerIds[0] !== ACCOUNT_POOL_PROVIDER_ID) {
        key.providerIds = [ACCOUNT_POOL_PROVIDER_ID];
        keysChanged = true;
      }
      const allowedModels = key.modelAllowlist.filter((model) => availableModels.includes(model));
      if (allowedModels.length !== key.modelAllowlist.length) {
        key.modelAllowlist = allowedModels;
        keysChanged = true;
      }
      const hasHistoricalTokens = key.usage.inputTokens > 0 || key.usage.outputTokens > 0;
      if (key.usage.costVersion < 2) {
        const historicalModel = key.modelAllowlist.length === 1 ? key.modelAllowlist[0] : provider.defaultModel;
        const estimated = hasHistoricalTokens ? estimateCost(historicalModel, {
          input: key.usage.inputTokens,
          cachedInput: Math.min(key.usage.inputTokens, key.usage.cachedInputTokens),
          cacheWriteInput: 0,
          output: key.usage.outputTokens,
          reasoningOutput: key.usage.reasoningOutputTokens,
        }, { applyLongContext: false }) : 0;
        if (estimated === null) {
          key.usage.estimatedCostUsd = 0;
          key.usage.pricedRequests = 0;
          key.usage.unpricedRequests = Math.max(1, key.usage.requests);
        }
        else {
          key.usage.estimatedCostUsd = estimated;
          key.usage.pricedRequests = hasHistoricalTokens ? Math.max(1, key.usage.requests) : 0;
          key.usage.unpricedRequests = 0;
        }
        key.usage.estimatedCostApproximate = hasHistoricalTokens;
        key.usage.costVersion = 2;
        keysChanged = true;
      }
    }
    this.config.defaultProviderId = ACCOUNT_POOL_PROVIDER_ID;
    this.saveProviders();
    this.writeJsonAtomic(this.configFile, this.config);
    if (keysChanged) this.saveKeys();
    return provider;
  }

  createKey(value = {}) {
    const secret = `sk-navo-${crypto.randomBytes(24).toString('base64url')}`;
    const salt = crypto.randomBytes(16).toString('base64url');
    const record = normalizeKeyRecord({
      ...value,
      prefix: `${secret.slice(0, 14)}…${secret.slice(-4)}`,
      salt,
      hash: hashGatewayKey(secret, salt),
    });
    this.keys.push(record);
    this.saveKeys();
    this.audit('api.key.created', { result: record.id });
    return { key: publicKey(record), secret };
  }

  updateKey(id, value = {}) {
    const record = this.keys.find((item) => item.id === id);
    if (!record) throw new Error('API Key 不存在');
    Object.assign(record, normalizeKeyRecord({ ...record, ...value, id }, record));
    this.saveKeys();
    return publicKey(record);
  }

  removeKey(id) {
    const index = this.keys.findIndex((item) => item.id === id);
    if (index < 0) throw new Error('API Key 不存在');
    this.keys.splice(index, 1);
    this.saveKeys();
  }

  authenticate(header) {
    const match = /^Bearer\s+(.+)$/i.exec(String(header || '').trim());
    if (!match) return null;
    const secret = match[1];
    return this.keys.find((record) => record.enabled && (
      safeEqual(hashGatewayKey(secret, record.salt), record.hash)
      || (record.launchSalt && record.launchHash && safeEqual(hashGatewayKey(secret, record.launchSalt), record.launchHash))
    )) || null;
  }

  issueLaunchSecret(id) {
    const record = this.keys.find((item) => item.id === id && item.enabled);
    if (!record) throw new Error('API Key 不存在或已停用');
    const secret = `sk-navo-launch-${crypto.randomBytes(24).toString('base64url')}`;
    record.launchSalt = crypto.randomBytes(16).toString('base64url');
    record.launchHash = hashGatewayKey(secret, record.launchSalt);
    record.updatedAt = new Date().toISOString();
    this.saveKeys();
    return { record, secret };
  }

  accountPool() {
    const provider = this.providers.find((item) => item.id === ACCOUNT_POOL_PROVIDER_ID && item.enabled);
    if (!provider) throw Object.assign(new Error('账号池反代服务尚未就绪'), { statusCode: 503 });
    return provider;
  }

  resolveModel(requestedModel) {
    const provider = this.accountPool();
    const raw = String(requestedModel || '').trim();
    const prefix = `${ACCOUNT_POOL_PROVIDER_ID}/`;
    if (raw.includes('/') && !raw.startsWith(prefix)) {
      throw Object.assign(new Error('模型不属于 Codex Navo 账号池'), { statusCode: 404 });
    }
    const model = raw.startsWith(prefix) ? raw.slice(prefix.length) : raw || provider.defaultModel;
    if (!provider.models.includes(model)) throw Object.assign(new Error('账号池不支持该模型'), { statusCode: 404 });
    return { provider, model };
  }

  authorizeKey(record, provider, model) {
    if (record.expiresAt && Date.parse(record.expiresAt) <= Date.now()) throw Object.assign(new Error('API Key 已过期'), { statusCode: 401 });
    if (record.requestLimit && record.usage.requests >= record.requestLimit) throw Object.assign(new Error('API Key 请求额度已用完'), { statusCode: 429 });
    const usedTokens = record.usage.inputTokens + record.usage.outputTokens;
    if (record.tokenLimit && usedTokens >= record.tokenLimit) throw Object.assign(new Error('API Key Token 额度已用完'), { statusCode: 429 });
    if (record.modelAllowlist.length && !record.modelAllowlist.includes(model)) {
      throw Object.assign(new Error('API Key 没有该模型权限'), { statusCode: 403 });
    }
  }

  modelsForKey(record) {
    const provider = this.accountPool();
    return provider.models
      .filter((model) => !record.modelAllowlist.length || record.modelAllowlist.includes(model))
      .map((id) => ({
        id,
        object: 'model',
        created: Math.floor(Date.parse(provider.createdAt) / 1000) || 0,
        owned_by: provider.name,
        provider_id: provider.id,
      }));
  }

  recordUsage(record, usage = {}, model = '', usedAt = new Date()) {
    const timestamp = usedAt instanceof Date ? usedAt : new Date(usedAt);
    const validTimestamp = Number.isNaN(timestamp.getTime()) ? new Date() : timestamp;
    const input = Math.max(0, Number(usage.inputTokens) || 0);
    const output = Math.max(0, Number(usage.outputTokens) || 0);
    const cachedInput = Math.min(input, Math.max(0, Number(usage.cachedInputTokens) || 0));
    const cacheWriteInput = Math.min(input - cachedInput, Math.max(0, Number(usage.cacheWriteInputTokens) || 0));
    const reasoningOutput = Math.max(0, Number(usage.reasoningOutputTokens) || 0);
    const estimated = input || output ? estimateCost(model, {
        input,
        cachedInput,
        cacheWriteInput,
        output,
        reasoningOutput,
      }) : 0;
    const applyUsage = (target) => {
      target.requests += 1;
      target.inputTokens += input;
      target.cachedInputTokens += cachedInput;
      target.cacheWriteInputTokens += cacheWriteInput;
      target.outputTokens += output;
      target.reasoningOutputTokens += reasoningOutput;
      target.costVersion = 2;
      if (estimated === null) target.unpricedRequests += 1;
      else if (input || output) {
        target.estimatedCostUsd = Number((target.estimatedCostUsd + estimated).toFixed(8));
        target.pricedRequests += 1;
      }
      target.lastUsedAt = validTimestamp.toISOString();
    };
    applyUsage(record.usage);
    const date = localUsageDateKey(validTimestamp);
    record.dailyUsage ||= [];
    let bucket = record.dailyUsage.find((item) => item.date === date);
    if (!bucket) {
      bucket = { date, usage: normalizeUsage() };
      record.dailyUsage.push(bucket);
      record.dailyUsage.sort((left, right) => left.date.localeCompare(right.date));
      record.dailyUsage = record.dailyUsage.slice(-62);
    }
    applyUsage(bucket.usage);
    record.updatedAt = validTimestamp.toISOString();
    this.saveKeys();
  }

  async forwardResponses({ keyRecord, body, upstreamHeaders = {}, signal }) {
    const { provider, model } = this.resolveModel(body.model);
    this.authorizeKey(keyRecord, provider, model);
    if (typeof this.poolForwarder !== 'function') {
      throw Object.assign(new Error('账号池转发服务尚未就绪'), { statusCode: 503 });
    }
    // Preserve the request shape emitted by Codex. The ChatGPT Codex backend is
    // stricter than the public Responses API and rejects unsupported nested
    // cache-control fields. Codex already supplies its own prompt_cache_key.
    const result = await this.poolForwarder({ provider, keyRecord, model, body: { ...body, model }, upstreamHeaders, signal });
    return { ...result, provider, model };
  }
}

module.exports = {
  ACCOUNT_POOL_PROVIDER_ID,
  ApiServiceManager,
  DEFAULT_GATEWAY_PORT,
  MAX_RESPONSE_BYTES,
  extractUsage,
  usageForLocalDate,
};
