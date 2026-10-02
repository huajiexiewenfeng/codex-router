import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { createOfficialRouter } from '../../src/router-core/official-router.mjs';
import { createHash } from 'node:crypto';

const THREAD = '019c7a40-1234-7123-8123-123456789abc';
const TURN = '019c7a40-5678-7123-8123-123456789abc';
const SECRET = 'fake-ingress-secret';
const AUTH = 'Bearer fake-official-secret';
const DONE = 'event: response.completed\ndata: {"type":"response.completed"}\n\n';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('local ledger failure is 503 local_storage_failed, not an upstream failure',async()=>{
 let f,calls=0;const records=[];
 f=await fixture({lifecycle:'continuous',onRecord:r=>records.push(r),transport:async()=>{
  calls++;f.router.stop('local_storage_failed');throw Error('BUDGET_WRITE_FAILED');
 }});
 try{
  const res=await f.send();assert.equal(res.status,503);
  assert.equal((await res.json()).error,'local_storage_failed');
  assert.equal(f.router.snapshot().stopped,true);
  assert.equal(records.find(r=>r.stage==='failure')?.code,'local_storage_failed');
  const next=await f.send();await next.text();assert.equal(calls,1);
 }finally{await f.close();}
});

test('registry-backed adapter uses only its configured official allowlist',async()=>{
 let calls=0;
 const f=await fixture({lifecycle:'continuous',routeMode:'self',nativeCompanyThreadId:THREAD,officialModels:[],resolveCompanyRoute:()=>{throw Error('unused');},transport:async()=>{calls++;return new Response(DONE);}});
 try{const res=await f.send();assert.equal(res.status,403);await res.text();assert.equal(calls,0);}finally{await f.close();}
});

test('timeout policy permits a progressing stream beyond the old total deadline',async()=>{
  let timer;
  const records=[];
  const f=await fixture({lifecycle:'continuous',requestTimeoutMs:120,onRecord:r=>records.push(r),
    transport:async()=>new Response(new ReadableStream({start(c){
      let n=0;
      timer=setInterval(()=>{c.enqueue(new TextEncoder().encode(++n===8?DONE:': heartbeat\n\n'));if(n===8)clearInterval(timer);},35);
    },cancel(){clearInterval(timer);}}))});
  try{assert.ok((await (await f.send()).text()).endsWith(DONE));assert.equal(records.some(r=>r.stage==='failure'),false);}
  finally{clearInterval(timer);await f.close();}
});

test('timeout policy distinguishes headers-only first byte stalls from stream stalls and permits recovery',async()=>{
  for(const firstChunk of [false,true]){
    const records=[];let calls=0,cancelled=false;
    const f=await fixture({lifecycle:'continuous',requestTimeoutMs:200,firstByteTimeoutMs:60,streamIdleTimeoutMs:90,
      onRecord:r=>records.push(r),transport:async()=>{calls++;if(calls>1)return new Response(DONE);
        return new Response(new ReadableStream({start(c){if(firstChunk)c.enqueue(new TextEncoder().encode(': heartbeat\n\n'));},cancel(){cancelled=true;}}));}});
    try{
      await assert.rejects(async()=>{const r=await f.send();await r.text();});
      assert.equal(records.find(r=>r.stage==='failure')?.code,firstChunk?'stream_idle_timeout':'first_byte_timeout');
      assert.equal(cancelled,true);assert.equal(f.router.snapshot().stopped,false);
      assert.equal(await (await f.send()).text(),DONE);assert.equal(calls,2);
    }finally{await f.close();}
  }
});

test('timeout policy rejects invalid independent phase durations',()=>{
  for(const key of ['firstByteTimeoutMs','streamIdleTimeoutMs'])for(const value of [0,-1,NaN,Infinity,'60000']){
    assert.throws(()=>createOfficialRouter(settings({[key]:value})),/invalid_router_configuration/);
  }
});

