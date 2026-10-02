import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,appendFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {initializeBudget,readBudget} from '../src/router-budget.mjs';
import {initializeRouterRegistry,registerRouterBudget} from '../src/router-registry.mjs';
import {startRouter,stopRouter,routerStatus,serveRouter} from '../src/router-service.mjs';
import {createWorkerCreation} from '../src/worker-creation.mjs';
const A='019c7a40-1234-7123-8123-123456789abc',B='019c7a40-5678-7123-8123-123456789abc';
test('shared ledger write failure exposes a safe local error and isolates the binding',async t=>{
 const f=await fixture();registerRouterBudget(f.registryPath,f.a);registerRouterBudget(f.registryPath,f.b);
 const service=await serveRouter(f.configPath),realWrite=fs.writeSync;
 const stub=t.mock.method(fs,'writeSync',(fd,data,...args)=>{
  if(String(data).includes('"type":"reserve"'))throw Object.assign(Error('private-secret-path'),{code:'EIO'});
  return realWrite(fd,data,...args);
 });syncBuiltinESMExports();
 try{
  await request(service.status().port,A);
  stub.mock.restore();syncBuiltinESMExports();
  const s=await until(f.configPath,s=>s.bindings.find(b=>b.threadId===A)?.state==='unavailable');
  assert.equal(s.bindings.find(b=>b.threadId===A).error,'BUDGET_WRITE_FAILED');
  const r=await fetch(`http://127.0.0.1:${s.port}/v1/responses`,{method:'POST',headers:{'x-codex-turn-metadata':JSON.stringify({thread_id:A})},body:'{}'});
  assert.equal(r.status,503);assert.equal((await r.json()).error,'local_storage_failed');
  assert.equal(await request(s.port,B),200);assert.equal(readBudget(f.a).usedRequests,0);
  const raw=await readFile(f.registryPath+'.'+s.runId+'.events.jsonl','utf8');
  assert.equal(raw.trim().split('\n').map(JSON.parse).find(e=>e.code==='local_storage_failed').storageCode,'EIO');
  assert.doesNotMatch(raw,/private-secret/);
 }finally{stub.mock.restore();syncBuiltinESMExports();await service.close();}
});
test('unlimited shared binding accepts over 100 requests and survives restart with isolation',async()=>{
  const f=await fixture(),path=join(f.a,'..','unlimited.jsonl');
  initializeBudget(path,{threadId:A,usedRequests:0});registerRouterBudget(f.registryPath,path);
  let state=await startRouter(f.configPath);
  try{
    assert.equal(state.bindings[0].ready,true);assert.equal(state.bindings[0].remaining,null);
    for(let n=0;n<102;n++)assert.equal(await request(state.port,A),200);
    assert.equal(await request(state.port,B),403);assert.equal(readBudget(path).usedRequests,102);
  }finally{stopRouter(f.configPath);await until(f.configPath,s=>s.state==='stopped'&&!s.lockPresent);}
  state=await startRouter(f.configPath);
  try{assert.equal(state.bindings[0].usedRequests,102);assert.equal(await request(state.port,A),200);}
  finally{stopRouter(f.configPath);await until(f.configPath,s=>s.state==='stopped'&&!s.lockPresent);}
  assert.equal(readBudget(path).usedRequests,103);
});
for(const failingMethod of ['close','stop'])test(`${failingMethod} failure releases every task lock and preserves budgets for restart`,async()=>{
  const f=await fixture(),config=JSON.parse(await readFile(f.configPath,'utf8'));
  config.adapterOptions[failingMethod+'FailureThreadId']=A;await writeFile(f.configPath,JSON.stringify(config));
  registerRouterBudget(f.registryPath,f.a);registerRouterBudget(f.registryPath,f.b);
  const before=await Promise.all([f.a,f.b].map(p=>readFile(p,'utf8')));
  const service=await serveRouter(f.configPath);
  let failure;try{await service.close();}catch(error){failure=error;}
  assert.deepEqual([f.a,f.b].map(p=>existsSync(p+'.lock')),[false,false]);
  assert.equal(existsSync(f.registryPath+'.service.lock'),false);
  assert.equal(failure?.message,'ROUTER_CLEANUP_FAILED');
  const diagnostic=await readFile(f.registryPath+'.lifecycle-errors.jsonl','utf8');
  assert.doesNotMatch(diagnostic,/fixture-private-secret/);
  assert.equal(JSON.parse(diagnostic.trim()).code,'ROUTER_CLEANUP_FAILED');
  await assert.rejects(service.close(),/^Error: ROUTER_CLEANUP_FAILED$/);
  assert.equal(routerStatus(f.configPath).state,'stopped');
  assert.deepEqual(await Promise.all([f.a,f.b].map(p=>readFile(p,'utf8'))),before);
  delete config.adapterOptions[failingMethod+'FailureThreadId'];await writeFile(f.configPath,JSON.stringify(config));
  const restarted=await serveRouter(f.configPath);
  try{assert.ok(restarted.status().bindings.every(b=>b.ready));}finally{await restarted.close();}
});
test('transport diagnostic persists safe code without retrying or refunding failed attempt',async()=>{
  const f=await fixture(),config=JSON.parse(await readFile(f.configPath,'utf8'));
  config.adapterOptions.transportFailure=true;await writeFile(f.configPath,JSON.stringify(config));
  registerRouterBudget(f.registryPath,f.a);const state=await startRouter(f.configPath);
  try{
    assert.equal(await request(state.port,A),503);
    const raw=await readFile(f.registryPath+'.'+state.runId+'.events.jsonl','utf8');
    const event=raw.trim().split('\n').map(JSON.parse).find(e=>e.code==='transport_failed_before_headers');
    assert.equal(event.networkCode,'UND_ERR_CONNECT_TIMEOUT');
    assert.equal(event.threadId,A);assert.equal(event.usedRequests,1);
    assert.ok(Number.isInteger(event.elapsedMs));assert.doesNotMatch(raw,/fixture-private-secret/);
    assert.equal(readBudget(f.a).usedRequests,1);assert.equal(readBudget(f.b).usedRequests,0);
  }finally{stopRouter(f.configPath);await until(f.configPath,s=>s.state==='stopped'&&!s.lockPresent);}
});
async function until(config,predicate){for(let n=0;n<100;n++){const s=routerStatus(config);if(predicate(s))return s;await new Promise(r=>setTimeout(r,50));}assert.fail('state wait timed out');}
async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'shared-router-')),registryPath=join(dir,'registry.jsonl'),configPath=join(dir,'config.json');
  initializeRouterRegistry(registryPath);
  const adapterPath=resolve('test/fixtures/shared-router-adapter.mjs');
  const adapterSha256=createHash('sha256').update(await readFile(adapterPath)).digest('hex');
  await writeFile(configPath,JSON.stringify({registryPath,port:0,adapterPath,adapterSha256,adapterOptions:{}}));
  const a=join(dir,'a.jsonl'),b=join(dir,'b.jsonl');
  initializeBudget(a,{threadId:A,maxRequests:1,usedRequests:0,expiresAt:Date.now()+60_000});
  initializeBudget(b,{threadId:B,maxRequests:2,usedRequests:0,expiresAt:Date.now()+60_000});
  return {configPath,registryPath,a,b};
}
async function request(port,threadId){const res=await fetch(`http://127.0.0.1:${port}/v1/responses`,{method:'POST',headers:{'x-codex-turn-metadata':JSON.stringify({thread_id:threadId})},body:'{}'});await res.text();return res.status;}
test('shared listener registers new tasks without restart, keeps budgets isolated, and restores them',async()=>{
  const f=await fixture();let state=await startRouter(f.configPath);
  try {
    assert.equal(state.kind,'shared');assert.deepEqual(state.bindings,[]);
    assert.equal(await request(state.port,A),403);
    registerRouterBudget(f.registryPath,f.a);registerRouterBudget(f.registryPath,f.b);
    state=await until(f.configPath,s=>s.bindings.length===2&&s.bindings.every(b=>b.ready));
    assert.equal(await request(state.port,A),200);assert.equal(await request(state.port,A),429);
    assert.equal(readBudget(f.b).usedRequests,0);
    assert.equal(await request(state.port,B),200);assert.equal(readBudget(f.b).remaining,1);
    await assert.rejects(startRouter(f.configPath),/ROUTER_SERVICE_LOCKED/);
  } finally {stopRouter(f.configPath);await until(f.configPath,s=>s.state==='stopped'&&!s.lockPresent);}
  state=await startRouter(f.configPath);
  try {
    assert.equal(state.bindings.find(b=>b.threadId===A).remaining,0);
    assert.equal(state.bindings.find(b=>b.threadId===B).remaining,1);
    assert.equal(await request(state.port,A),429);
    assert.equal(await request(state.port,B),200);
  } finally {stopRouter(f.configPath);await until(f.configPath,s=>s.state==='stopped'&&!s.lockPresent);}
});
test('damaged registry blocks dispatch without charging registered tasks',async()=>{
  const f=await fixture();registerRouterBudget(f.registryPath,f.a);
  const state=await startRouter(f.configPath);
  try {
    await appendFile(f.registryPath,'{"broken":');
    await new Promise(r=>setTimeout(r,600));
    assert.equal(await request(state.port,A),503);assert.equal(readBudget(f.a).usedRequests,0);
  }finally{stopRouter(f.configPath);await until(f.configPath,s=>s.state==='stopped'&&!s.lockPresent);}
});

