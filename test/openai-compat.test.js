const assert = require('node:assert/strict');
const test = require('node:test');
const {
  chatToResponses, responsesToChat, createChatSseTransform,
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
});

test('Responses 响应转换为 Chat Completions 与 usage', () => {
  const value = responsesToChat({
    id: 'resp_1', model: 'model-a', output: [{ type: 'message', content: [{ type: 'output_text', text: 'hello' }] }],
    usage: { input_tokens: 4, output_tokens: 2 },
  });
  assert.equal(value.choices[0].message.content, 'hello');
  assert.deepEqual(value.usage, { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 });
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
