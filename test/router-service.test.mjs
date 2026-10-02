import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { initializeBudget, readBudget } from '../src/router-budget.mjs';
import * as service from '../src/router-service.mjs';

test('single Router accepts unlimited grant and stays running until explicitly stopped',async()=>{
  const {configPath}=await setup(),config=JSON.parse(await readFile(configPath,'utf8'));
  config.budgetPath=join(configPath,'..','unlimited.jsonl');config.adapterOptions.budgetPath=config.budgetPath;
  initializeBudget(config.budgetPath,{threadId:'019c7a40-1234-7123-8123-123456789abc',usedRequests:0});
  await writeFile(configPath,JSON.stringify(config));
  const state=await service.startRouter(configPath);
  try{
    assert.equal(state.expiresAt,null);assert.equal(state.remaining,null);
    for(let n=0;n<102;n++)assert.equal(await (await fetch(`http://127.0.0.1:${state.port}/`)).text(),'fixture');
    await new Promise(r=>setTimeout(r,350));assert.equal(service.routerStatus(configPath).state,'running');
  }finally{service.stopRouter(configPath);await waitStopped(configPath);}
  assert.equal(readBudget(config.budgetPath).usedRequests,102);
});

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'router-service-'));
  const budgetPath = join(dir, 'budget.jsonl');
  initializeBudget(budgetPath, { threadId:'019c7a40-1234-7123-8123-123456789abc',maxRequests:10,usedRequests:8,expiresAt:Date.now()+60_000 });
  const adapterPath = resolve('test/fixtures/router-adapter.mjs');
  const adapterSha256 = createHash('sha256').update(await readFile(adapterPath)).digest('hex');
  const configPath = join(dir,'config.json');
  await writeFile(configPath,JSON.stringify({budgetPath,adapterPath,adapterSha256,adapterOptions:{budgetPath}}));
  return { configPath, budgetPath };
}
async function waitStopped(configPath) {
  for(let i=0;i<100;i++) {
    const state=service.routerStatus(configPath);
    if(state.state==='stopped')return state;
    await new Promise(r=>setTimeout(r,50));
  }
  assert.fail('service did not stop');
}
test('detached start/status/stop and restart preserve budget and fixed expiry', async () => {
  assert.equal(typeof service.startRouter, 'function');
  const {configPath,budgetPath}=await setup();
  const first=await service.startRouter(configPath);
  try {
    assert.equal(first.state,'running');
    assert.notEqual(first.pid,process.pid);
    assert.equal(first.remaining,2);
    const response=await fetch(`http://127.0.0.1:${first.port}/`);
    assert.equal(response.status,200);await response.text();
    assert.equal(readBudget(budgetPath).usedRequests,9);
    const events=await readFile(budgetPath+'.'+first.runId+'.events.jsonl','utf8');
    assert.doesNotMatch(events,/Bearer|secret|private-prompt/);
    const receipt=JSON.parse(events.trim());
    assert.equal(receipt.route,'company');assert.equal(receipt.usedRequests,9);
    await assert.rejects(service.startRouter(configPath), /BUDGET_LOCKED/);
  } finally { service.stopRouter(configPath); await waitStopped(configPath); }
  const second=await service.startRouter(configPath);
  try {
    assert.notEqual(first.runId,second.runId);
    assert.equal(first.expiresAt,second.expiresAt);
    assert.equal(second.remaining,1);
    assert.equal(await (await fetch(`http://127.0.0.1:${second.port}/`)).text(),'fixture');
    const exhausted=await fetch(`http://127.0.0.1:${second.port}/`);
    assert.equal(exhausted.status,429);await exhausted.text();
    assert.equal(readBudget(budgetPath).usedRequests,10);
  } finally { service.stopRouter(configPath); await waitStopped(configPath); }
});
test('adapter mismatch refuses to load or consume budget, errors do not leak details', async () => {
  assert.equal(typeof service.startRouter,'function');
  const {configPath,budgetPath}=await setup();
  const config=JSON.parse(await readFile(configPath)); config.adapterSha256='0'.repeat(64);
  await writeFile(configPath,JSON.stringify(config));
  await assert.rejects(service.startRouter(configPath),/ROUTER_ADAPTER_CHANGED/);
  assert.equal(readBudget(budgetPath).usedRequests,8);
});

test('missing status with a lock is unknown, never claims not started or kills a PID',async()=>{
  const {configPath,budgetPath}=await setup();
  await writeFile(budgetPath+'.lock',JSON.stringify({pid:process.pid}));
  assert.equal(service.routerStatus(configPath).state,'unknown');
  assert.throws(()=>service.stopRouter(configPath),/ROUTER_NOT_RUNNING/);
  await assert.rejects(service.startRouter(configPath),/BUDGET_LOCKED/);
  assert.equal(readBudget(budgetPath).usedRequests,8);
});

test('expired and exhausted grants cannot be renewed by start',async()=>{
  for(const field of ['expiresAt','usedRequests']) {
    const {configPath,budgetPath}=await setup();
    const header=JSON.parse((await readFile(budgetPath,'utf8')).trim());
    if(field==='expiresAt')header.expiresAt=Date.now()-1;else header.usedRequests=header.maxRequests;
    await writeFile(budgetPath,JSON.stringify(header)+'\n');
    await assert.rejects(service.startRouter(configPath),field==='expiresAt'?/BUDGET_EXPIRED/:/BUDGET_EXHAUSTED/);
    assert.equal(readBudget(budgetPath)[field],header[field]);
  }
});