test('unlimited continuous adapter crosses old time and count limits but still binds and stops',async()=>{
  let time=Date.now(),calls=0;
  const f=await fixture({lifecycle:'continuous',expiresAt:null,maxRequests:null,now:()=>time,transport:async()=>{calls++;return new Response(DONE);}});
  try{
    time+=365*86400_000;
    for(let n=0;n<102;n++)assert.equal(await (await f.send()).text(),DONE);
    const foreign=await f.send({headers:{'x-codex-turn-metadata':JSON.stringify({thread_id:TURN,turn_id:TURN,model:'gpt-6-sol'})}});
    assert.equal(foreign.status,403);await foreign.text();assert.equal(calls,102);
    f.router.stop();const stopped=await f.send();assert.equal(stopped.status,403);await stopped.text();assert.equal(calls,102);
  }finally{await f.close();}
});
test('unlimited adapter still enforces per-request timeout and rejects partial limits',async()=>{
  for(const extra of [{expiresAt:null,maxRequests:1},{expiresAt:Date.now()+1000,maxRequests:null}])assert.throws(()=>createOfficialRouter(settings(extra)),/invalid_router_configuration/);
  const f=await fixture({lifecycle:'continuous',expiresAt:null,maxRequests:null,requestTimeoutMs:20,transport:async()=>new Promise(()=>{})});
  try{const r=await f.send();assert.equal(r.status,502);await r.text();assert.equal(f.router.snapshot().stopped,false);}finally{await f.close();}
});
test('standalone adapter omission defaults to no expiry or request cap',()=>{
  const opts=settings({lifecycle:'continuous'});delete opts.expiresAt;delete opts.maxRequests;
  const router=createOfficialRouter(opts);
  try{assert.equal(router.snapshot().expiresAt,null);assert.equal(router.snapshot().maxRequests,null);}finally{router.stop();}
});
test('continuous budget permits exactly 100 outbound calls with no automatic retry', async () => {
  let calls = 0;
  const f = await fixture({ lifecycle: 'continuous', maxRequests: 100, transport: async () => { calls++; return new Response(DONE); } });
  try {
    for(let i=0;i<100;i++) assert.equal(await (await f.send()).text(), DONE);
    for(let i=0;i<2;i++) { const r=await f.send(); assert.equal(r.status,429); await r.text(); }
    assert.equal(calls,100); assert.equal(f.router.snapshot().outboundCount,100);
    assert.equal(f.router.snapshot().stopped,false);
  } finally { await f.close(); }
});
test('continuous timeout fails only that request and the next can succeed', async () => {
  let calls = 0;
  const f = await fixture({ lifecycle: 'continuous', requestTimeoutMs: 20, transport: async () => {
    calls++; if(calls===1) return new Promise(()=>{}); return new Response(DONE);
  } });
  try {
    const r=await f.send(); assert.equal(r.status,502); await r.text();
    assert.equal(f.router.snapshot().stopped,false);
    assert.equal(await (await f.send()).text(),DONE); assert.equal(calls,2);
  } finally { await f.close(); }
});
test('continuous native mode rejects foreign tasks and missing call IDs without modifying them', async () => {
  let calls = 0;
  const f = await fixture({ lifecycle:'continuous',routeMode:'self',nativeCompanyThreadId:THREAD,companyToken:'fixture',transport:async()=>{calls++;return new Response(DONE);} });
  try {
    const foreign=await f.send({headers:{'x-codex-turn-metadata':JSON.stringify({thread_id:TURN,turn_id:TURN,model:'gpt-6-sol'})}});
    assert.equal(foreign.status,403);await foreign.text();
    const invalid=await f.send({body:{model:'gpt-6-sol_self',input:[{type:'function_call_output',output:'private'}]},headers:{'x-codex-turn-metadata':JSON.stringify({thread_id:THREAD,turn_id:TURN,model:'gpt-6-sol_self'})}});
    assert.equal(invalid.status,400);assert.match(await invalid.text(),/MISSING_CALL_ID/);
    assert.equal(calls,0);assert.equal(f.router.snapshot().stopped,false);
  } finally { await f.close(); }
});
test('native dispatch reaches company transport unchanged without forwarding official credentials', async () => {
  const calls = [];
  const f = await fixture({ lifecycle: 'continuous', routeMode: 'self', nativeCompanyThreadId: THREAD,
    companyToken: 'fixture-company', transport: async r => { calls.push(r); return new Response(DONE); } });
  const input = [{ type: 'function_call_output', id: 'fco_fixture', namespace: 'codex_app',
    name: 'send_message_to_thread', output: 'Dispatch fixture' }];
  try {
    const response = await f.send({ body: { model: 'gpt-6-sol_self', input },
      headers: { 'x-codex-turn-metadata': JSON.stringify({ thread_id: THREAD, turn_id: TURN, model: 'gpt-6-sol_self' }) } });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), DONE);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].route, 'company');
    assert.equal(JSON.parse(calls[0].body).model, 'gpt-6-sol');
    assert.deepEqual(JSON.parse(calls[0].body).input, input);
    assert.equal(calls[0].headers.authorization, 'Bearer fixture-company');
    assert.equal(calls[0].headers['chatgpt-account-id'], undefined);
  } finally { await f.close(); }
});
test('continuous mode keeps serving after success, rejection and upstream failure, with exact budget', async () => {
  let calls = 0;
  const f = await fixture({ lifecycle: 'continuous', maxRequests: 3,
    transport: async () => { calls++; return calls === 2 ? new Response('private-error', { status: 400 }) : new Response(DONE); } });
  try {
    assert.equal(await (await f.send()).text(), DONE);
    const invalid = await f.send({ body: { model: 'unknown' } });
    assert.equal(invalid.status, 403); await invalid.text();
    assert.equal(f.router.snapshot().stopped, false);
    assert.equal(calls, 1);
    const failure = await f.send(); assert.equal(failure.status, 502); await failure.text();
    assert.equal(f.router.snapshot().stopped, false);
    assert.equal(await (await f.send()).text(), DONE);
    const exhausted = await f.send(); assert.equal(exhausted.status, 429);
    assert.match(await exhausted.text(), /budget_exhausted/);
    assert.equal(calls, 3);
  } finally { await f.close(); }
});
test('continuous mode accepts at most 100 calls and two hours only with fixed thread binding', () => {
  const now = () => 1000;
  const router = createOfficialRouter(settings({ lifecycle: 'continuous', maxRequests: 100, now, expiresAt: 7201000 }));
  router.stop();
  for (const extra of [{ maxRequests: 101 }, { expiresAt: 7201001 }, { boundThreadId: () => THREAD }, { lifecycle: 'unknown' }]) {
    assert.throws(() => createOfficialRouter(settings({ lifecycle: 'continuous', maxRequests: 100, now, expiresAt: 7201000, ...extra })), /invalid_router_configuration/);
  }
});
test('continuous expiry reports specific error and cannot call upstream', async () => {
  let time = Date.now(), calls = 0;
  const f = await fixture({ lifecycle: 'continuous', now: () => time, expiresAt: time + 1000,
    transport: async () => { calls++; return new Response(DONE); } });
  try {
    time += 1001;
    const expired = await f.send(); assert.equal(expired.status, 410); assert.match(await expired.text(), /router_expired/);
    assert.equal(calls, 0);
  } finally { await f.close(); }
});
test('continuous native company forwarding preserves mixed history for all three self models', async () => {
  const calls = [];
  const f = await fixture({ lifecycle: 'continuous', routeMode: 'self', nativeCompanyThreadId: THREAD,
    officialModels: ['gpt-5.6-sol'], companyToken: 'fixture-company',
    transport: async r => { calls.push(r); return new Response(DONE); } });
  const input = [{ type: 'reasoning', id: 'fixture', summary: [], encrypted_content: 'private-cipher', content: null },
    { type: 'function_call', call_id: 'fixture-call', name: 'fixture', arguments: '{}' },
    { type: 'function_call_output', call_id: 'fixture-call', output: 'fixture' }];
  const tools = [{ type: 'function', name: 'fixture' }];
  try {
    for (const model of ['gpt-6-luna_self', 'gpt-6-sol_self', 'gpt-6-astra_self', 'gpt-5.6-sol']) {
      const response = await f.send({ body: { model, input, tools },
        headers: { 'x-codex-turn-metadata': JSON.stringify({ thread_id: THREAD, turn_id: TURN, model }) } });
      assert.equal(response.status, 200); await response.text();
    }
    assert.deepEqual(calls.map(r => r.route), ['company', 'company', 'company', 'official']);
    for(const call of calls) { assert.deepEqual(JSON.parse(call.body).input, input); assert.deepEqual(JSON.parse(call.body).tools, tools); }
    assert.equal(calls[0].headers['chatgpt-account-id'], undefined);
    assert.equal(calls[3].headers.authorization, AUTH);
  } finally { await f.close(); }
});
test('tool declaration approval is bound to exact task and cannot alter history', async () => {
  const tools = [{ type: 'function', name: 'fixture', parameters: { type: 'object' } }];
  for (const approvalThread of [THREAD, TURN]) {
    const calls = [];
    const f = await fixture({ routeMode: 'self', companyToken: 'fixture-company',
      companyToolsApproval: { threadId: approvalThread, upstreamModel: 'gpt-6-luna' },
      transport: async r => { calls.push(r); return new Response(DONE); } });
    try {
      const response = await f.send({ body: { model: 'gpt-6-luna_self', tools, input: [{ type: 'message', role: 'user', content: 'fixture' }] },
        headers: { 'x-codex-turn-metadata': JSON.stringify({ thread_id: THREAD, turn_id: TURN, model: 'gpt-6-luna_self' }) } });
      assert.equal(response.status, approvalThread === THREAD ? 200 : 400); await response.text();
      assert.equal(calls.length, approvalThread === THREAD ? 1 : 0);
      if (calls.length) assert.deepEqual(JSON.parse(calls[0].body).tools, tools);
    } finally { await f.close(); }
  }
});
test('text rejection reports every structural blocker without leaking contents', async () => {
  const records = [];
  const f = await fixture({ routeMode: 'self', diagnosticsOnly: true, companyToken: 'private-key', onRecord: r => records.push(r) });
  try {
    const response = await f.send({ body: { model: 'gpt-6-luna_self', tools: [{ name: 'private-tool' }], input: [
      { type: 'additional_tools', role: 'user', tools: 'private-tools' },
      { type: 'private-type', role: 'private-role', content: null },
      { type: 'message', role: 'user', content: [{ type: 'private-part', text: 'private-text' }] },
    ] }, headers: { 'x-codex-turn-metadata': JSON.stringify({ thread_id: THREAD, turn_id: TURN, model: 'gpt-6-luna_self' }) } });
    assert.equal(response.status, 400); await response.text();
    const diagnostic = records.find(r => r.code === 'TEXT_PILOT_ONLY').textDiagnostics;
    assert.equal(diagnostic.toolsState, 'nonempty_array');
    assert.equal(diagnostic.blockedItemCount, 3);
    assert.deepEqual(diagnostic.items[0].reasons, ['ADDITIONAL_TOOLS_ROLE', 'ADDITIONAL_TOOLS_ARRAY']);
    assert.deepEqual(diagnostic.items[1].reasons, ['ITEM_TYPE', 'MESSAGE_ROLE', 'MESSAGE_CONTENT']);
    assert.deepEqual(diagnostic.items[2].reasons, ['CONTENT_PART']);
    assert.equal(f.router.snapshot().outboundCount, 0);
    assert.ok(!JSON.stringify(records).includes('private-'));
  } finally { await f.close(); }
});
test('history diagnostics report only bounded structural facts and matching booleans', async () => {
  const item = { type: 'reasoning', id: 'private-id', summary: [], encrypted_content: 'private-cipher', content: ['private-nonempty'] };
  const fingerprint = createHash('sha256').update(JSON.stringify([item.id, [], item.encrypted_content])).digest('hex');
  const records = [];
  let calls = 0;
  const f = await fixture({ routeMode: 'self', companyToken: 'private-key', diagnosticsOnly: true,
    companyReasoningApproval: { threadId: THREAD, upstreamModel: 'gpt-6-luna', fingerprint },
    onRecord: r => records.push(r), transport: async () => { calls++; return new Response(DONE); } });
  try {
    const response = await f.send({ body: { model: 'gpt-6-luna_self', previous_response_id: 'private-ref', input: [item, { type: 'private-type', encrypted_content: 'private-other', 'private-field': true }] },
      headers: { 'x-codex-turn-metadata': JSON.stringify({ thread_id: THREAD, turn_id: TURN, model: 'gpt-6-luna_self' }) } });
    assert.equal(response.status, 400); await response.text();
    const diagnostic = records.find(r => r.code === 'HISTORY_NOT_PORTABLE').historyDiagnostics;
    assert.equal(diagnostic.hasPreviousResponseId, true);
    assert.equal(diagnostic.items[0].shapeEligible, false);
    assert.equal(diagnostic.items[0].fingerprintMatches, true);
    assert.equal(diagnostic.items[0].hasContentField, true);
    assert.equal(diagnostic.items[1].type, 'other');
    assert.equal(calls, 0);
    assert.ok(!JSON.stringify(records).includes('private-'));
    assert.ok(!JSON.stringify(records).includes(fingerprint));
  } finally { await f.close(); }
});
test('diagnostics-only cannot reach transport even when normal policy accepts', async () => {
  let calls = 0;
  const f = await fixture({ diagnosticsOnly: true, transport: async () => { calls++; return new Response(DONE); } });
  try {
    const response = await f.send();
    assert.equal(response.status, 409); await response.text();
    assert.equal(calls, 0);
    assert.equal(f.router.snapshot().outboundCount, 0);
    assert.equal(f.router.snapshot().stopped, true);
  } finally { await f.close(); }
});
test('reasoning exception requires exact thread binding and preserves approved input', async () => {
  const item = { type: 'reasoning', id: 'rs_fixture', summary: [], encrypted_content: 'opaque-fixture', content: null };
  const fingerprint = createHash('sha256').update(JSON.stringify([item.id, [], item.encrypted_content])).digest('hex');
  for (const approvalThread of [THREAD, TURN]) {
    const calls = [];
    const f = await fixture({ routeMode: 'self', companyToken: 'fixture-company',
      companyReasoningApproval: { threadId: approvalThread, upstreamModel: 'gpt-6-luna', fingerprint },
      transport: async r => { calls.push(r); return new Response(DONE); } });
    try {
      const response = await f.send({ body: { model: 'gpt-6-luna_self', input: [item] },
        headers: { 'x-codex-turn-metadata': JSON.stringify({ thread_id: THREAD, turn_id: TURN, model: 'gpt-6-luna_self' }) } });
      assert.equal(response.status, approvalThread === THREAD ? 200 : 400);
      await response.text();
      assert.equal(calls.length, approvalThread === THREAD ? 1 : 0);
      if(calls.length) assert.deepEqual(JSON.parse(calls[0].body).input, [item]);
    } finally { await f.close(); }
  }
});
test('self mode keeps ingress alias and records exact upstream model for ABA', async () => {
  const calls = [], records = [];
  const f = await fixture({ routeMode: 'self', companyToken: 'fixture-company', maxRequests: 3,
    onRecord: r => records.push(r), transport: async r => { calls.push(r); return new Response(DONE); } });
  try {
    for (const model of ['gpt-6-luna', 'gpt-6-luna_self', 'gpt-6-luna']) {
      const response = await f.send({ body: { model, input: [{ type: 'message', role: 'user', content: 'history' }] },
        headers: { 'x-codex-turn-metadata': JSON.stringify({ thread_id: THREAD, turn_id: TURN, model }) } });
      assert.equal(response.status, 200); await response.text();
    }
    assert.deepEqual(calls.map(r => r.route), ['official', 'company', 'official']);
    assert.deepEqual(calls.map(r => JSON.parse(r.body).model), Array(3).fill('gpt-6-luna'));
    const success = records.filter(r => r.code === 'response_completed');
    assert.equal(success[1].model, 'gpt-6-luna_self');
    assert.equal(success[1].upstreamModel, 'gpt-6-luna');
    assert.ok(!JSON.stringify(records).includes('fixture-company'));
  } finally { await f.close(); }
});

