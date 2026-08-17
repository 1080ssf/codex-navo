const assert = require('node:assert/strict');
const test = require('node:test');
const {
  chatToResponses, responsesToChat, responsesSseToJson, createResponsesSseTransform, createChatSseTransform,
} = require('../lib/openai-compat');

test('Chat Completions 请求转换为 Responses 并保留工具', () => {
  const value = chatToResponses({
    model: 'model-a', messages: [{ role: 'user', content: 'hi' }], max_tokens: 12,
    tools: [{ type: 'function', function: { name: 'clock', description: 'time', parameters: { type: 'object' } } }],
  });
  assert.equal(value.model, 'model-a');
  assert.equal(value.input[0].content, 'hi');
  assert.equal(value.max_output_tokens, 12);
  assert.equal(value.tools[0].name, 'clock');
  assert.equal(value.store, false);
});

test('Responses SSE completion is aggregated for non-stream callers', () => {
  const payload = responsesSseToJson([
    'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1","status":"in_progress"}}',
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hi"}',
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"Hi"}]}],"usage":{"input_tokens":2,"output_tokens":1}}}',
  ].join('\n\n'));
  assert.equal(payload.id, 'resp_1');
  assert.equal(payload.status, 'completed');
  assert.equal(payload.output[0].content[0].text, 'Hi');
  assert.deepEqual(payload.usage, { input_tokens: 2, output_tokens: 1 });
});

test('Responses SSE text deltas fill providers that omit output items on completion', () => {
  const payload = responsesSseToJson([
    'data: {"type":"response.output_text.delta","delta":"O"}',
    'data: {"type":"response.output_text.delta","delta":"K"}',
    'data: {"type":"response.completed","response":{"id":"resp_2","output":[],"usage":{"input_tokens":1,"output_tokens":2}}}',
  ].join('\n\n'));
  assert.equal(payload.output_text, 'OK');
  assert.equal(payload.output[0].content[0].text, 'OK');
});

test('Responses SSE done events fill empty completion output and convenience text', () => {
  const payload = responsesSseToJson([
    'data: {"type":"response.output_text.done","text":"Finished"}',
    'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"msg_1","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"Finished"}]}}',
    'data: {"type":"response.completed","response":{"id":"resp_3","status":"completed","output":[]}}',
  ].join('\n\n'));
  assert.equal(payload.output_text, 'Finished');
  assert.equal(payload.output[0].id, 'msg_1');
});

test('Responses streaming completion is enriched and sequence numbers remain continuous', async () => {
  const transform = createResponsesSseTransform({ maxOutputTokens: 120 });
  let result = '';
  transform.on('data', (chunk) => { result += chunk.toString(); });
  transform.end([
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","sequence_number":1,"delta":"Hi"}',
    'event: response.completed\ndata: {"type":"response.completed","sequence_number":9,"response":{"id":"resp_4","status":"completed","output":[]}}',
  ].join('\n\n') + '\n\n');
  await new Promise((resolve) => transform.once('end', resolve));
  assert.match(result, /"sequence_number":1/);
  assert.match(result, /event: response\.completed/);
  assert.match(result, /"sequence_number":2/);
  const payload = responsesSseToJson(result);
  assert.equal(payload.output_text, 'Hi');
  assert.equal(payload.output[0].content[0].text, 'Hi');
  assert.equal(payload.max_output_tokens, 120);
});

test('Responses 响应转换为 Chat Completions 与 usage', () => {
  const value = responsesToChat({
    id: 'resp_1', model: 'model-a', output: [{ type: 'message', content: [{ type: 'output_text', text: 'hello' }] }],
    usage: { input_tokens: 4, output_tokens: 2 },
  });
  assert.equal(value.choices[0].message.content, 'hello');
  assert.deepEqual(value.usage, { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 });
});

test('Chat Completions uses an empty string instead of null when no tool call exists', () => {
  const value = responsesToChat({ id: 'resp_empty', output: [], usage: { output_tokens: 1 } });
  assert.equal(value.choices[0].message.content, '');
});

test('Responses SSE 转换为 Chat Completions SSE', async () => {
  const transform = createChatSseTransform({ model: 'model-a' });
  let output = '';
  transform.on('data', (chunk) => { output += chunk.toString(); });
  transform.end('data: {"type":"response.output_text.delta","delta":"Hi"}\n\ndata: {"type":"response.completed","response":{"id":"resp_1","usage":{"input_tokens":2,"output_tokens":1}}}\n\n');
  await new Promise((resolve, reject) => { transform.on('end', resolve); transform.on('error', reject); transform.resume(); });
  assert.match(output, /"content":"Hi"/);
  assert.match(output, /"finish_reason":"stop"/);
  assert.match(output, /data: \[DONE\]/);
});
