const assert = require('node:assert/strict');
const test = require('node:test');
const {
  chatToResponses, responsesToChat, responsesSseToJson, responseFailure, parseImageGenerationSse, inspectResponsesStream, createResponsesSseTransform, createChatSseTransform,
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

test('image generation parser extracts the final base64 result from output_item.done', () => {
  const parsed = parseImageGenerationSse([
    'data: {"type":"response.created","response":{"id":"img_1","status":"in_progress"}}',
    'data: {"type":"response.image_generation_call.in_progress","item_id":"ig_1"}',
    'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"ig_1","type":"image_generation_call","status":"completed","result":"ZmFrZS1pbWFnZQ=="}}',
    'data: {"type":"response.completed","response":{"id":"img_1","status":"completed","output":[],"usage":{"input_tokens":8,"output_tokens":2}}}',
  ].join('\n\n'));
  assert.equal(parsed.b64Json, 'ZmFrZS1pbWFnZQ==');
  assert.deepEqual(parsed.usage, { input_tokens: 8, output_tokens: 2 });
  assert.equal(parsed.partialImages, 0);
  assert.ok(parsed.eventTypes.includes('response.image_generation_call.in_progress'));
});

test('image generation parser preserves a separately completed image item', () => {
  const parsed = parseImageGenerationSse([
    'data: {"type":"response.output_item.done","output_index":1,"item":{"id":"ig_2","type":"image_generation_call","result":"aW1hZ2U="}}',
    'data: {"type":"response.completed","response":{"id":"img_2","status":"completed","output":[{"id":"msg_2","type":"message","content":[]} ]}}',
  ].join('\n\n'));
  assert.equal(parsed.b64Json, 'aW1hZ2U=');
  assert.equal(parsed.payload.output.length, 2);
});

test('image results survive mixed final output and empty placeholders in JSON and SSE', async () => {
  const image = { id: 'ig', type: 'image_generation_call', status: 'completed', result: 'aW1hZ2U=' };
  for (const output of [[{ id: 'msg', type: 'message', content: [] }], [{ id: 'ig', type: 'image_generation_call', result: null }]]) {
    const wire = [
      { type: 'response.output_item.done', output_index: 1, item: image },
      { type: 'response.completed', response: { id: 'resp', status: 'completed', output } },
    ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
    assert.equal(responsesSseToJson(wire).output.find(item => item.id === 'ig').result, image.result);
    assert.equal(parseImageGenerationSse(wire).b64Json, image.result);
    const transform = createResponsesSseTransform();
    let text = '';
    transform.on('data', chunk => { text += chunk; });
    const finished = new Promise((resolve, reject) => { transform.on('end', resolve); transform.on('error', reject); });
    transform.end(wire);
    await finished;
    assert.equal(parseImageGenerationSse(text).b64Json, image.result);
    assert.equal(parseImageGenerationSse(text).payload.output.filter(item => item.id === 'ig').length, 1);
  }
});

test('image preflight returns progress before the image finishes and preserves original bytes', { timeout: 1000 }, async () => {
  const encoder = new TextEncoder();
  const prefix = 'data: {"type":"response.created","response":{"status":"in_progress"}}\n\ndata: {"type":"response.image_generation_call.in_progress"}\n\n';
  const suffix = 'data: {"type":"response.completed","response":{"output":[]}}\n\n';
  let controller;
  const stream = new ReadableStream({ start(c) { controller = c; c.enqueue(encoder.encode(prefix)); } });
  const inspected = await inspectResponsesStream(new Response(stream, { headers: { 'content-type': 'text/event-stream', 'x-request-id': 'image-fixture' } }));
  assert.equal(inspected.failure, null);
  assert.equal(inspected.upstream.headers.get('x-request-id'), 'image-fixture');
  controller.enqueue(encoder.encode(suffix)); controller.close();
  assert.equal(await inspected.upstream.text(), prefix + suffix);
});

test('image preflight distinguishes structured capacity errors from generated text', async () => {
  const header = { 'content-type': 'text/event-stream' };
  const errorWire = 'data: {"type":"response.failed","response":{"error":{"code":"server_is_overloaded","message":"Selected model is at capacity"}}}\n\n';
  const failed = await inspectResponsesStream(new Response(errorWire, { headers: header }));
  assert.equal(failed.failure.capacity, true);
  assert.equal(await failed.upstream.text(), errorWire);
  const normal = 'data: {"type":"response.output_text.delta","delta":"Draw a poster saying Selected model is at capacity"}\n\n';
  const succeeded = await inspectResponsesStream(new Response(normal, { headers: header }));
  assert.equal(succeeded.failure, null);
  assert.equal(await succeeded.upstream.text(), normal);
});

test('cancelling a forwarded image stream cancels the upstream reader', async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('data: {"type":"response.image_generation_call.in_progress"}\n\n')); },
    cancel() { cancelled = true; },
  });
  const inspected = await inspectResponsesStream(new Response(stream, { headers: { 'content-type': 'text/event-stream' } }));
  await inspected.upstream.body.cancel();
  assert.equal(cancelled, true);
});

test('image generation parser returns structured upstream failure', () => {
  const parsed = parseImageGenerationSse('data: {"type":"response.failed","response":{"status":"failed","error":{"code":"image_model_unavailable","message":"image tool unavailable"}}}\n\n');
  assert.equal(parsed.b64Json, '');
  assert.equal(parsed.error.code, 'image_model_unavailable');
  assert.equal(parsed.error.message, 'image tool unavailable');
});

test('capacity failures are classified from a completed Responses payload', () => {
  const payload = responsesSseToJson('data: {"type":"response.failed","response":{"status":"failed","error":{"code":"server_is_overloaded","message":"Selected model is at capacity. Please try a different model."}}}\n\n');
  const failure = responseFailure(payload);
  assert.equal(failure.capacity, true);
  assert.equal(failure.code, 'server_is_overloaded');
  assert.match(failure.message, /at capacity/);
});

test('image generation parser marks a 200 SSE capacity failure for account failover', () => {
  const parsed = parseImageGenerationSse('data: {"type":"response.failed","response":{"status":"failed","error":{"code":"server_is_overloaded","message":"Selected model is at capacity"}}}\n\n');
  assert.equal(parsed.capacity, true);
  assert.equal(parsed.error.capacity, true);
});

test('image generation parser reports missing image and observed events', () => {
  const parsed = parseImageGenerationSse('data: {"type":"response.completed","response":{"id":"img_2","status":"completed","output":[]}}\n\n');
  assert.equal(parsed.b64Json, '');
  assert.equal(parsed.error, null);
  assert.deepEqual(parsed.eventTypes, ['response.completed']);
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

test('both streaming adapters preserve UTF-8 split across network chunks', async () => {
  const bytes = Buffer.from('data: {"type":"response.output_text.delta","delta":"中文🙂"}\n\ndata: {"type":"response.completed","response":{"id":"resp_unicode","output":[]}}\n\n');
  for (const transform of [createResponsesSseTransform(), createChatSseTransform()]) {
    let output = '';
    transform.on('data', chunk => { output += chunk.toString(); });
    const finished = new Promise((resolve, reject) => { transform.once('end', resolve); transform.once('error', reject); });
    for (const byte of bytes) transform.write(Buffer.from([byte]));
    transform.end();
    await finished;
    assert.ok(output.includes('中文🙂'));
    assert.ok(!output.includes('\uFFFD'));
  }
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