test('commentary forwarding preserves exact SSE fields and bytes for official and self routes', async () => {
  const progress = { id: 'msg_progress', type: 'message', role: 'assistant', phase: 'commentary',
    status: 'completed', content: [{ type: 'output_text', text: '进度说明：正在读取文件。', annotations: [] }] };
  const tool = { id: 'fc_fixture', type: 'function_call', call_id: 'call_fixture',
    name: 'read_fixture', arguments: '{}', status: 'completed' };
  const final = { ...progress, id: 'msg_final', phase: 'final_answer',
    content: [{ type: 'output_text', text: '读取完成。', annotations: [] }] };
  const events = [
    { type: 'response.output_item.added', output_index: 0, item: { ...progress, status: 'in_progress', content: [] } },
    { type: 'response.output_text.delta', item_id: progress.id, output_index: 0, content_index: 0, delta: progress.content[0].text },
    { type: 'response.output_item.done', output_index: 0, item: progress },
    { type: 'response.output_item.done', output_index: 1, item: tool },
    { type: 'response.output_item.done', output_index: 2, item: final },
    { type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output: [progress, tool, final] } },
  ];
  const bytes = Buffer.from(events.map((event, sequence_number) =>
    `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join(''));
  const input = [{ type: 'message', role: 'user', content: 'fixture task' }, progress];
  const instructions = 'Unmodified fixture instructions.';
  for (const model of ['gpt-6-sol', 'gpt-6-sol_self', 'gpt-6-astra_self', 'gpt-6-luna_self']) {
    // A single-byte upstream chunk splits both JSON fields and Chinese UTF-8 characters.
    for (const chunkSize of [bytes.length, 1]) {
      const calls = [];
      const f = await fixture({ lifecycle: 'continuous', routeMode: 'self', nativeCompanyThreadId: THREAD,
        companyToken: 'fixture-company', transport: async (request) => {
          calls.push(request);
          let offset = 0;
          return new Response(new ReadableStream({ pull(controller) {
            if (offset === bytes.length) { controller.close(); return; }
            controller.enqueue(bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
            offset = Math.min(offset + chunkSize, bytes.length);
          } }), { headers: { 'content-type': 'text/event-stream' } });
        } });
      try {
        const response = await f.send({ body: { model, input, instructions },
          headers: { 'x-codex-turn-metadata': JSON.stringify({ thread_id: THREAD, turn_id: TURN, model }) } });
        assert.equal(response.status, 200, model);
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes, `${model}: chunk size ${chunkSize}`);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].route, model.endsWith('_self') ? 'company' : 'official');
        assert.deepEqual(JSON.parse(calls[0].body), { model: model.replace(/_self$/, ''), stream: true, input, instructions });
      } finally { await f.close(); }
    }
  }
});

test('commentary forwarding reaches the client before the upstream final event exists', { timeout: 5000 }, async () => {
  const progress = Buffer.from('event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"id":"msg_progress","type":"message","role":"assistant","phase":"commentary","status":"completed","content":[{"type":"output_text","text":"正在处理。","annotations":[]}]}}\n\n');
  let releaseFinal;
  const f = await fixture({ lifecycle: 'continuous', routeMode: 'self', nativeCompanyThreadId: THREAD,
    companyToken: 'fixture-company', transport: async () => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(progress);
      releaseFinal = () => { controller.enqueue(Buffer.from(DONE)); controller.close(); };
    } }), { headers: { 'content-type': 'text/event-stream' } }) });
  try {
    const model = 'gpt-6-astra_self';
    const response = await f.send({ body: { model, input: [{ type: 'message', role: 'user', content: 'fixture' }] },
      signal: AbortSignal.timeout(3000),
      headers: { 'x-codex-turn-metadata': JSON.stringify({ thread_id: THREAD, turn_id: TURN, model }) } });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (size < progress.length) {
      const { value, done } = await reader.read();
      assert.equal(done, false);
      chunks.push(Buffer.from(value)); size += value.byteLength;
    }
    assert.deepEqual(Buffer.concat(chunks), progress);
    releaseFinal();
    const tail = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      tail.push(Buffer.from(value));
    }
    assert.equal(Buffer.concat(tail).toString(), DONE);
  } finally { await f.close(); }
});

test('many small SSE events in one large network chunk preserve exact bytes', async () => {
  const event = 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"fixture"}\n\n';
  const body = event.repeat(1000) + DONE;
  assert.ok(Buffer.byteLength(body) > 64 * 1024);
  const f = await fixture({ transport: async () => new Response(body) });
  try {
    const response = await f.send();
    assert.equal(await response.text(), body);
    assert.equal(f.router.snapshot().stopped, false);
    assert.equal(f.router.snapshot().lastCode, 'response_completed');
  } finally { await f.close(); }
});

test('native SSE event above 64 KiB is preserved within the bounded 2 MiB limit', async () => {
  const body = 'event: response.created\ndata: ' + JSON.stringify({ type: 'response.created', fixture: 'x'.repeat(128 * 1024) }) + '\n\n' + DONE;
  const f = await fixture({ transport: async () => new Response(body) });
  try {
    assert.equal(await (await f.send()).text(), body);
    assert.equal(f.router.snapshot().stopped, false);
  } finally { await f.close(); }
});

test('individual SSE event above 2 MiB still stops with byte counts only', async () => {
  for (const suffix of ['\n\n' + DONE, '']) {
    const body = 'data: ' + 'x'.repeat(2 * 1024 * 1024) + suffix;
    const records = [];
    const f = await fixture({ transport: async () => new Response(body), onRecord: r => records.push(r) });
    try {
      try { await (await f.send()).text(); } catch { /* rejected stream */ }
      assert.equal(f.router.snapshot().stopped, true);
      assert.ok(records.some(r => r.stage === 'failure' && r.code === 'event_limit'));
      const failure = records.find(r => r.stage === 'failure');
      assert.equal(failure.eventLimitBytes, 2 * 1024 * 1024);
      assert.ok(failure.eventBytes > failure.eventLimitBytes);
      assert.ok(!records.some(r => r.code === 'response_completed'));
    } finally { await f.close(); }
  }
});

test('stream failure evidence distinguishes truncation, invalid terminal and transport without secrets', async () => {
  for (const [transport, expected, status] of [
    [async () => new Response('event: response.created\ndata: {}\n\n'), 'incomplete_stream', 200],
    [async () => new Response('event: response.completed\ndata: {}\n\n'), 'invalid_terminal_event', 200],
    [async () => { throw new Error('private-credential'); }, 'transport_or_stream_error', null],
  ]) {
    const records = [];
    const f = await fixture({ transport, onRecord: r => records.push(r) });
    try {
      try { await (await f.send()).text(); } catch { /* expected failed stream */ }
      const failure = records.find(r => r.stage === 'failure');
      assert.equal(failure?.code, expected);
      assert.equal(failure?.upstreamStatus, status);
      assert.equal(failure?.turnId, TURN);
      assert.equal(f.router.snapshot().stopped, true);
      assert.ok(!JSON.stringify(records).includes('private-credential'));
    } finally { await f.close(); }
  }
});

test('unrelated ingress rejections are diagnosed and leave the bound task usable', async () => {
  const records = [];
  const f = await fixture({ onRecord: r => records.push(r) });
  try {
    for (const request of [{ method: 'GET' }, { path: '/private-path' },
      { headers: { origin: 'http://private-origin' } },
      { headers: { 'x-worker-router-token': 'private-token' } },
      { headers: { 'x-codex-turn-metadata': JSON.stringify({ thread_id: 'private-thread', turn_id: TURN }) } }]) {
      assert.equal((await f.send(request)).status, 403);
      assert.equal(f.router.snapshot().stopped, false);
    }
    assert.deepEqual(records.map(r => r.code), ['METHOD_REJECTED', 'PATH_REJECTED', 'ORIGIN_REJECTED', 'INGRESS_TOKEN_REJECTED', 'THREAD_BINDING_REJECTED']);
    assert.equal(f.router.snapshot().outboundCount, 0);
    assert.ok(!JSON.stringify(records).includes('private-'));
    const response = await f.send();
    assert.equal(response.status, 200);
    await response.text();
  } finally { await f.close(); }
});

test('bound task policy failure stops the router without an upstream call', async () => {
  const f = await fixture({ companyToken: 'fake-company' });
  try {
    const response = await f.send({ body: { model: 'gpt-6-luna', input: [{ type: 'function_call_output', output: 'private' }] },
      headers: { 'x-codex-turn-metadata': JSON.stringify({ thread_id: THREAD, turn_id: TURN }) } });
    assert.equal(response.status, 400);
    assert.equal(f.router.snapshot().stopped, true);
    assert.equal(f.router.snapshot().outboundCount, 0);
    assert.equal((await f.send()).status, 403);
  } finally { await f.close(); }
});

test('clean manual task binding and safe policy rejection require no upstream', async () => {
  const cleanThread = '33333333-3333-4333-8333-333333333333';
  const records = [];
  let calls = 0;
  const f = await fixture({ boundThreadId: cleanThread, companyToken: 'fake-company',
    onRecord: record => records.push(record), transport: async () => { calls++; return new Response(DONE); } });
  try {
    assert.equal((await f.send()).status, 403);
    const response = await f.send({ body: { model: 'gpt-6-luna', input: [{ type: 'function_call_output', output: 'private-history' }] },
      headers: { 'x-codex-turn-metadata': JSON.stringify({ thread_id: cleanThread, turn_id: TURN }) } });
    assert.equal(response.status, 400);
    assert.match(await response.text(), /MISSING_CALL_ID/);
    const rejection = records.find(r => r.stage === 'rejected');
    assert.equal(rejection.code, 'MISSING_CALL_ID');
    assert.equal(rejection.threadId, cleanThread);
    assert.equal(rejection.turnId, TURN);
    assert.equal(calls, 0);
    assert.equal(f.router.snapshot().outboundCount, 0);
    assert.ok(!JSON.stringify(records).includes('private-history'));
    assert.ok(!JSON.stringify(records).includes('fake-company'));
  } finally { await f.close(); }
});

test('dual route ABA shares budget, preserves history and isolates credentials', async () => {
  const requests = [], records = [];
  const f = await fixture({ companyToken: 'fake-company', maxRequests: 3,
    onRecord: record => records.push(record),
    transport: async request => { requests.push(request); return new Response(DONE); } });
  try {
    for (const model of ['gpt-6-sol', 'gpt-6-luna', 'gpt-6-sol']) {
      const input = [{ type: 'message', role: 'user', content: 'keep history' }];
      const response = await f.send({ body: { model, input }, headers: {
        'x-codex-turn-metadata': JSON.stringify({ thread_id: THREAD, turn_id: TURN, model }) } });
      assert.equal(response.status, 200);
      await response.text();
      assert.deepEqual(JSON.parse(requests.at(-1).body).input, input);
    }
    assert.deepEqual(requests.map(r => r.route), ['official', 'company', 'official']);
    assert.equal(requests[1].headers.authorization, 'Bearer fake-company');
    assert.equal(requests[1].headers['chatgpt-account-id'], undefined);
    assert.equal(requests[2].headers.authorization, AUTH);
    assert.equal((await f.send()).status, 429);
    assert.equal(f.router.snapshot().outboundCount, 3);
    assert.deepEqual(records.filter(r => r.code === 'response_completed').map(r => r.model), ['gpt-6-sol', 'gpt-6-luna', 'gpt-6-sol']);
    assert.ok(!JSON.stringify(records).includes('fake-company'));
  } finally { await f.close(); }
});

test('company HTTP failure stops both routes without official fallback', async () => {
  let calls = 0;
  const f = await fixture({ companyToken: 'fake-company', transport: async () => { calls++; return new Response('private', { status: 401 }); } });
  try {
    const response = await f.send({ body: { model: 'gpt-6-luna', input: [] }, headers: {
      'x-codex-turn-metadata': JSON.stringify({ thread_id: THREAD, turn_id: TURN }) } });
    assert.equal(response.status, 502);
    assert.equal((await f.send()).status, 403);
    assert.equal(calls, 1);
  } finally { await f.close(); }
});

test('company opaque history rejects before reserving outbound budget', async () => {
  const f = await fixture({ companyToken: 'fake-company' });
  try {
    const response = await f.send({ body: { model: 'gpt-6-luna', input: [{ type: 'reasoning', encrypted_content: 'private' }] }, headers: {
      'x-codex-turn-metadata': JSON.stringify({ thread_id: THREAD, turn_id: TURN }) } });
    assert.equal(response.status, 400);
    assert.match(await response.text(), /HISTORY_NOT_PORTABLE/);
    assert.equal(f.router.snapshot().outboundCount, 0);
  } finally { await f.close(); }
});

function settings(overrides = {}) {
  return {
    ingressToken: SECRET, boundThreadId: THREAD, expiresAt: Date.now() + 60_000,
    transport: async () => new Response(DONE, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    ...overrides,
  };
}

async function fixture(options = {}) {
  const router = createOfficialRouter(settings(options));
  const server = http.createServer(router.handle);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/v1/responses`;
  const send = async ({ path = '', headers = {}, body = {}, method = 'POST', signal } = {}) => fetch(url + path, {
    method, signal, headers: {
      'x-worker-router-token': SECRET,
      authorization: AUTH,
      'chatgpt-account-id': 'fake-account',
      'content-type': 'application/json',
      'x-codex-turn-metadata': JSON.stringify({ thread_id: THREAD, turn_id: TURN, model: 'gpt-6-sol' }),
      ...headers,
    }, body: method === 'POST' ? JSON.stringify({ model: 'gpt-6-sol', stream: true, ...body }) : undefined,
  });
  const close = async () => { router.stop(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); };
  return { router, send, close };
}

test('forwards exact official request and emits only safe evidence', async () => {
  let outbound;
  const records = [];
  const f = await fixture({ transport: async (request) => { outbound = request; return new Response(DONE, { status: 200, headers: { 'content-type': 'text/event-stream' } }); }, onRecord: (record) => records.push(record) });
  try {
    const response = await f.send({ headers: { cookie: 'fake-cookie', 'x-worker-router-token': SECRET, 'openai-organization': 'fake-org' }, body: { input: 'hello' } });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), DONE);
    assert.deepEqual(JSON.parse(outbound.body), { model: 'gpt-6-sol', stream: true, input: 'hello' });
    assert.equal(outbound.headers.authorization, AUTH);
    assert.equal(outbound.headers['chatgpt-account-id'], 'fake-account');
    assert.equal(outbound.headers.cookie, undefined);
    assert.equal(outbound.headers['x-worker-router-token'], undefined);
    assert.equal(outbound.headers['openai-organization'], undefined);
    assert.equal(f.router.snapshot().outboundCount, 1);
    assert.ok(!JSON.stringify({ records, snapshot: f.router.snapshot() }).includes(SECRET));
    assert.ok(!JSON.stringify(records).includes('fake-official-secret'));
  } finally { await f.close(); }
});

