const { Transform } = require('node:stream');
const { StringDecoder } = require('node:string_decoder');

function chatContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : String(content);
  return content.map((part) => {
    if (part?.type === 'text') return { type: 'input_text', text: String(part.text || '') };
    if (part?.type === 'image_url') return { type: 'input_image', image_url: part.image_url?.url || part.image_url };
    return part;
  });
}

function chatToResponses(body = {}) {
  const input = (Array.isArray(body.messages) ? body.messages : []).map((message) => ({
    role: message.role,
    content: chatContent(message.content),
    ...(message.name ? { name: message.name } : {}),
  }));
  const tools = (Array.isArray(body.tools) ? body.tools : []).map((tool) => {
    if (tool?.type !== 'function' || !tool.function) return tool;
    return {
      type: 'function',
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters || {},
      strict: tool.function.strict,
    };
  });
  const next = {
    model: body.model,
    input,
    stream: body.stream === true,
    // ChatGPT's Codex Responses endpoint requires storage to be disabled.
    // Keep this explicit even when the OpenAI-compatible caller omits it.
    store: false,
    ...(tools.length ? { tools } : {}),
  };
  if (body.temperature != null) next.temperature = body.temperature;
  if (body.top_p != null) next.top_p = body.top_p;
  if (body.max_completion_tokens != null || body.max_tokens != null) {
    next.max_output_tokens = body.max_completion_tokens ?? body.max_tokens;
  }
  if (body.tool_choice != null) next.tool_choice = body.tool_choice;
  if (body.user != null) next.user = body.user;
  if (body.provider_id != null) next.provider_id = body.provider_id;
  return next;
}

function responseText(payload) {
  if (typeof payload.output_text === 'string') return payload.output_text;
  return (Array.isArray(payload.output) ? payload.output : [])
    .filter((item) => item?.type === 'message')
    .flatMap((item) => Array.isArray(item.content) ? item.content : [])
    .filter((part) => part?.type === 'output_text' || part?.type === 'text')
    .map((part) => String(part.text || ''))
    .join('');
}

function responseToolCalls(payload) {
  return (Array.isArray(payload.output) ? payload.output : [])
    .filter((item) => item?.type === 'function_call')
    .map((item, index) => ({
      id: item.call_id || item.id || `call_${index}`,
      type: 'function',
      function: { name: item.name || '', arguments: item.arguments || '' },
    }));
}

