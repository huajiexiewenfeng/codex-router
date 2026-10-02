import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareRoute } from '../../src/router-core/dual-route-policy.mjs';

// Structural fixture only: no copied user content, credentials or task IDs.
const notice = {
  type: 'function_call_output', id: 'fco_fixture',
  name: 'send_message_to_thread', namespace: 'codex_app',
  output: 'A manager dispatches an onboarding message.',
  internal_chat_message_metadata_passthrough: { turn_id: 'fixture', create_time: 1 },
};
const headers = { authorization: 'Bearer official-fixture', 'chatgpt-account-id': 'fixture' };
const payload = { model: 'gpt-6-sol_self', stream: true, input: [notice] };
const route = p => prepareRoute(JSON.stringify(p), headers, 'company-fixture', 'self', undefined, undefined, { nativeCompany: true });

test('native cross-thread notice passes unchanged without inventing call_id', () => {
  const result = route(payload);
  assert.deepEqual(JSON.parse(result.body), { ...payload, model: 'gpt-6-sol' });
  assert.equal(Object.hasOwn(JSON.parse(result.body).input[0], 'call_id'), false);
  assert.equal(result.headers.authorization, 'Bearer company-fixture');
  assert.equal(result.headers['chatgpt-account-id'], undefined);
});

test('exception does not admit unrelated or malformed missing-call-id tools', () => {
  for (const change of [
    { name: 'exec_command' }, { namespace: 'other' }, { id: undefined },
    { output: null }, { call_id: '' }, { call_id: null }, { call_id: 7 },
    { type: 'function_call' }, { type: 'custom_tool_call' }, { type: 'custom_tool_call_output' },
  ]) assert.throws(() => route({ ...payload, input: [{ ...notice, ...change }] }), /MISSING_CALL_ID/);
  assert.throws(() => route({ ...payload, input: [notice, { type: 'function_call_output', output: 'orphan' }] }), /MISSING_CALL_ID/);
});

test('ordinary paired tools are preserved and non-native pilot stays restricted', () => {
  const input = [{ type: 'function_call', call_id: 'actual', name: 'tool', arguments: '{}' },
    { type: 'function_call_output', call_id: 'actual', output: 'result' }];
  assert.deepEqual(JSON.parse(route({ ...payload, input }).body).input, input);
  assert.throws(() => prepareRoute(JSON.stringify(payload), headers, 'company-fixture', 'self'), /MISSING_CALL_ID/);
});

test('official native notice remains byte-identical', () => {
  const body = JSON.stringify({ ...payload, model: 'gpt-6-sol' }, null, 2);
  assert.equal(prepareRoute(body, headers, undefined, 'self').body, body);
});