test('rejects invalid token, thread, model, headers, path and origin before transport', async () => {
  let calls = 0;
  const f = await fixture({ transport: async () => { calls++; return new Response(DONE); } });
  try {
    const cases = [
      { headers: { 'x-worker-router-token': 'wrong' } },
      { headers: { 'x-codex-turn-metadata': JSON.stringify({ thread_id: 'wrong', turn_id: TURN }) } },
      { body: { model: 'gpt-5.6-terra' } },
      { headers: { authorization: '' } },
      { headers: { 'chatgpt-account-id': '' } },
      { path: '/other' },
      { headers: { origin: 'http://localhost' } },
    ];
    for (const candidate of cases) assert.ok((await f.send(candidate)).status >= 400);
    assert.equal(calls, 0);
    assert.equal(f.router.snapshot().outboundCount, 0);
  } finally { await f.close(); }
});

test('budget exhaustion prevents a seventh upstream request', async () => {
  let calls = 0;
  const f = await fixture({ transport: async () => { calls++; return new Response(DONE); } });
  try {
    for (let i = 0; i < 6; i++) assert.equal((await f.send()).status, 200);
    assert.ok((await f.send()).status >= 400);
    assert.equal(calls, 6);
  } finally { await f.close(); }
});

test('expiry aborts an in-flight request and latches stop', async () => {
  let clock = 1000;
  let aborted = false;
  const f = await fixture({ now: () => clock, expiresAt: 1030, transport: ({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => { aborted = true; reject(new Error('secret failure')); }, { once: true })) });
  try {
    await f.send();
    assert.equal(aborted, true);
    clock = 1031;
    assert.ok((await f.send()).status >= 400);
    assert.equal(f.router.snapshot().outboundCount, 1);
  } finally { await f.close(); }
});