test('creation registers a new task with the real shared manager without spending another task allowance',async()=>{
  const f=await fixture();registerRouterBudget(f.registryPath,f.a);
  const state=await startRouter(f.configPath);
  try {
    const dir=await mkdtemp(join(tmpdir(),'worker-shared-integration-'));
    const req={mode:'router',operationId:'new-worker',hostId:'local',title:'Worker-New',model:'gpt-6-sol_self',provider:'router_test',
      cwd:dir,receiptDirectory:dir,codexExecutable:process.execPath,routerConfigPath:f.configPath,budget:{maxRequests:3,expiresAt:Date.now()+60_000},initialization:{authorized:true}};
    const rollout=join(dir,'rollout.jsonl');
    const calls=[];
    const rpc={close:async()=>{},waitTurn:async()=>({id:B,status:'completed'}),request:async(method,params)=>{
      calls.push(method);
      if(method==='config/read')return {config:{model_providers:{router_test:{base_url:`http://127.0.0.1:${state.port}/v1`,wire_api:'responses',requires_openai_auth:true,
        supports_websockets:false,request_max_retries:0,stream_max_retries:0,env_http_headers:{'X-Worker-Router-Token':'FIXTURE'}}}}};
      if(method==='model/list')return {data:[{id:req.model}]};
      if(method==='thread/start')return {model:req.model,modelProvider:req.provider,thread:{id:B,modelProvider:req.provider}};
      if(method==='turn/start'){
        assert.equal(await request(state.port,B),200);
        await writeFile(rollout,'{"type":"session_meta"}\n');
        return {turn:{id:B}};
      }
      if(method==='thread/read')return {thread:{id:B,modelProvider:req.provider,path:rollout,turns:[{id:B,status:'completed'}]}};
      return {};
    }};
    const result=await createWorkerCreation(req,{connect:async()=>rpc});
    assert.equal(result.status,'initialized-awaiting-desktop-confirmation');
    assert.equal(readBudget(result.budgetPath).usedRequests,1);assert.equal(readBudget(f.a).usedRequests,0);
    assert.equal(calls.filter(m=>m==='turn/start').length,1);
    assert.equal(await request(state.port,B),200);assert.equal(readBudget(result.budgetPath).usedRequests,2);
    assert.equal(readBudget(f.a).remaining,1);
  }finally{stopRouter(f.configPath);await until(f.configPath,s=>s.state==='stopped'&&!s.lockPresent);}
});

test('a new binding initialization failure stays isolated and exposes only a fixed safe code',async()=>{
  const f=await fixture();const config=JSON.parse(await readFile(f.configPath,'utf8'));
  config.adapterOptions.failThreadId=B;await writeFile(f.configPath,JSON.stringify(config));
  registerRouterBudget(f.registryPath,f.a);const state=await startRouter(f.configPath);
  try {
    registerRouterBudget(f.registryPath,f.b);
    const updated=await until(f.configPath,s=>s.bindings.length===2);
    assert.equal(updated.registryHealthy,true);
    assert.equal(updated.bindings.find(b=>b.threadId===B).state,'unavailable');
    assert.doesNotMatch(JSON.stringify(updated),/fixture-private-secret/);
    assert.equal(await request(state.port,A),200);assert.equal(await request(state.port,B),503);
    assert.equal(readBudget(f.b).usedRequests,0);
  }finally{stopRouter(f.configPath);await until(f.configPath,s=>s.state==='stopped'&&!s.lockPresent);}
});
