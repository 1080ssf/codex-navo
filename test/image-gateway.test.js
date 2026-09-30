const test = require('node:test');
const assert = require('node:assert/strict');
const { createImageGateway } = require('./helpers/image-gateway');
const success = () => new Response([
  { type: 'response.output_item.done', output_index: 1, item: { id: 'ig', type: 'image_generation_call', result: 'aW1hZ2U=' } },
  { type: 'response.completed', response: { id: 'resp', status: 'completed', output: [{ id: 'msg', type: 'message', content: [] }], usage: { input_tokens: 12, output_tokens: 3 } } },
].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });

test('HTTP images/generations accepts image 2.5, keeps the tool id and returns complete base64', async t => {
  const calls = [];
  const fixture = await createImageGateway(async request => { calls.push(request); return { upstream: success() }; });
  t.after(() => fixture.close());
  const response = await fetch(fixture.base + '/v1/images/generations', { method: 'POST', headers: fixture.headers,
    body: JSON.stringify({ model: 'gpt-image-2.5', prompt: 'fixture', quality: 'low', size: '1024x1024' }) });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.data[0].b64_json, 'aW1hZ2U=');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, 'gpt-6-astra');
  assert.equal(calls[0].body.tools[0].model, 'gpt-image-2.5');
  assert.equal(calls[0].body.tool_choice.type, 'image_generation');
  assert.deepEqual(result.usage, { input_tokens: 12, output_tokens: 3 });
  assert.match(response.headers.get('x-request-id'), /^req_/);
});

test('Responses preserves image 2.5 without forcing a different conversational model', async t => {
  const calls = [];
  const fixture = await createImageGateway(async request => { calls.push(request); return { upstream: success() }; }, { models: ['gpt-6.1-sol', 'gpt-6-astra'] });
  t.after(() => fixture.close());
  const response = await fetch(fixture.base + '/v1/responses', { method: 'POST', headers: fixture.headers,
    body: JSON.stringify({ model: 'gpt-6-astra', stream: false, input: 'fixture', tools: [{ type: 'image_generation', model: 'gpt-image-2.5' }] }) });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.output.find(item => item.type === 'image_generation_call').result, 'aW1hZ2U=');
  assert.equal(calls[0].model, 'gpt-6-astra');
  assert.equal(calls[0].body.tools[0].model, 'gpt-image-2.5');
});

test('native Codex JSON image edits retain input images and use the edit action', async t => {
  const calls = [];
  const fixture = await createImageGateway(async request => { calls.push(request); return { upstream: success() }; });
  t.after(() => fixture.close());
  const response = await fetch(fixture.base + '/v1/images/edits', { method: 'POST', headers: fixture.headers,
    body: JSON.stringify({ model: 'gpt-image-2', prompt: 'change the circle to blue',
      images: [{ image_url: 'data:image/png;base64,aW1hZ2U=' }, { file_id: 'file-fixture' }], background: 'transparent' }) });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).data[0].b64_json, 'aW1hZ2U=');
  assert.equal(calls[0].body.tools[0].action, 'edit');
  assert.equal(calls[0].body.tools[0].model, 'gpt-image-2');
  assert.equal(calls[0].body.tools[0].background, 'transparent');
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].body.input[0].content.slice(1))), [
    { type: 'input_image', image_url: 'data:image/png;base64,aW1hZ2U=' }, { type: 'input_image', file_id: 'file-fixture' },
  ]);
});

test('native edits reject missing or invalid references without spending quota', async t => {
  let calls = 0;
  const fixture = await createImageGateway(async () => { calls++; return { upstream: success() }; });
  t.after(() => fixture.close());
  for (const images of [undefined, [], [{}], [{ image_url: 'C:/not-uploaded.png' }],
    [{ image_url: 'https://example.test/image.png', file_id: 'file-a' }], Array(6).fill({ file_id: 'file-a' })]) {
    const response = await fetch(fixture.base + '/v1/images/edits', { method: 'POST', headers: fixture.headers,
      body: JSON.stringify({ model: 'gpt-image-2', prompt: 'fixture', images }) });
    assert.equal(response.status, 400);
  }
  assert.equal(calls, 0);
});

test('managed native image requests use the current tool model but external explicit models stay unchanged', async t => {
  const calls = [];
  const fixture = await createImageGateway(async request => { calls.push(request); return { upstream: success() }; });
  t.after(() => fixture.close());
  for (const native of [true, false]) {
    const response = await fetch(fixture.base + '/v1/images/generations', { method: 'POST',
      headers: { ...fixture.headers, ...(native ? {
        'x-codex-image-turn-id': 'turn-fixture', 'x-openai-actor-authorization': fixture.headers.Authorization,
      } : {}) }, body: JSON.stringify({ model: 'gpt-image-2', prompt: 'fixture' }) });
    assert.equal(response.status, 200);
    await response.arrayBuffer();
  }
  assert.equal(calls[0].body.tools[0].model, 'gpt-image-2.5');
  assert.equal(calls[1].body.tools[0].model, 'gpt-image-2');
  assert.equal(calls[0].upstreamHeaders['x-openai-actor-authorization'], undefined);
});

test('image response metadata describes upstream output, not the requested settings', async t => {
  const fixture = await createImageGateway(async () => ({ upstream: new Response(JSON.stringify({ output: [
    { id: 'image-a', type: 'image_generation_call', result: 'aW1hZ2U=', background: 'opaque', size: '1254x1254', quality: 'medium' },
  ] }), { headers: { 'content-type': 'application/json' } }) }));
  t.after(() => fixture.close());
  const response = await fetch(fixture.base + '/v1/images/generations', { method: 'POST', headers: fixture.headers,
    body: JSON.stringify({ model: 'gpt-image-2.5', prompt: 'fixture', size: '1024x1024', background: 'transparent' }) });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.background, 'opaque');
  assert.equal(payload.size, '1254x1254');
  assert.equal(payload.quality, 'medium');
});

test('image endpoint enforces Key permissions and never treats an upstream failure as empty success', async t => {
  let count = 0;
  const restricted = await createImageGateway(async () => { count++; return { upstream: success() }; }, { allowlist: ['gpt-6-astra'] });
  t.after(() => restricted.close());
  const denied = await fetch(restricted.base + '/v1/images/generations', { method: 'POST', headers: restricted.headers,
    body: JSON.stringify({ model: 'gpt-image-2.5', prompt: 'fixture' }) });
  assert.equal(denied.status, 403);
  assert.equal(count, 0);
  const failed = await createImageGateway(async () => ({ upstream: new Response('data: {"type":"response.failed","response":{"status":"failed","error":{"message":"Selected model is at capacity","code":"server_is_overloaded"}}}\n\n', { headers: { 'content-type': 'text/event-stream' } }) }));
  t.after(() => failed.close());
  const response = await fetch(failed.base + '/v1/images/generations', { method: 'POST', headers: failed.headers,
    body: JSON.stringify({ model: 'gpt-image-2.5', prompt: 'fixture' }) });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'model_at_capacity');
});