test('single concurrent request is enforced before transport', async () => {
  let release;
  const f = await fixture({ transport: async () => { await new Promise((resolve) => { release = resolve; }); return new Response(DONE); } });
  try {
    const first = f.send();
    while (!release) await delay(1);
    assert.ok((await f.send()).status >= 400);
    release();
    assert.equal((await first).status, 200);
    assert.equal(f.router.snapshot().outboundCount, 1);
  } finally { release?.(); await f.close(); }
});

test('first upstream non-2xx stops further dispatch without leaking body', async () => {
  let calls = 0;
  const f = await fixture({ transport: async () => { calls++; return new Response('fake-secret-error', { status: 429 }); } });
  try {
    const first = await f.send();
    assert.ok(first.status >= 400);
    assert.ok(!(await first.text()).includes('fake-secret-error'));
    assert.ok((await f.send()).status >= 400);
    assert.equal(calls, 1);
  } finally { await f.close(); }
});

test('incomplete SSE, error event and transport failure latch stop', async () => {
  for (const transport of [
    async () => new Response('event: response.created\ndata: {}\n\n'),
    async () => new Response('event: error\ndata: {"secret":"fake"}\n\n'),
    async () => { throw new Error('fake-token-value'); },
  ]) {
    let calls = 0;
    const f = await fixture({ transport: async (request) => { calls++; return transport(request); } });
    try {
      try { const first = await f.send(); await first.text(); } catch { /* a failed SSE can close the connection */ }
      assert.ok((await f.send()).status >= 400);
      assert.equal(calls, 1);
      assert.ok(!JSON.stringify(f.router.snapshot()).includes('fake-token-value'));
    } finally { await f.close(); }
  }
});

