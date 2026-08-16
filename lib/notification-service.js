'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = Object.freeze({
  enabled: true,
  systemNotification: true,
  sound: 'soft-chime',
  customSound: '',
  customSounds: [],
  volume: 0.55,
  notificationText: '有任务已处理完毕。',
  notifyCompleted: true,
  notifyFailed: true,
  notifyWaiting: true,
  feishuEnabled: false,
  feishuWebhook: '',
  dingtalkEnabled: false,
  dingtalkWebhook: '',
  telegramEnabled: false,
  telegramToken: '',
  telegramChatId: '',
});

const SECRET_FIELDS = new Set(['feishuWebhook', 'dingtalkWebhook', 'telegramToken']);
const BUILT_IN_SOUNDS = new Set(['soft-chime', 'bright-chime', 'glass', 'notice', 'question', 'error', 'pluck', 'click', 'none']);
const TERMINAL_EVENT_MAX_AGE_MS = 5 * 60 * 1000;
const TERMINAL_EVENT_TYPES = new Set(['completed', 'failed', 'interrupted', 'waiting_input', 'waiting_approval']);
const LEGACY_NOTIFICATION_TEXTS = new Set([
  '{project} · {title}：{status}',
  '{project} · {title}: {status}',
  '[{status}] {project} · {title}',
  'Codex Navo · {status}\n{project} · {title}',
]);

function validAudioDataUrl(value) {
  return /^data:audio\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+$/i.test(String(value || ''))
    && String(value).length <= 8_000_000;
}

function normalizeCustomSounds(value, legacySound = '') {
  const sounds = [];
  for (const item of Array.isArray(value) ? value : []) {
    const id = String(item?.id || '').trim();
    const dataUrl = String(item?.dataUrl || '');
    if (!/^custom:[a-z0-9_-]{4,64}$/i.test(id) || !validAudioDataUrl(dataUrl) || sounds.some((entry) => entry.id === id)) continue;
    sounds.push({ id, name: String(item.name || 'Imported sound').trim().slice(0, 80), dataUrl });
    if (sounds.length >= 20) break;
  }
  if (!sounds.length && validAudioDataUrl(legacySound)) sounds.push({ id: 'custom:legacy', name: 'Imported sound', dataUrl: String(legacySound) });
  return sounds;
}

function validateChannel(channel, settings) {
  if (channel === 'feishu') {
    if (!/^https:\/\/(open\.feishu\.cn|open\.larksuite\.com)\/open-apis\/bot\/v2\/hook\//i.test(settings.feishuWebhook || '')) {
      return '请输入有效的飞书机器人 Webhook';
    }
  } else if (channel === 'dingtalk') {
    if (!/^https:\/\/oapi\.dingtalk\.com\/robot\/send\?access_token=/i.test(settings.dingtalkWebhook || '')) {
      return '请输入有效的钉钉机器人 Webhook';
    }
  } else if (channel === 'telegram') {
    if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(settings.telegramToken || '')) return '请输入有效的 Telegram Bot Token';
    if (!/^-?\d+$/.test(String(settings.telegramChatId || ''))) return '请输入有效的 Telegram Chat ID';
  } else {
    return '未知通知渠道';
  }
  return '';
}

function channelRequest(channel, settings, message) {
  const error = validateChannel(channel, settings);
  if (error) throw new Error(error);
  if (channel === 'feishu') return { url: settings.feishuWebhook, body: { msg_type: 'text', content: { text: message } } };
  if (channel === 'dingtalk') return { url: settings.dingtalkWebhook, body: { msgtype: 'text', text: { content: message } } };
  return {
    url: `https://api.telegram.org/bot${settings.telegramToken}/sendMessage`,
    body: { chat_id: settings.telegramChatId, text: message },
  };
}

function channelResponseError(channel, response, data) {
  if (!response.ok) return `HTTP ${response.status}`;
  if (!data) return '';
  if (channel === 'feishu' && data.code !== undefined && Number(data.code) !== 0) return data.msg || `飞书错误 ${data.code}`;
  if (channel === 'dingtalk' && data.errcode !== undefined && Number(data.errcode) !== 0) return data.errmsg || `钉钉错误 ${data.errcode}`;
  if (channel === 'telegram' && data.ok === false) return data.description || 'Telegram 返回失败';
  return '';
}

function normalizedSettings(value = {}) {
  const customSounds = normalizeCustomSounds(value.customSounds, value.customSound);
  let sound = String(value.sound || DEFAULTS.sound);
  if (sound === 'custom' && customSounds.length) sound = customSounds[0].id;
  if (!BUILT_IN_SOUNDS.has(sound) && !customSounds.some((item) => item.id === sound)) sound = DEFAULTS.sound;
  const savedNotificationText = String(value.notificationText ?? DEFAULTS.notificationText).slice(0, 500);
  const notificationText = !savedNotificationText.trim() || LEGACY_NOTIFICATION_TEXTS.has(savedNotificationText.trim())
    ? DEFAULTS.notificationText
    : savedNotificationText;
  return {
    ...DEFAULTS,
    enabled: value.enabled !== false,
    systemNotification: value.systemNotification !== false,
    sound,
    customSound: customSounds.find((item) => item.id === sound)?.dataUrl || '',
    customSounds,
    volume: Math.max(0, Math.min(1, Number(value.volume ?? DEFAULTS.volume))),
    notificationText,
    notifyCompleted: value.notifyCompleted !== false,
    notifyFailed: value.notifyFailed !== false,
    notifyWaiting: value.notifyWaiting !== false,
    feishuEnabled: value.feishuEnabled === true,
    feishuWebhook: String(value.feishuWebhook || '').trim(),
    dingtalkEnabled: value.dingtalkEnabled === true,
    dingtalkWebhook: String(value.dingtalkWebhook || '').trim(),
    telegramEnabled: value.telegramEnabled === true,
    telegramToken: String(value.telegramToken || '').trim(),
    telegramChatId: String(value.telegramChatId || '').trim(),
  };
}

