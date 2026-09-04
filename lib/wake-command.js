function finiteToken(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

function normalizeUsage(value = {}) {
  const inputTokens = finiteToken(value.input_tokens ?? value.inputTokens);
  const cachedInputTokens = finiteToken(value.cached_input_tokens ?? value.cachedInputTokens);
  const outputTokens = finiteToken(value.output_tokens ?? value.outputTokens);
  const reasoningOutputTokens = finiteToken(value.reasoning_output_tokens ?? value.reasoningOutputTokens);
  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

function eventErrorText(event) {
  const value = event?.error?.message ?? event?.error ?? event?.message ?? '';
  return typeof value === 'string' ? value.trim() : JSON.stringify(value || '').slice(0, 500);
}

function parseWakeJsonl(output) {
  const result = {
    eventCount: 0,
    invalidLineCount: 0,
    threadId: '',
    turnCompleted: false,
    turnFailed: false,
    agentMessageReceived: false,
    usage: normalizeUsage(),
    errors: [],
  };
  for (const rawLine of String(output || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let event;
    try { event = JSON.parse(line); }
    catch {
      result.invalidLineCount += 1;
      continue;
    }
    result.eventCount += 1;
    const type = String(event?.type || '').replaceAll('_', '.').toLowerCase();
    if (type === 'thread.started') result.threadId = String(event.thread_id || event.threadId || '').trim();
    if (type === 'item.completed' && String(event?.item?.type || '').replaceAll('_', '.').toLowerCase() === 'agent.message') {
      result.agentMessageReceived = Boolean(String(event.item.text || event.item.content || '').trim());
    }
    if (type === 'turn.completed') {
      result.turnCompleted = true;
      result.usage = normalizeUsage(event.usage);
    }
    if (type === 'turn.failed') result.turnFailed = true;
    if (type === 'turn.failed' || type === 'error') {
      const message = eventErrorText(event);
      if (message) result.errors.push(message);
    }
  }
  result.verified = result.turnCompleted
    && !result.turnFailed
    && result.agentMessageReceived
    && result.usage.outputTokens > 0;
  return result;
}

function wakeFailureMessage({ code, parsed, stderr = '' }) {
  const detail = parsed?.errors?.at(-1)
    || String(stderr || '').trim().slice(-600)
    || (parsed?.eventCount ? 'Codex 未返回完整的模型回复或 Token 用量' : 'Codex 没有返回可验证的 JSONL 事件');
  return code === 0
    ? `Codex 唤醒结果校验失败：${detail}`
    : `Codex 唤醒请求失败（退出码 ${code}）：${detail}`;
}

function isModelCompatibilityError(value) {
  return /(model[^\r\n]{0,120}(?:not found|unsupported|not supported|unavailable|no access|does not have access)|(?:unsupported|invalid|no access|does not have access)[^\r\n]{0,100}model|模型[^\r\n]{0,80}(?:不支持|不可用|无权限))/i.test(String(value || ''));
}

module.exports = { isModelCompatibilityError, normalizeUsage, parseWakeJsonl, wakeFailureMessage };