test('timeout and explicit stop abort active transport', async () => {
  for (const stopExplicitly of [false, true]) {
    let aborted = false;
    const f = await fixture({ requestTimeoutMs: 25, transport: ({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => { aborted = true; reject(new Error('abort')); }, { once: true })) });
    try {
      const pending = f.send();
      if (stopExplicitly) { await delay(5); f.router.stop(); }
      await pending;
      assert.equal(aborted, true);
    } finally { await f.close(); }
  }
});

test('construction fails closed on invalid limits or missing binding', () => {
  for (const option of [{ maxRequests: 7 }, { maxRequests: 0 }, { expiresAt: Date.now() + 31 * 60_000 }, { boundThreadId: '' }, { transport: undefined }]) {
    assert.throws(() => createOfficialRouter(settings(option)));
  }
});

test('dynamic binding missing or throwing fails closed without forwarding', async () => {
  for (const boundThreadId of [() => '', () => { throw new Error('private path'); }]) {
    let calls = 0;
    const f = await fixture({ boundThreadId, transport: async () => { calls++; return new Response(DONE); } });
    try {
      const response = await f.send();
      assert.ok(response.status >= 400);
      assert.equal(calls, 0);
    } finally { await f.close(); }
  }
});

test('rejected evidence callback never creates an unhandled rejection', async () => {
  const f = await fixture({ onRecord: async () => { throw new Error('fake-secret'); } });
  try { assert.equal((await f.send()).status, 200); }
  finally { await f.close(); }
});

