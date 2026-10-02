import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
let prepareRoute;
try { ({ prepareRoute } = await import('../../src/router-core/dual-route-policy.mjs')); } catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
}
const input = { model: 'gpt-6-luna', stream: true, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'test' }] }] };
const headers = { authorization: 'Bearer official-fixture', 'chatgpt-account-id': 'account-fixture', cookie: 'private-fixture', 'x-worker-router-token': 'ingress-fixture' };
const pinnedReasoning = { type: 'reasoning', id: 'rs_fixture', summary: [], encrypted_content: 'opaque-fixture' };
const reasoningApproval = { upstreamModel: 'gpt-6-luna', fingerprint: createHash('sha256').update(JSON.stringify([pinnedReasoning.id, [], pinnedReasoning.encrypted_content])).digest('hex') };
test('approved tool declarations pass unchanged without enabling tool history or other models', () => {
  const toolsApproval = { upstreamModel: 'gpt-6-luna' };
  const payload = { ...input, model: 'gpt-6-luna_self', tools: [{ type: 'function', name: 'fixture', parameters: { type: 'object' } }],
    input: [{ ...pinnedReasoning, content: null }, ...input.input] };
  const result = prepareRoute(JSON.stringify(payload), headers, 'company-fixture', 'self', reasoningApproval, toolsApproval);
  assert.deepEqual(JSON.parse(result.body), { ...payload, model: 'gpt-6-luna' });
  assert.equal(result.headers['chatgpt-account-id'], undefined);
  assert.throws(() => prepareRoute(JSON.stringify(payload), headers, 'company-fixture', 'self', reasoningApproval), /TEXT_PILOT_ONLY/);
  for (const changes of [{ tools: null }, { tools: [null] }, { tools: ['bad'] }, { tools: [{}] },
    { model: 'gpt-6-sol_self', input: input.input }, { model: 'gpt-6-astra_self', input: input.input },
    { input: [{ type: 'function_call', call_id: 'fixture', name: 'fixture' }] },
    { input: [{ type: 'function_call_output', call_id: 'fixture', output: 'fixture' }] }]) {
    assert.throws(() => prepareRoute(JSON.stringify({ ...payload, ...changes }), headers, 'company-fixture', 'self', reasoningApproval, toolsApproval), /TEXT_PILOT_ONLY/);
  }
});
test('explicit pinned company reasoning passes unchanged, never generalized to other history or models', () => {
  const payload = { ...input, model: 'gpt-6-luna_self', input: [pinnedReasoning, ...input.input] };
  const result = prepareRoute(JSON.stringify(payload), headers, 'company-fixture', 'self', reasoningApproval);
  assert.deepEqual(JSON.parse(result.body), { ...payload, model: 'gpt-6-luna' });
  assert.equal(result.headers.authorization, 'Bearer company-fixture');
  for (const changes of [
    { model: 'gpt-6-sol_self' }, { model: 'gpt-6-astra_self' },
    { previous_response_id: 'ref' }, { conversation: 'ref' },
    ...[{ ...pinnedReasoning, encrypted_content: 'different' }, { ...pinnedReasoning, id: 'other' },
      { ...pinnedReasoning, summary: [{ type: 'summary_text', text: 'new' }] },
      ...['', {}, ['private'], [{ type: 'reasoning_text', text: 'private' }]].map(content => ({ ...pinnedReasoning, content })),
      { type: 'compaction' }, { type: 'item_reference' }].map(item => ({ input: [item] })),
  ]) assert.throws(() => prepareRoute(JSON.stringify({ ...payload, ...changes }), headers, 'company-fixture', 'self', reasoningApproval), /HISTORY_NOT_PORTABLE/);
  assert.throws(() => prepareRoute(JSON.stringify(payload), headers, 'company-fixture', 'self'), /HISTORY_NOT_PORTABLE/);
});
test('approved reasoning preserves native empty content without broadening history approval', () => {
  for (const content of [null, []]) {
    const payload = { ...input, model: 'gpt-6-luna_self', input: [{ ...pinnedReasoning, content }] };
    const result = prepareRoute(JSON.stringify(payload), headers, 'company-fixture', 'self', reasoningApproval);
    assert.deepEqual(JSON.parse(result.body).input, payload.input);
    assert.throws(() => prepareRoute(JSON.stringify(payload), headers, 'company-fixture', 'self'), /HISTORY_NOT_PORTABLE/);
  }
});
test('self mode routes plain Luna to official and exact Luna_self to company', () => {
  const body = JSON.stringify(input);
  assert.equal(prepareRoute(body, headers, 'company-fixture', 'self').route, 'official');
  const selected = { ...input, model: 'gpt-6-luna_self' };
  const result = prepareRoute(JSON.stringify(selected), headers, 'company-fixture', 'self');
  assert.equal(result.route, 'company');
  assert.equal(result.upstreamModel, 'gpt-6-luna');
  assert.deepEqual(JSON.parse(result.body), input);
  assert.equal(result.headers['chatgpt-account-id'], undefined);
  for (const model of ['gpt-6-luna-self', 'unknown_self', 'gpt-6-astra-self']) {
    assert.throws(() => prepareRoute(JSON.stringify({ ...input, model }), headers, 'company-fixture', 'self'), /MODEL_NOT_ALLOWED/);
  }
});
test('explicit Astra_self uses company credential and plain Astra remains official', () => {
  const payload = { ...input, model: 'gpt-6-astra_self' };
  const result = prepareRoute(JSON.stringify(payload), headers, 'company-fixture', 'self');
  assert.equal(result.route, 'company');
  assert.equal(result.upstreamModel, 'gpt-6-astra');
  assert.deepEqual(JSON.parse(result.body), { ...payload, model: 'gpt-6-astra' });
  assert.equal(result.headers.authorization, 'Bearer company-fixture');
  assert.equal(result.headers['chatgpt-account-id'], undefined);
  assert.equal(prepareRoute(JSON.stringify({ ...payload, model: 'gpt-6-astra' }), headers, undefined, 'self').route, 'official');
  assert.throws(() => prepareRoute(JSON.stringify(payload), headers, undefined, 'self'), /COMPANY_CREDENTIAL_REQUIRED/);
});
test('explicit Sol_self routes to company without changing history or plain Sol routing', () => {
  const payload = { ...input, model: 'gpt-6-sol_self' };
  const result = prepareRoute(JSON.stringify(payload), headers, 'company-fixture', 'self');
  assert.equal(result.route, 'company');
  assert.equal(result.upstreamModel, 'gpt-6-sol');
  assert.deepEqual(JSON.parse(result.body), { ...payload, model: 'gpt-6-sol' });
  assert.equal(result.headers.authorization, 'Bearer company-fixture');
  assert.equal(result.headers['chatgpt-account-id'], undefined);
  assert.equal(prepareRoute(JSON.stringify({ ...payload, model: 'gpt-6-sol' }), headers, undefined, 'self').route, 'official');
  assert.throws(() => prepareRoute(JSON.stringify(payload), headers, undefined, 'self'), /COMPANY_CREDENTIAL_REQUIRED/);
});
test('company preserves native additional_tools exactly', () => {
  const body = JSON.stringify({ ...input, input: [{ type: 'additional_tools', id: 'fixture', role: 'developer', tools: [] }, ...input.input] }, null, 2);
  assert.equal(prepareRoute(body, headers, 'company-fixture').body, body);
});
test('malformed additional_tools and missing call_id are rejected without repair', () => {
  for (const item of [{ type: 'additional_tools', role: 'user', tools: [] }, { type: 'additional_tools', role: 'developer', tools: 'invalid' }]) {
    assert.throws(() => prepareRoute(JSON.stringify({ ...input, input: [item] }), headers, 'company-fixture'), /TEXT_PILOT_ONLY/);
  }
  assert.throws(() => prepareRoute(JSON.stringify({ ...input, input: [{ type: 'function_call_output', output: 'private' }] }), headers, 'company-fixture'), /MISSING_CALL_ID/);
});
test('company route rebuilds headers with only company credential', () => {
  assert.equal(typeof prepareRoute, 'function');
  const result = prepareRoute(JSON.stringify(input), headers, 'company-fixture');
  assert.equal(result.route, 'company');
  assert.deepEqual(result.headers, { authorization: 'Bearer company-fixture', 'content-type': 'application/json', accept: 'text/event-stream' });
  assert.equal(result.body, JSON.stringify(input));
});
test('official route preserves official authentication without company key', () => {
  assert.equal(typeof prepareRoute, 'function');
  const body = JSON.stringify({ ...input, model: 'gpt-6-sol' });
  const result = prepareRoute(body, headers);
  assert.equal(result.route, 'official');
  assert.equal(result.headers.authorization, headers.authorization);
  assert.equal(result.headers['chatgpt-account-id'], headers['chatgpt-account-id']);
  assert.equal(result.headers.cookie, undefined);
  assert.equal(result.headers['x-worker-router-token'], undefined);
  assert.equal(result.body, body);
});
test('unknown models and missing company credential fail without fallback', () => {
  assert.equal(typeof prepareRoute, 'function');
  assert.throws(() => prepareRoute(JSON.stringify({ ...input, model: 'gpt-6-astra' }), headers, 'company-fixture'), /MODEL_NOT_ALLOWED/);
  assert.throws(() => prepareRoute(JSON.stringify(input), headers), /COMPANY_CREDENTIAL_REQUIRED/);
});
test('company route refuses opaque history and server-side references', () => {
  assert.equal(typeof prepareRoute, 'function');
  for (const extra of [{ previous_response_id: 'private' }, { input: [{ type: 'reasoning', encrypted_content: 'private' }] }, { input: [{ type: 'item_reference', id: 'private' }] }]) {
    assert.throws(() => prepareRoute(JSON.stringify({ ...input, ...extra }), headers, 'company-fixture'), /HISTORY_NOT_PORTABLE/);
  }
});
test('text pilot rejects unverified tools and non-text input without dropping them', () => {
  assert.equal(typeof prepareRoute, 'function');
  for (const extra of [{ tools: [{ type: 'function', name: 'test' }] }, { input: [{ type: 'function_call', name: 'test' }] }, { input: [{ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'private' }] }] }]) {
    assert.throws(() => prepareRoute(JSON.stringify({ ...input, ...extra }), headers, 'company-fixture'), /TEXT_PILOT_ONLY/);
  }
});
