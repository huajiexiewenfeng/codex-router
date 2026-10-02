import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as api from '../src/worker-creation.mjs';
import {initializeRouterRegistry,readRouterRegistry} from '../src/router-registry.mjs';
import {readBudget} from '../src/router-budget.mjs';
import {routerStatus,stopRouter} from '../src/router-service.mjs';
const THREAD='019c7a40-1234-7123-8123-123456789abc';
test('explicit host home reaches preflight, creation and fresh-process history verification',async()=>{
 const f=await fixture('router'),seen=[],connect=f.deps.connect;
 f.request.codexHome=f.dir;
 f.deps.connect=async(exe,options)=>{seen.push(options?.codexHome);return connect(exe);};
 await api.planWorkerCreation(f.request,f.deps);
 await api.createWorkerCreation(f.request,f.deps);
 assert.deepEqual(seen,[f.dir,f.dir,f.dir]);
});
async function p0Fixture(){
 const f=await fixture('router');const {modelRegistry}=await import('./fixtures/router-model-registry.mjs');
 const registry=modelRegistry();registry.models[0].selectionId='gpt-6-sol_self';registry.models[0].catalogEntry.slug='gpt-6-sol_self';
 f.modelPath=join(f.dir,'models.json');f.bindingsPath=join(f.dir,'model-bindings.json');
 await writeFile(f.modelPath,JSON.stringify(registry));await writeFile(f.bindingsPath,'[]');
 const config=JSON.parse(await readFile(f.request.routerConfigPath,'utf8'));
 config.adapterOptions={modelRegistryPath:f.modelPath,bindingsPath:f.bindingsPath};await writeFile(f.request.routerConfigPath,JSON.stringify(config));return f;
}
test('P0 creation binds verified models before its initialization and keeps plan read-only',async()=>{
 const f=await p0Fixture();
 await api.planWorkerCreation(f.request,f.deps);assert.equal(await readFile(f.bindingsPath,'utf8'),'[]');
 const rpc=await f.deps.connect(),original=rpc.request;
 rpc.request=async(method,params)=>{if(method==='turn/start'){
  const bindings=JSON.parse(await readFile(f.bindingsPath,'utf8'));assert.deepEqual(bindings,[{hostId:'local',threadId:THREAD,allowedModels:['gpt-6-sol_self','two_self']}]);
 }return original(method,params);};
 await api.createWorkerCreation(f.request,f.deps);
});
test('P0 preflight rejects unconfigured models before any native creation',async()=>{
 const f=await p0Fixture(),r=JSON.parse(await readFile(f.modelPath,'utf8'));r.models.shift();await writeFile(f.modelPath,JSON.stringify(r));
 await assert.rejects(api.planWorkerCreation(f.request,f.deps),/WORKER_MODEL_UNAVAILABLE/);assert.equal(f.starts(),0);
});
test('P0 binding appends atomically, preserves other tasks and refuses competing writers',async()=>{
 const f=await p0Fixture(),{bindWorkerModels}=await import('../src/worker-model-binding.mjs');
 const options=JSON.parse(await readFile(f.request.routerConfigPath,'utf8')).adapterOptions;
 const prior={hostId:'local',threadId:'019c7a40-1234-7123-8123-123456789abd',allowedModels:['two_self']};
 await writeFile(f.bindingsPath,JSON.stringify([prior]));
 const results=await Promise.allSettled([bindWorkerModels(options,f.request.model,THREAD),bindWorkerModels(options,f.request.model,THREAD)]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 const values=JSON.parse(await readFile(f.bindingsPath,'utf8'));assert.deepEqual(values[0],prior);assert.equal(values.length,2);
 await assert.rejects(bindWorkerModels(options,f.request.model,THREAD),/WORKER_MODEL_BINDING_CONFLICT/);
});
test('P0 locked binding retains created task receipt and never sends initialization',async()=>{
 const f=await p0Fixture();await writeFile(f.bindingsPath+'.lock','existing');
 await assert.rejects(api.createWorkerCreation(f.request,f.deps),/WORKER_MODEL_BINDING_LOCKED/);
 const receipt=JSON.parse(await readFile(join(f.dir,'create-one.json'),'utf8'));
 assert.equal(receipt.threadId,THREAD);assert.equal(receipt.status,'needs-reconciliation');
 assert.equal(f.calls.some(([m])=>m==='turn/start'),false);assert.equal(await readFile(f.bindingsPath,'utf8'),'[]');
 assert.equal(await readFile(f.bindingsPath+'.lock','utf8'),'existing');
});
test('P0 corrupt model bindings fail during plan without writing or creating',async()=>{
 const f=await p0Fixture();await writeFile(f.bindingsPath,'corrupt');
 await assert.rejects(api.planWorkerCreation(f.request,f.deps),/WORKER_MODEL_BINDING_INVALID/);
 assert.equal(f.starts(),0);assert.equal(await readFile(f.bindingsPath,'utf8'),'corrupt');
});
async function fixture(mode='official'){
  const dir=await mkdtemp(join(tmpdir(),'worker-creation-')),registryPath=join(dir,'registry.jsonl'),routerConfigPath=join(dir,'router.json');
  initializeRouterRegistry(registryPath);
  const request={operationId:'create-one',hostId:'local',mode,title:'Worker-Test',model:mode==='router'?'gpt-6-sol_self':'gpt-6-sol',cwd:dir,receiptDirectory:dir,codexExecutable:process.execPath};
  const config={model:'gpt-6-sol',model_providers:{gateway_router:{base_url:'http://127.0.0.1:57643/v1',wire_api:'responses',requires_openai_auth:true,supports_websockets:false,request_max_retries:0,stream_max_retries:0,env_http_headers:{'X-Worker-Router-Token':'TEST_INGRESS'}}}};
  await writeFile(routerConfigPath,JSON.stringify({registryPath,port:57643,adapterPath:join(dir,'trusted-adapter.mjs'),adapterSha256:'0'.repeat(64),adapterOptions:{}}));
  if(mode==='router')Object.assign(request,{provider:'gateway_router',routerConfigPath,budget:{maxRequests:3,expiresAt:Date.now()+60_000}});
  request.initialization={authorized:true};
  const rollout=join(dir,'rollout.jsonl');
  const calls=[];let starts=0,wrong=false,wrongModel=false,failRegister=false,missing=false,failed=false;
  const rpc={close:async()=>{calls.push(['close']);},waitTurn:async()=>({id:THREAD,status:failed?'failed':'completed'}),request:async(method,params)=>{
    calls.push([method,params]);
    if(method==='config/read')return {config};
    if(method==='model/list')return {data:[{id:'gpt-6-sol'},{id:'gpt-6-sol_self'}]};
    const provider=wrong?'wrong':mode==='router'?'gateway_router':'openai';
    if(method==='thread/start'){starts++;return {model:wrongModel?'different-model':request.model,modelProvider:provider,thread:{id:THREAD,modelProvider:provider}};}
    if(method==='turn/start'){if(!missing)await writeFile(rollout,'{"type":"session_meta"}\n');return {turn:{id:THREAD}};}
    if(method==='thread/read')return {thread:{id:THREAD,modelProvider:provider,path:rollout,turns:[{id:THREAD,status:'completed'}]}};
    return {};
  }};
  const deps={connect:async()=>rpc,routerStatus:()=>({kind:'shared',state:'running',registryHealthy:true,port:57643,
    bindings:readRouterRegistry(registryPath).bindings.map(b=>({threadId:b.threadId,ready:!failRegister,remaining:readBudget(b.budgetPath).remaining}))}),bindingWaitMs:20};
  return {dir,request,config,calls,deps,starts:()=>starts,setWrong:()=>{wrong=true;},setWrongModel:()=>{wrongModel=true;},setBindingFailure:()=>{failRegister=true;},setMissing:()=>{missing=true;},setFailed:()=>{failed=true;},registryPath};
}
test('unspecified mode returns a question before opening RPC or creating anything',async()=>{
  assert.equal(typeof api.planWorkerCreation,'function');
  const connect=async()=>{throw Error('must not connect');};
  assert.equal((await api.planWorkerCreation({title:'Test'},{connect})).status,'needs_user_choice');
  assert.equal((await api.createWorkerCreation({title:'Test'},{connect})).status,'needs_user_choice');
});
test('plan rejects existing success, uncertain and corrupt receipts before RPC or a team claim',async()=>{
  for(const mode of ['official','router'])for(const content of ['{"status":"initialized-awaiting-desktop-confirmation"}','{"status":"needs-reconciliation"}','{broken']){
    const f=await fixture(mode);
    const path=join(f.dir,f.request.operationId+'.json');
    await writeFile(path,content);
    let connections=0;
    const connect=async()=>{connections++;return f.deps.connect();};
    await assert.rejects(api.planWorkerCreation(f.request,{...f.deps,connect}),/^Error: WORKER_CREATION_EXISTS$/);
    assert.equal(connections,0);
    assert.equal(await readFile(path,'utf8'),content);
  }
});

test('Router lifecycle composes plan, ensure, create and status without resetting another binding',async()=>{
  for(const initiallyRunning of [false,true]){
    const f=await fixture('router');delete f.request.budget;
    const {initializeBudget}=await import('../src/router-budget.mjs');
    const {registerRouterBudget}=await import('../src/router-registry.mjs');
    const previous=join(f.dir,'previous.budget.jsonl');
    initializeBudget(previous,{threadId:'019c7a40-1234-7123-8123-123456789abd',usedRequests:7});
    registerRouterBudget(f.registryPath,previous);
    const before=await readFile(previous,'utf8');
    const live=f.deps.routerStatus;let running=initiallyRunning,starts=0;
    f.deps.routerStatus=()=>running?live():{kind:'shared',state:'stopped',lockPresent:false};
    f.deps.startRouter=async()=>{starts++;running=true;};
    assert.equal((await api.planWorkerCreation(f.request,f.deps)).status,initiallyRunning?'ready_to_create':'needs_router_start');
    assert.equal((await api.ensureWorkerRouter(f.request,f.deps)).status,'ready_to_create');
    assert.equal(f.starts(),0);
    const created=await api.createWorkerCreation(f.request,f.deps);
    const status=await api.readWorkerCreationReceipt(join(f.dir,f.request.operationId+'.json'));
    assert.equal(status.threadId,created.threadId);
    assert.equal(status.status,'initialized-awaiting-desktop-confirmation');
    assert.equal(status.persistenceVerified,true);
    assert.equal(status.registered,false);assert.equal(status.desktopVerified,false);
    assert.equal(status.usagePolicy,'unlimited');
    const usage=readBudget(created.budgetPath);
    assert.equal(usage.maxRequests,null);assert.equal(usage.expiresAt,null);
    assert.equal(await readFile(previous,'utf8'),before);
    assert.equal(readRouterRegistry(f.registryPath).bindings.length,2);
    for(const entry of [api.planWorkerCreation,api.ensureWorkerRouter,api.createWorkerCreation]){
      await assert.rejects(entry(f.request,f.deps),/^Error: WORKER_CREATION_EXISTS$/);
    }
    assert.equal(starts,initiallyRunning?0:1);
    assert.equal(f.starts(),1);
    assert.equal(f.calls.filter(([m])=>m==='turn/start').length,1);
  }
});

test('official lifecycle never inspects or starts Router and does not allocate a binding',async()=>{
  const f=await fixture();
  f.deps.routerStatus=()=>assert.fail('official must not inspect Router');
  f.deps.startRouter=async()=>assert.fail('official must not start Router');
  assert.equal((await api.planWorkerCreation(f.request,f.deps)).status,'ready_to_create');
  assert.equal((await api.ensureWorkerRouter(f.request,f.deps)).routerStarted,false);
  const receipt=await api.createWorkerCreation(f.request,f.deps);
  assert.equal(receipt.provider,'openai');
  assert.equal(readRouterRegistry(f.registryPath).bindings.length,0);
  assert.equal(f.starts(),1);
});

test('failed initialization is recoverable by receipt, never by another plan or creation',async()=>{
  const f=await fixture('router');delete f.request.budget;f.setFailed();
  await api.ensureWorkerRouter(f.request,f.deps);
  await assert.rejects(api.createWorkerCreation(f.request,f.deps),/WORKER_INITIALIZATION_FAILED/);
  const path=join(f.dir,f.request.operationId+'.json');
  const before=await readFile(path,'utf8');
  const receipt=await api.readWorkerCreationReceipt(path);
  assert.equal(receipt.status,'needs-reconciliation');assert.equal(receipt.threadId,THREAD);
  for(const entry of [api.planWorkerCreation,api.ensureWorkerRouter,api.createWorkerCreation]){
    await assert.rejects(entry(f.request,f.deps),/^Error: WORKER_CREATION_EXISTS$/);
  }
  assert.equal(await readFile(path,'utf8'),before);
  assert.equal(f.starts(),1);
  assert.equal(f.calls.filter(([m])=>m==='turn/start').length,1);
});
test('official creation initializes only once and verifies persisted history after closing creator',async()=>{
  assert.equal(typeof api.createWorkerCreation,'function');
  const f=await fixture();const r=await api.createWorkerCreation(f.request,f.deps);
  assert.equal(r.status,'initialized-awaiting-desktop-confirmation');assert.equal(r.provider,'openai');
  assert.equal(r.title,'Worker-Test');assert.equal(r.desktopVerified,false);
  assert.equal(f.calls.filter(([m])=>m==='turn/start').length,1);
  assert.equal(r.sendsModelRequest,true);assert.equal(r.persistenceVerified,true);
  assert.ok(f.calls.findIndex(([m])=>m==='close')<f.calls.findIndex(([m,p])=>m==='thread/read'&&p.includeTurns));
  assert.equal(Object.hasOwn(f.calls.find(([m])=>m==='thread/start')[1],'allowProviderModelFallback'),false);
  await assert.rejects(api.createWorkerCreation(f.request,f.deps),/WORKER_CREATION_EXISTS/);
  assert.equal(f.starts(),1);
});
test('Router creation adds prefix, binds only returned task and explicitly requested allowance',async()=>{
  assert.equal(typeof api.createWorkerCreation,'function');
  const f=await fixture('router');const r=await api.createWorkerCreation(f.request,f.deps);
  assert.equal(r.status,'initialized-awaiting-desktop-confirmation');assert.equal(r.title,'Router-Worker-Test');
  assert.equal(r.provider,'gateway_router');assert.equal(r.threadId,THREAD);
  const binding=readRouterRegistry(f.registryPath).bindings[0];
  const budget=readBudget(binding.budgetPath);
  assert.equal(budget.threadId,THREAD);assert.equal(budget.maxRequests,3);assert.equal(budget.usedRequests,0);
  assert.equal(f.calls.filter(([m])=>m==='turn/start').length,1);
});
test('wrong route or failed binding retains real ID and blocks silent recreation',async()=>{
  assert.equal(typeof api.createWorkerCreation,'function');
  for(const wrong of [true,false]){
    const f=await fixture('router');if(wrong)f.setWrong();else f.setBindingFailure();
    await assert.rejects(api.createWorkerCreation(f.request,f.deps),wrong?/WORKER_ROUTE_MISMATCH/:/WORKER_ROUTER_BINDING_PENDING/);
    const receipt=JSON.parse(await readFile(join(f.dir,'create-one.json'),'utf8'));
    assert.equal(receipt.threadId,THREAD);assert.equal(receipt.status,'needs-reconciliation');
    await assert.rejects(api.createWorkerCreation(f.request,f.deps),/WORKER_CREATION_EXISTS/);assert.equal(f.starts(),1);
  }
});
test('official override, bad credentials and legacy single binding are refused before thread/start',async()=>{
  assert.equal(typeof api.planWorkerCreation,'function');
  const f=await fixture();f.config.model_providers.openai={base_url:'https://wrong.example'};
  await assert.rejects(api.planWorkerCreation(f.request,f.deps),/WORKER_OFFICIAL_OVERRIDE/);
  const r=await fixture('router');delete r.request.budget;
  assert.equal((await api.planWorkerCreation(r.request,r.deps)).usagePolicy,'unlimited');
  r.request.budget={maxRequests:3,expiresAt:Date.now()+60_000};
  await assert.rejects(api.planWorkerCreation({...r.request,apiKey:'do-not-print'},r.deps),/^Error: WORKER_REQUEST_INVALID$/);
  await assert.rejects(api.planWorkerCreation(r.request,{...r.deps,routerStatus:()=>({kind:'single',state:'running'})}),/WORKER_SHARED_ROUTER_REQUIRED/);
  assert.equal(r.starts(),0);
});

test('Router creation needs no expiry or request limit and preserves explicit initialization authorization',async()=>{
  const f=await fixture('router');delete f.request.budget;
  const plan=await api.planWorkerCreation(f.request,f.deps);
  assert.equal(plan.usagePolicy,'unlimited');
  assert.equal(plan.initialization.countsAgainstRouterBudget,false);
  const result=await api.createWorkerCreation(f.request,f.deps);
  const ledger=readBudget(result.budgetPath);
  assert.equal(ledger.maxRequests,null);assert.equal(ledger.expiresAt,null);assert.equal(ledger.remaining,null);
  assert.equal(ledger.threadId,THREAD);assert.equal(result.usagePolicy,'unlimited');
});

test('a returned model fallback is rejected without a model turn or task registration',async()=>{
  const f=await fixture('router');f.setWrongModel();
  await assert.rejects(api.createWorkerCreation(f.request,f.deps),/WORKER_ROUTE_MISMATCH/);
  assert.equal(readRouterRegistry(f.registryPath).bindings.length,0);
  assert.equal(f.calls.some(([m])=>m==='turn/start'),false);
});

test('missing initialization authorization prevents even task creation',async()=>{
  const f=await fixture('router');delete f.request.initialization;
  const plan=await api.planWorkerCreation(f.request,f.deps);
  assert.equal(plan.status,'needs_initialization_authorization');
  assert.equal(plan.sendsModelRequest,false);
  await assert.rejects(api.createWorkerCreation(f.request,f.deps),/WORKER_INITIALIZATION_AUTH_REQUIRED/);
  assert.equal(f.starts(),0);assert.equal(readRouterRegistry(f.registryPath).bindings.length,0);
});

test('missing rollout or unsuccessful first turn is not reported as initialized and is not retried',async()=>{
  for(const missing of [true,false]){
    const f=await fixture('router');if(missing)f.setMissing();else f.setFailed();
    await assert.rejects(api.createWorkerCreation(f.request,f.deps),missing?/WORKER_PERSISTENCE_UNVERIFIED/:/WORKER_INITIALIZATION_FAILED/);
    const receipt=JSON.parse(await readFile(join(f.dir,'create-one.json'),'utf8'));
    assert.equal(receipt.status,'needs-reconciliation');assert.equal(receipt.threadId,THREAD);
    assert.equal(f.calls.filter(([m])=>m==='turn/start').length,1);
    await assert.rejects(api.createWorkerCreation(f.request,f.deps),/WORKER_CREATION_EXISTS/);
  }
});

test('fresh process history failure retains initialization ID and never claims desktop success',async()=>{
  const f=await fixture();let connections=0;
  const connect=async()=>{connections++;if(connections===1)return f.deps.connect();return {close:async()=>{},request:async()=>{throw Error('private failure');}};};
  await assert.rejects(api.createWorkerCreation(f.request,{...f.deps,connect}),/^Error: WORKER_PERSISTENCE_UNVERIFIED$/);
  const r=await api.readWorkerCreationReceipt(join(f.dir,'create-one.json'));
  assert.equal(r.initializationTurnId,THREAD);assert.equal(r.sendsModelRequest,true);
  assert.equal(r.persistenceVerified,false);assert.equal(r.desktopVerified,false);
  assert.equal(f.calls.filter(([m])=>m==='turn/start').length,1);
});

test('stopped Router plan is read-only; ensure starts once and never creates a thread',async()=>{
  for(const state of ['stopped','not_started']){
    const f=await fixture('router');delete f.request.budget;
    const live=f.deps.routerStatus;let started=0;
    f.deps.routerStatus=()=>started?live():{kind:'shared',state,lockPresent:false,port:0};
    f.deps.startRouter=async path=>{assert.equal(path,f.request.routerConfigPath);started++;};
    const plan=await api.planWorkerCreation(f.request,f.deps);
    assert.equal(plan.status,'needs_router_start');assert.equal(started,0);
    const result=await api.ensureWorkerRouter(f.request,f.deps);
    assert.equal(result.status,'ready_to_create');assert.equal(result.routerStarted,true);
    assert.equal(result.createsThread,false);assert.equal(result.sendsModelRequest,false);
    assert.equal(started,1);assert.equal(f.starts(),0);
    assert.equal(readRouterRegistry(f.registryPath).bindings.length,0);
    assert.equal((await api.ensureWorkerRouter(f.request,f.deps)).routerStarted,false);
    assert.equal(started,1);
  }
});

test('ensure refuses unknown, stopping, unhealthy or locked Router before starting',async()=>{
  assert.equal(typeof api.ensureWorkerRouter,'function');
  for(const status of [{state:'unknown',lockPresent:false},{state:'stopped',lockPresent:true},
    {state:'stopped',lockPresent:false,active:true},{state:'stopped',lockPresent:false,stopRequested:true},
    {state:'stopped',lockPresent:false,registryHealthy:false},{state:'running',registryHealthy:true,stopRequested:true}]){
    const f=await fixture('router');let started=0;
    f.deps.routerStatus=()=>({kind:'shared',port:57643,...status});
    f.deps.startRouter=async()=>{started++;};
    await assert.rejects(api.ensureWorkerRouter(f.request,f.deps),/WORKER_ROUTER_UNAVAILABLE/);
    assert.equal(started,0);assert.equal(f.starts(),0);
  }
});

test('ensure checks authorization, model and provider before service side effects',async()=>{
  assert.equal(typeof api.ensureWorkerRouter,'function');
  for(const issue of ['authorization','model','provider']){
    const f=await fixture('router');let started=0;
    f.deps.routerStatus=()=>({kind:'shared',state:'not_started',lockPresent:false});
    f.deps.startRouter=async()=>{started++;};
    if(issue==='authorization')delete f.request.initialization;
    if(issue==='model')f.request.model='not-in-catalog';
    if(issue==='provider')f.config.model_providers.gateway_router.base_url='http://127.0.0.1:1111/v1';
    await assert.rejects(api.ensureWorkerRouter(f.request,f.deps),new RegExp(issue==='authorization'?'WORKER_INITIALIZATION_AUTH_REQUIRED':issue==='model'?'WORKER_MODEL_UNAVAILABLE':'WORKER_PROVIDER_INVALID'));
    assert.equal(started,0);assert.equal(f.starts(),0);
  }
});

test('ensure masks startup failures and verifies readiness after the start call',async()=>{
  assert.equal(typeof api.ensureWorkerRouter,'function');
  for(const throws of [true,false]){
    const f=await fixture('router');let started=0;
    f.deps.routerStatus=()=>({kind:'shared',state:'stopped',lockPresent:false});
    f.deps.startRouter=async()=>{started++;if(throws)throw Error('secret raw transport error');};
    await assert.rejects(api.ensureWorkerRouter(f.request,f.deps),throws?/^Error: WORKER_ROUTER_START_FAILED$/:/^Error: WORKER_ROUTER_UNAVAILABLE$/);
    assert.equal(started,1);assert.equal(f.starts(),0);
  }
});

test('official ensure never touches Router and existing receipts require reconciliation',async()=>{
  assert.equal(typeof api.ensureWorkerRouter,'function');
  const f=await fixture();let started=0;
  f.deps.startRouter=async()=>{started++;};
  const result=await api.ensureWorkerRouter(f.request,f.deps);
  assert.equal(result.routerStarted,false);assert.equal(f.starts(),0);assert.equal(started,0);
  await writeFile(join(f.dir,'create-one.json'),'{}');
  await assert.rejects(api.ensureWorkerRouter(f.request,f.deps),/WORKER_CREATION_EXISTS/);
  assert.equal(f.starts(),0);
});

test('real status parsing blocks corrupt snapshots instead of auto-starting',async()=>{
  const f=await fixture('router');let started=0;
  await writeFile(f.registryPath+'.status.json','{broken');
  f.deps.routerStatus=()=>routerStatus(f.request.routerConfigPath);
  f.deps.startRouter=async()=>{started++;};
  await assert.rejects(api.ensureWorkerRouter(f.request,f.deps),/WORKER_ROUTER_UNAVAILABLE/);
  assert.equal(started,0);assert.equal(f.starts(),0);
  assert.equal(await readFile(f.registryPath+'.status.json','utf8'),'{broken');
});

test('real stop request for the active generation blocks reuse before heartbeat updates',async()=>{
  const f=await fixture('router');
  const snapshot={runId:THREAD,pid:123,updatedAt:Date.now(),state:'running',port:57643,registryHealthy:true,bindings:[]};
  await writeFile(f.registryPath+'.status.json',JSON.stringify(snapshot));
  await writeFile(f.registryPath+'.service.lock','fixture-only');
  f.deps.routerStatus=()=>routerStatus(f.request.routerConfigPath);
  f.deps.startRouter=async()=>assert.fail('must not start');
  await writeFile(f.registryPath+'.stop.json',JSON.stringify({runId:'019c7a40-1234-7123-8123-123456789abd'}));
  assert.equal((await api.ensureWorkerRouter(f.request,f.deps)).routerStarted,false);
  stopRouter(f.request.routerConfigPath);
  await assert.rejects(api.ensureWorkerRouter(f.request,f.deps),/WORKER_ROUTER_UNAVAILABLE/);
  assert.equal(f.starts(),0);
});
