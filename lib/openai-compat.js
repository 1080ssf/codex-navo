const { Transform } = require('node:stream');

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
        content: responseText(payload) || null,
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

function sseData(payload) { return `data: ${JSON.stringify(payload)}\n\n`; }

function createChatSseTransform({ model = '' } = {}) {
  let pending = '';
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
      pending += chunk.toString('utf8');
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
  chatToResponses, responsesToChat, createChatSseTransform,
};