function responsesToChat(payload = {}) {
  const toolCalls = responseToolCalls(payload);
  const text = responseText(payload);
  const inputTokens = Number(payload.usage?.input_tokens) || 0;
  const outputTokens = Number(payload.usage?.output_tokens) || 0;
  return {
    id: payload.id || `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: payload.created_at || Math.floor(Date.now() / 1000),
    model: payload.model || '',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: text || (toolCalls.length ? null : ''),
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: toolCalls.length ? 'tool_calls' : 'stop',
    }],
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  };
}

function eventData(block) {
  return String(block).split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .join('\n');
}

function responseFailure(value = {}) {
  if (!value || typeof value !== 'object') return null;
  const response = value.response && typeof value.response === 'object' ? value.response : null;
  const rawError = value.error && typeof value.error === 'object'
    ? value.error
    : response?.error && typeof response.error === 'object' ? response.error : null;
  const status = String(response?.status || value.status || '').trim().toLowerCase();
  const eventType = String(value.type || '').trim().toLowerCase();
  const code = String(rawError?.code || value.code || response?.code || '').trim();
  const message = String(rawError?.message || (typeof value.error === 'string' ? value.error : '')
    || value.message || '').trim();
  const failed = ['failed', 'incomplete', 'error'].includes(status)
    || eventType === 'error'
    || /(?:^|\.)response\.(?:failed|incomplete|error)$/.test(eventType)
    || Boolean(rawError);
  if (!failed) return null;
  const fallback = status === 'incomplete' ? '上游响应未完成' : '上游响应失败';
  const normalizedMessage = (message || fallback).replace(/[\r\n]+/g, ' ').slice(0, 1000);
  const capacity = /server_is_overloaded|selected\s+model\s+is\s+at\s+capacity|model[^\n]{0,80}capacity|capacity[^\n]{0,80}model|overloaded/i.test(`${code} ${normalizedMessage}`);
  return { message: normalizedMessage, code: code || null, status: status || null, capacity };
}

function createResponsesAccumulator() {
  return { completed: null, failure: null, outputText: '', doneText: '', outputItems: new Map(), lastSequenceNumber: null };
}

function consumeResponsesEvent(state, item) {
  if (!item || typeof item !== 'object') return;
  const failure = responseFailure(item);
  if (failure) state.failure = failure;
  if (item.type === 'response.output_text.delta') state.outputText += String(item.delta || '');
  if (item.type === 'response.output_text.done' && typeof item.text === 'string') state.doneText = item.text;
  if (item.type === 'response.output_item.done' && item.item) {
    state.outputItems.set(Number(item.output_index) || 0, item.item);
  }
  if (item.type === 'response.completed' && item.response) state.completed = item.response;
}

function completeResponsesPayload(payload, state, { maxOutputTokens = null } = {}) {
  if (!payload) return null;
  let output = Array.isArray(payload.output) ? [...payload.output] : [];
  // A completed envelope may contain reasoning/text while the image result
  // exists only in output_item.done, or an image placeholder with the same id.
  // Merge by id (then output index for id-less items), never drop that result.
  for (const [index, item] of [...state.outputItems.entries()].sort(([left], [right]) => left - right)) {
    const found = item.id ? output.findIndex(existing => existing?.id === item.id)
      : output[index]?.type === item.type ? index : -1;
    if (found === -1) { output.splice(Math.min(index, output.length), 0, item); continue; }
    const merged = { ...item, ...output[found] };
    for (const [key, value] of Object.entries(item)) {
      if (merged[key] == null || merged[key] === '' || (Array.isArray(merged[key]) && !merged[key].length)) merged[key] = value;
    }
    if (merged.status === 'in_progress' && item.status === 'completed') merged.status = 'completed';
    output[found] = merged;
  }
  const accumulatedText = state.doneText || state.outputText;
  if (!output.length && accumulatedText) {
    output = [{
      id: `msg_${String(payload.id || Date.now()).replace(/[^a-z0-9_-]/gi, '')}`,
      type: 'message', status: 'completed', role: 'assistant',
      content: [{ type: 'output_text', text: accumulatedText, annotations: [] }],
    }];
  }
  const normalized = { ...payload, output };
  if (state.failure && !normalized.error) normalized.error = {
    message: state.failure.message,
    ...(state.failure.code ? { code: state.failure.code } : {}),
  };
  if (Number.isInteger(maxOutputTokens) && maxOutputTokens > 0) normalized.max_output_tokens = maxOutputTokens;
  const text = responseText(normalized) || accumulatedText;
  if (text || typeof normalized.output_text !== 'string') normalized.output_text = text || '';
  return normalized;
}

function responsesSseToJson(text = '', options = {}) {
  const state = createResponsesAccumulator();
  for (const block of String(text).split(/\r?\n\r?\n/)) {
    const data = eventData(block);
    if (!data || data === '[DONE]') continue;
    try { consumeResponsesEvent(state, JSON.parse(data)); }
    catch { /* Ignore comments, heartbeats and malformed intermediary events. */ }
  }
  if (!state.completed && state.failure) {
    return { id: `resp_failed_${Date.now()}`, status: 'failed', output: [], error: {
      message: state.failure.message,
      ...(state.failure.code ? { code: state.failure.code } : {}),
    } };
  }
  return completeResponsesPayload(state.completed, state, options);
}

function imageGenerationError(value) {
  const failure = responseFailure(value);
  if (!failure && value?.response?.status !== 'failed') return null;
  const normalized = failure || { message: '上游图片生成失败', code: null, status: 'failed', capacity: false };
  return {
    message: normalized.message,
    code: normalized.code,
    type: value?.error?.type || value?.response?.error?.type || null,
    capacity: normalized.capacity === true,
  };
}

/**
 * Aggregate the Responses stream used by the hosted image_generation tool.
 * The ChatGPT Codex backend may put the final base64 payload in
 * response.output_item.done rather than response.completed.output, and may
 * return a structured error event before the completed event. Keep those
 * details out of the HTTP route so clients receive a useful diagnostic.
 */
function parseImageGenerationSse(text = '') {
  const source = String(text || '');
  const state = createResponsesAccumulator();
  const eventTypes = [];
  const errors = [];
  let partialImages = 0;
  const trimmed = source.trim();
  const blocks = trimmed.startsWith('{') && trimmed.endsWith('}')
    ? [trimmed]
    : source.split(/\r?\n\r?\n/);
  for (const block of blocks) {
    const data = block.includes('data:') ? eventData(block) : block.trim();
    if (!data || data === '[DONE]') continue;
    let item;
    try { item = JSON.parse(data); } catch { continue; }
    const event = item?.type || (item?.response ? 'response' : 'json');
    eventTypes.push(event);
    const error = imageGenerationError(item);
    if (error) errors.push(error);
    if (event === 'response.image_generation_call.partial_image') partialImages += 1;
    if (item?.type === 'response.failed' && item.response) state.completed = item.response;
    consumeResponsesEvent(state, item);
    // Some clients/proxies return a completed Response JSON directly without
    // the SSE event wrapper. Treat it as the accumulator's completed value.
    if (!item.type && item.response && typeof item.response === 'object') state.completed = item.response;
    if (!item.type && !item.response && Array.isArray(item.output)) state.completed = item;
  }
  const payload = state.completed ? completeResponsesPayload(state.completed, state) : null;
  const output = Array.isArray(payload?.output) ? payload.output : [];
  const call = output.find((item) => item?.type === 'image_generation_call' || item?.type === 'image_generation');
  const result = String(call?.result || call?.b64_json || '').trim();
  const lastError = responseFailure(payload) || errors.at(-1) || null;
  return {
    payload,
    b64Json: result,
    image: call || null,
    error: lastError,
    capacity: Boolean(lastError?.capacity),
    errors,
    eventTypes,
    partialImages,
    usage: payload?.usage || {},
  };
}

function sseData(payload) { return `data: ${JSON.stringify(payload)}\n\n`; }

// Inspect only the opening SSE events. Reading a clone to completion stalls
// image progress/heartbeats until the entire generation is finished and also
// duplicates its base64 payload in memory. Once output starts, forward bytes
// unchanged; never replay a request whose output has already begun.
async function inspectResponsesStream(upstream, { maxBytes = 64 * 1024 } = {}) {
  if (!upstream.body?.getReader || !upstream.headers.get('content-type')?.includes('text/event-stream')) return { upstream, failure: null };
  const reader = upstream.body.getReader();
  const prefix = [];
  const decoder = new TextDecoder();
  let pending = '', bytes = 0, ended = false, failure = null, committed = false;
  try {
    while (!ended && !failure && !committed && bytes < maxBytes) {
      const chunk = await reader.read();
      ended = chunk.done;
      if (ended) break;
      prefix.push(chunk.value);
      bytes += chunk.value.byteLength;
      pending += decoder.decode(chunk.value, { stream: true });
      const blocks = pending.split(/\r?\n\r?\n/);
      pending = blocks.pop() || '';
      for (const block of blocks) {
        let event;
        try { event = JSON.parse(eventData(block)); } catch { continue; }
        failure = responseFailure(event);
        committed = /^response\.(?:output_|reasoning|image_generation_call\.)/.test(event.type || '') || event.type === 'response.completed';
        if (failure || committed) break;
      }
    }
    if (ended && pending.trim() && !committed && !failure) {
      try { failure = responseFailure(JSON.parse(eventData(pending))); } catch {}
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of prefix) controller.enqueue(chunk);
      if (ended) controller.close();
    },
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) controller.close(); else controller.enqueue(value);
      } catch (error) { controller.error(error); }
    },
    cancel(reason) { return reader.cancel(reason); },
  });
  return { upstream: new Response(body, { status: upstream.status, statusText: upstream.statusText, headers: upstream.headers }), failure };
}

function createResponsesSseTransform(options = {}) {
  let pending = '';
  const decoder = new StringDecoder('utf8');
  const state = createResponsesAccumulator();
  return new Transform({
    transform(chunk, _encoding, callback) {
      pending += decoder.write(chunk);
      const events = pending.split(/\r?\n\r?\n/);
      pending = events.pop() || '';
      for (const event of events) {
        const data = eventData(event);
        if (!data || data === '[DONE]') { this.push(`${event}\n\n`); continue; }
        let item;
        try { item = JSON.parse(data); }
        catch { this.push(`${event}\n\n`); continue; }
        if (Number.isInteger(item.sequence_number)) {
          if (state.lastSequenceNumber !== null) item.sequence_number = state.lastSequenceNumber + 1;
          state.lastSequenceNumber = item.sequence_number;
        }
        consumeResponsesEvent(state, item);
        if (item.type === 'response.completed' && item.response) {
          item.response = completeResponsesPayload(item.response, state, options);
          const eventName = event.split(/\r?\n/).find((line) => line.startsWith('event:'));
          if (eventName) this.push(`${eventName}\n`);
          this.push(sseData(item));
        } else if (Number.isInteger(item.sequence_number)) {
          const eventName = event.split(/\r?\n/).find((line) => line.startsWith('event:'));
          if (eventName) this.push(`${eventName}\n`);
          this.push(sseData(item));
        } else {
          this.push(`${event}\n\n`);
        }
      }
      callback();
    },
    flush(callback) {
      pending += decoder.end();
      if (pending) this.push(pending);
      callback();
    },
  });
}

function createChatSseTransform({ model = '' } = {}) {
  let pending = '';
  const decoder = new StringDecoder('utf8');
  let responseId = `chatcmpl-${Date.now()}`;
  let created = Math.floor(Date.now() / 1000);
  let sentRole = false;
  const emitChunk = (stream, delta, finishReason = null, usage = undefined) => {
    stream.push(sseData({
      id: responseId,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
      ...(usage ? { usage } : {}),
    }));
  };
  return new Transform({
    transform(chunk, _encoding, callback) {
      pending += decoder.write(chunk);
      const events = pending.split(/\r?\n\r?\n/);
      pending = events.pop() || '';
      for (const event of events) {
        const data = event.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
        if (!data || data === '[DONE]') continue;
        let item;
        try { item = JSON.parse(data); } catch { continue; }
        responseId = item.response?.id || item.id || responseId;
        created = item.response?.created_at || created;
        if (!sentRole) { emitChunk(this, { role: 'assistant' }); sentRole = true; }
        if (item.type === 'response.output_text.delta') emitChunk(this, { content: item.delta || '' });
        if (item.type === 'response.output_item.added' && item.item?.type === 'function_call') {
          emitChunk(this, { tool_calls: [{ index: item.output_index || 0, id: item.item.call_id || item.item.id, type: 'function', function: { name: item.item.name || '', arguments: '' } }] });
        }
        if (item.type === 'response.function_call_arguments.delta') {
          emitChunk(this, { tool_calls: [{ index: item.output_index || 0, function: { arguments: item.delta || '' } }] });
        }
        if (item.type === 'response.completed') {
          const usage = item.response?.usage;
          emitChunk(this, {}, responseToolCalls(item.response || {}).length ? 'tool_calls' : 'stop', usage ? {
            prompt_tokens: Number(usage.input_tokens) || 0,
            completion_tokens: Number(usage.output_tokens) || 0,
            total_tokens: (Number(usage.input_tokens) || 0) + (Number(usage.output_tokens) || 0),
          } : undefined);
          this.push('data: [DONE]\n\n');
        }
      }
      callback();
    },
    flush(callback) { callback(); },
  });
}

module.exports = {
  chatToResponses, responsesToChat, responsesSseToJson, responseFailure, parseImageGenerationSse,
  inspectResponsesStream, createResponsesSseTransform, createChatSseTransform,
};