test('redirect transport failure latches without forwarding again', async () => {
  let calls = 0;
  const f = await fixture({ transport: async () => { calls++; throw new TypeError('redirect disallowed'); } });
  try {
    assert.ok((await f.send()).status >= 400);
    assert.ok((await f.send()).status >= 400);
    assert.equal(calls, 1);
  } finally { await f.close(); }
});

test('stop aborts a stalled SSE reader after response headers', async () => {
  let cancelled = false;
  const f = await fixture({ transport: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('event: response.created\ndata: {}\n\n')); },
    cancel() { cancelled = true; },
  }), { headers: { 'content-type': 'text/event-stream' } }) });
  try {
    const response = await f.send();
    f.router.stop();
    try { await response.text(); } catch { /* socket may close */ }
    assert.equal(cancelled, true);
    assert.equal(f.router.snapshot().stopped, true);
  } finally { await f.close(); }
});

test('validated completed terminal is recorded before upstream EOF or client close', async () => {
  let upstreamCancelled = false;
  const records = [];
  const f = await fixture({ onRecord: (record) => records.push(record), transport: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(DONE)); },
    cancel() { upstreamCancelled = true; },
  }), { headers: { 'content-type': 'text/event-stream' } }) });
  try {
    const response = await f.send();
    const reader = response.body.getReader();
    const first = await reader.read();
    assert.equal(new TextDecoder().decode(first.value), DONE);
    await reader.cancel();
    await delay(10);
    const completed = records.find((record) => record.code === 'response_completed');
    assert.equal(completed?.stage, 'upstream');
    assert.equal(completed?.upstreamStatus, 200);
    assert.equal(completed?.threadId, THREAD);
    assert.equal(completed?.turnId, TURN);
    assert.equal(f.router.snapshot().lastCode, 'response_completed');
    assert.equal(f.router.snapshot().stopped, false);
    assert.equal(upstreamCancelled, true);
  } finally { await f.close(); }
});

