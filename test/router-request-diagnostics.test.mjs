import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const id='11111111-1111-4111-8111-111111111111',run='22222222-2222-4222-8222-222222222222';
test('stale parent status never advertises old bindings as live or processing',async()=>{
 const {requestDiagnostics}=await import('../src/router-request-diagnostics.mjs');
 const root=await mkdtemp(join(tmpdir(),'router-stale-view-')),base=join(root,'workers.jsonl');
 await writeFile(base+'.'+run+'.events.jsonl',JSON.stringify({timestamp:1,threadId:id,stage:'failure',code:'cancelled'})+'\n');
 const r=requestDiagnostics({registryPath:base},{state:'unknown',runId:run,bindings:[{threadId:id,state:'running',active:true}]});
 assert.equal(r.workers[0].state,'unknown');assert.equal(r.workers[0].active,false);assert.equal(r.workers[0].failure.code,'cancelled');
});
test('failure retains allowlisted actual route across a subsequent model switch',async()=>{
 const {requestDiagnostics}=await import('../src/router-request-diagnostics.mjs');
 const root=await mkdtemp(join(tmpdir(),'router-route-view-')),base=join(root,'workers.jsonl');
 const events=[{timestamp:1,threadId:id,code:'outbound_reserved',route:'official',model:'gpt-6-sol'},
 {timestamp:2,threadId:id,stage:'failure',code:'transport_failed_before_headers',networkCode:'UND_ERR_CONNECT_TIMEOUT'},
 {timestamp:3,threadId:id,code:'outbound_reserved',route:'company',model:'gpt-6-astra_self'},
 {timestamp:4,threadId:id,stage:'failure',code:'upstream_http_error',route:'private-secret'}];
 await writeFile(base+'.'+run+'.events.jsonl',events.slice(0,3).map(JSON.stringify).join('\n')+'\n');
 const get=()=>requestDiagnostics({registryPath:base},{runId:run,bindings:[{threadId:id,state:'running',active:true}]}).workers[0];
 assert.equal(get().failure.route,'official');assert.equal(get().route,'company');
 await writeFile(base+'.'+run+'.events.jsonl',events.map(JSON.stringify).join('\n')+'\n');
 assert.equal(get().failure.route,'company');assert.doesNotMatch(JSON.stringify(get()),/private-secret/);
});
test('bounded diagnostics retain exact failure and omit arbitrary event contents',async()=>{
 const api=await import('../src/router-request-diagnostics.mjs').catch(()=>({}));
 assert.equal(typeof api.requestDiagnostics,'function');
 const root=await mkdtemp(join(tmpdir(),'router-request-view-')),base=join(root,'workers.jsonl');
 const events=[{timestamp:1,threadId:id,stage:'reserved',code:'outbound_reserved',model:'gpt-6-astra_self'},
 {timestamp:2,threadId:id,stage:'failure',code:'transport_failed_before_headers',networkCode:'ECONNRESET',elapsedMs:70784,secret:'private-secret'},
 {timestamp:3,threadId:id,stage:'failure',code:'transport_or_stream_error'},
 {timestamp:4,threadId:id,stage:'upstream',code:'response_completed'}];
 await writeFile(base+'.'+run+'.events.jsonl',events.map(JSON.stringify).join('\n')+'\n');
 const view=api.requestDiagnostics({registryPath:base},{runId:run,bindings:[{threadId:id,state:'running',active:false}]});
 assert.equal(view.workers[0].failure.code,'transport_failed_before_headers');
 assert.equal(view.workers[0].failure.networkCode,'ECONNRESET');
 assert.equal(view.workers[0].failure.elapsedMs,70784);
 assert.equal(view.workers[0].recovered,true);assert.doesNotMatch(JSON.stringify(view),/private-secret/);
});
test('missing diagnostic log is unknown rather than proof of healthy requests',async()=>{
 const api=await import('../src/router-request-diagnostics.mjs').catch(()=>({}));
 assert.equal(typeof api.requestDiagnostics,'function');
 const r=api.requestDiagnostics({registryPath:join(tmpdir(),'nonexistent-router.jsonl')},{runId:run,bindings:[]});
 assert.equal(r.available,false);
});
test('historical failure retains its model when a later request selects another model',async()=>{
 const {requestDiagnostics}=await import('../src/router-request-diagnostics.mjs');
 const root=await mkdtemp(join(tmpdir(),'router-model-view-')),base=join(root,'workers.jsonl');
 const events=[{timestamp:1,threadId:id,code:'outbound_reserved',model:'gpt-6-astra_self'},
 {timestamp:2,threadId:id,stage:'failure',code:'transport_failed_before_headers'},
 {timestamp:3,threadId:id,code:'outbound_reserved',model:'gpt-6-sol_self'}];
 await writeFile(base+'.'+run+'.events.jsonl',events.map(JSON.stringify).join('\n')+'\n');
 const row=requestDiagnostics({registryPath:base},{runId:run,bindings:[{threadId:id,state:'running',active:true}]}).workers[0];
 assert.equal(row.model,'gpt-6-sol_self');
 assert.equal(row.failure.model,'gpt-6-astra_self');
});
test('large log tail ignores partial records, foreign workers and incomplete final lines',async()=>{
 const {requestDiagnostics}=await import('../src/router-request-diagnostics.mjs');
 const root=await mkdtemp(join(tmpdir(),'router-tail-view-')),base=join(root,'workers.jsonl');
 const good={timestamp:2,threadId:id,stage:'failure',code:'stream_idle_timeout'};
 await writeFile(base+'.'+run+'.events.jsonl','x'.repeat(300000)+'\n'+JSON.stringify({...good,threadId:run})+'\n'+JSON.stringify(good)+'\n'+JSON.stringify({...good,timestamp:3,code:'first_byte_timeout'}));
 const view=requestDiagnostics({registryPath:base},{runId:run,bindings:[{threadId:id,state:'running'}]});
 assert.equal(view.workers.length,1);assert.equal(view.workers[0].failure.code,'stream_idle_timeout');
 assert.equal(requestDiagnostics({registryPath:base},{runId:id,bindings:[{threadId:id}]}).available,false);
});