class NotificationService {
  constructor(options = {}) {
    this.file = options.file;
    this.writeJsonAtomic = options.writeJsonAtomic;
    this.audit = options.audit || (() => {});
    this.fetch = options.fetch || globalThis.fetch;
    this.now = options.now || (() => Date.now());
    this.settings = normalizedSettings(options.readJson(this.file, {}));
    this.events = [];
    this.sequence = 0;
    this.sent = new Set();
  }

  publicSettings() {
    return { ...this.settings };
  }

  save(value) {
    this.settings = normalizedSettings({ ...this.settings, ...value });
    this.writeJsonAtomic(this.file, this.settings);
    try { fs.chmodSync(this.file, 0o600); } catch {}
    return this.publicSettings();
  }

  messageFor(event) {
    return this.settings.notificationText;
  }

  shouldNotify(type) {
    if (!this.settings.enabled) return false;
    if (type === 'completed') return this.settings.notifyCompleted;
    if (type === 'waiting_input' || type === 'waiting_approval') return this.settings.notifyWaiting;
    return this.settings.notifyFailed;
  }

  enqueue(event, message) {
    const customSound = this.settings.customSounds.find((item) => item.id === this.settings.sound)?.dataUrl || '';
    const item = {
      id: ++this.sequence,
      createdAt: new Date().toISOString(),
      type: event.type,
      message,
      task: event.task || {},
      systemNotification: this.settings.systemNotification,
      sound: this.settings.sound,
      customSound,
      volume: this.settings.volume,
    };
    this.events.push(item);
    if (this.events.length > 100) this.events.splice(0, this.events.length - 100);
    return item;
  }

  listEvents(after = 0) {
    return this.events.filter((item) => item.id > Number(after || 0));
  }

  async notify(event, force = false) {
    const task = event.task || {};
    const dedupe = `${task.id || 'unknown'}:${task.turnId || task.lastUpdatedAt || ''}:${event.type}`;
    if (!force && TERMINAL_EVENT_TYPES.has(event.type)) {
      const eventTime = Date.parse(task.completedAt || task.lastUpdatedAt || '');
      const age = this.now() - eventTime;
      if (!Number.isFinite(eventTime) || age > TERMINAL_EVENT_MAX_AGE_MS || age < -60_000) {
        return { skipped: true, reason: 'stale-terminal-event', results: [] };
      }
    }
    if (!force && (this.sent.has(dedupe) || !this.shouldNotify(event.type))) return { skipped: true, results: [] };
    if (!force) this.sent.add(dedupe);
    const message = this.messageFor(event);
    const queued = this.enqueue(event, message);
    const jobs = [];
    if (this.settings.feishuEnabled) jobs.push(this.sendChannel('feishu', message));
    if (this.settings.dingtalkEnabled) jobs.push(this.sendChannel('dingtalk', message));
    if (this.settings.telegramEnabled) jobs.push(this.sendChannel('telegram', message));
    return { skipped: false, event: queued, results: await Promise.all(jobs) };
  }

  async sendChannel(channel, message, candidate = null) {
    const settings = normalizedSettings(candidate ? { ...this.settings, ...candidate } : this.settings);
    const request = channelRequest(channel, settings, message);
    try {
      const response = await this.fetch(request.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request.body),
        signal: AbortSignal.timeout(10_000),
      });
      const data = await response.json().catch(() => null);
      const error = channelResponseError(channel, response, data);
      if (error) throw new Error(error);
      this.audit('notification.channel.sent', { result: channel });
      return { channel, ok: true };
    } catch (error) {
      this.audit('notification.channel.failed', { result: `${channel}:${error.message}` });
      return { channel, ok: false, error: error.message };
    }
  }

  async test(channel, candidate = {}) {
    const settings = normalizedSettings({ ...this.settings, ...candidate });
    const message = 'Codex Navo 通知渠道连接成功。';
    const request = channelRequest(channel, settings, message);
    const response = await this.fetch(request.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(10_000),
    });
    const data = await response.json().catch(() => null);
    const error = channelResponseError(channel, response, data);
    if (error) throw new Error(error);
    return { channel, ok: true };
  }

  testLocal(candidate = {}) {
    const previous = this.settings;
    this.settings = normalizedSettings({ ...previous, ...candidate });
    const result = this.enqueue({ type: 'test', task: { project: 'Codex Navo', threadName: '通知测试' } }, 'Codex Navo 通知测试成功。');
    this.settings = previous;
    return result;
  }
}

module.exports = { NotificationService, DEFAULTS, SECRET_FIELDS, TERMINAL_EVENT_MAX_AGE_MS, normalizedSettings, validateChannel, channelRequest };