test('malformed completed event cannot become success', async () => {
  for (const body of [
    'event: response.completed\ndata: not-json\n\n',
    'event: response.completed\ndata: {"type":"response.failed"}\n\n',
    'event: response.completedd\ndata: {"type":"response.completed"}\n\n',
    'event: response.completed\n\n',
    'event: response.completed\ndata: {"type":"response.completed"}\n\nevent: error\ndata: {"type":"error"}\n\n',
  ]) {
    const records = [];
    const f = await fixture({ onRecord: (record) => records.push(record), transport: async () => new Response(body) });
    try {
      try { const response = await f.send(); await response.text(); } catch { /* failed stream may close */ }
      assert.equal(records.some((record) => record.code === 'response_completed'), false);
      assert.equal(f.router.snapshot().stopped, true);
    } finally { await f.close(); }
  }
});

test('client cancellation before completed terminal remains failure', async () => {
  const records = [];
  let upstreamCancelled = false;
  const f = await fixture({ onRecord: (record) => records.push(record), transport: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('event: response.created\ndata: {"type":"response.created"}\n\n')); },
    cancel() { upstreamCancelled = true; },
  })) });
  try {
    const response = await f.send();
    const reader = response.body.getReader();
    await reader.read();
    await reader.cancel();
    await delay(10);
    assert.equal(records.some((record) => record.code === 'response_completed'), false);
    assert.equal(f.router.snapshot().stopped, true);
    assert.equal(f.router.snapshot().lastCode, 'cancelled');
    assert.equal(upstreamCancelled, true);
  } finally { await f.close(); }
});

test('post-terminal downstream write and drain errors close downstream and cancel upstream', async () => {
  for (const mode of ['write_throw', 'drain_error']) {
    let upstreamCancelled = false;
    const records = [];
    const router = createOfficialRouter(settings({ onRecord: (record) => records.push(record), transport: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(DONE)); },
      cancel() { upstreamCancelled = true; },
    })) }));
    const req = Readable.from([Buffer.from(JSON.stringify({ model: 'gpt-6-sol', stream: true }))]);
    Object.assign(req, { method: 'POST', url: '/v1/responses', headers: {
      'x-worker-router-token': SECRET, authorization: AUTH, 'chatgpt-account-id': 'fake-account',
      'x-codex-turn-metadata': JSON.stringify({ thread_id: THREAD, turn_id: TURN, model: 'gpt-6-sol' }),
    } });
    const res = Object.assign(new EventEmitter(), {
      destroyed: false, writableEnded: false, headersSent: false,
      writeHead() { this.headersSent = true; },
      write() {
        if (mode === 'write_throw') throw new Error('fake downstream write failure');
        queueMicrotask(() => this.emit('error', new Error('fake downstream drain failure')));
        return false;
      },
      end() { this.writableEnded = true; this.emit('close'); },
      destroy() { this.destroyed = true; this.emit('close'); },
    });
    try {
      await router.handle(req, res);
      assert.equal(records.filter((record) => record.code === 'response_completed').length, 1);
      assert.equal(router.snapshot().lastCode, 'response_completed');
      assert.equal(router.snapshot().stopped, false);
      assert.equal(router.snapshot().active, false);
      assert.equal(upstreamCancelled, true);
      assert.equal(res.destroyed, true);
    } finally { router.stop(); }
  }
});
