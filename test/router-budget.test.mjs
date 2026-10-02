import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, appendFile, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as budget from '../src/router-budget.mjs';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';

const threadId = '019c7a40-1234-7123-8123-123456789abc';

test('write failure retains safe filesystem code and blocks further reservations',async t=>{
 const {path}=await fixture();budget.initializeBudget(path,{threadId,usedRequests:0});
 const owner=budget.openBudget(path);
 const stub=t.mock.method(fs,'writeSync',()=>{throw Object.assign(Error('private-path-secret'),{code:'EIO'});});
 syncBuiltinESMExports();
 try{
  assert.throws(()=>owner.reserve(),e=>e.message==='BUDGET_WRITE_FAILED'&&e.storageCode==='EIO');
  assert.throws(()=>owner.reserve(),/BUDGET_UNAVAILABLE/);
  assert.equal(owner.snapshot().usedRequests,0);
 }finally{stub.mock.restore();syncBuiltinESMExports();owner.close();}
});
test('omitted limits create a persistent unlimited usage ledger across time and restart',async()=>{
  const {path}=await fixture();
  budget.initializeBudget(path,{threadId,usedRequests:0});
  let owner=budget.openBudget(path,{now:()=>Date.now()+365*86400_000});
  try{for(let n=0;n<105;n++)owner.reserve();}finally{owner.close();}
  assert.deepEqual(budget.readBudget(path),{threadId,maxRequests:null,usedRequests:105,expiresAt:null,remaining:null});
  owner=budget.openBudget(path);try{owner.reserve();}finally{owner.close();}
  assert.equal(budget.readBudget(path).usedRequests,106);
});
test('explicit unlimited migration appends without resetting usage and rejects stale or locked migration',async()=>{
  const {path}=await fixture();
  budget.initializeBudget(path,{threadId,maxRequests:1,usedRequests:1,expiresAt:2000},{now:()=>1000});
  const before=await readFile(path,'utf8');
  assert.equal(typeof budget.removeBudgetLimits,'function');
  const approval={threadId,expectedUsedRequests:1};
  const owner=budget.openBudget(path);
  try{assert.throws(()=>budget.removeBudgetLimits(path,approval),/BUDGET_LOCKED/);}finally{owner.close();}
  assert.throws(()=>budget.removeBudgetLimits(path,{...approval,expectedUsedRequests:0}),/BUDGET_MIGRATION_INVALID/);
  assert.throws(()=>budget.removeBudgetLimits(path,{...approval,threadId:'019c7a40-5678-7123-8123-123456789abc'}),/BUDGET_MIGRATION_INVALID/);
  assert.equal(budget.removeBudgetLimits(path,approval).remaining,null);
  const migrated=await readFile(path,'utf8');assert.ok(migrated.startsWith(before));
  budget.removeBudgetLimits(path,approval);assert.equal(await readFile(path,'utf8'),migrated);
  const next=budget.openBudget(path);try{next.reserve();}finally{next.close();}
  assert.equal(budget.readBudget(path).usedRequests,2);
});
test('malformed unlimited declarations and unrecognized versions are not interpreted as unlimited',async()=>{
  for(const patch of [{maxRequests:null,expiresAt:1000},{maxRequests:1,expiresAt:null},{maxRequests:null},{expiresAt:null},{usedRequests:-1}]){
    const {path}=await fixture();assert.throws(()=>budget.initializeBudget(path,{threadId,usedRequests:0,...patch}),/BUDGET_GRANT_INVALID/);
  }
  for(const header of [
    {type:'grant',version:1,threadId,maxRequests:null,expiresAt:null,usedRequests:0},
    {type:'grant',version:2,threadId,maxRequests:1,expiresAt:2000,usedRequests:0},
    {type:'grant',version:3,threadId,maxRequests:null,expiresAt:null,usedRequests:0},
  ]){const {path}=await fixture();await writeFile(path,JSON.stringify(header)+'\n');assert.throws(()=>budget.readBudget(path),/BUDGET_CORRUPT/);}
});
test('unlimited ledgers still reject corruption, counter overflow and attempts to append bounded extensions',async()=>{
  const {path}=await fixture();budget.initializeBudget(path,{threadId,usedRequests:Number.MAX_SAFE_INTEGER});
  const owner=budget.openBudget(path);try{assert.throws(()=>owner.reserve(),/BUDGET_WRITE_FAILED/);}finally{owner.close();}
  assert.throws(()=>budget.extendBudget(path,{operationId:'bad',threadId,expectedUsedRequests:Number.MAX_SAFE_INTEGER,expectedMaxRequests:null,additionalRequests:0,expiresAt:Date.now()+1000}),/BUDGET_EXTENSION_INVALID/);
  const before=await readFile(path,'utf8');await appendFile(path,'{"type":"reserve","usedRequests":1,"at":10}\n');
  assert.throws(()=>budget.readBudget(path),/BUDGET_CORRUPT/);
  assert.ok((await readFile(path,'utf8')).startsWith(before));
});
test('duplicate or foreign unlimited records and later extensions are rejected as corrupt',async()=>{
  for(const bad of ['duplicate','foreign','extension']){
    const {path}=await fixture();budget.initializeBudget(path,{threadId,maxRequests:1,usedRequests:1,expiresAt:2000},{now:()=>1000});
    budget.removeBudgetLimits(path,{threadId,expectedUsedRequests:1},{now:()=>3000});
    const record=bad==='extension'?{type:'extension',operationId:'bad',at:4000,threadId,expectedMaxRequests:null,expectedUsedRequests:1,additionalRequests:0,expiresAt:5000}:
      {type:'unlimited',at:4000,threadId:bad==='foreign'?'019c7a40-5678-7123-8123-123456789abc':threadId,expectedUsedRequests:1};
    await appendFile(path,JSON.stringify(record)+'\n');assert.throws(()=>budget.readBudget(path),/BUDGET_CORRUPT/);
  }
});
test('time-only renewal preserves allowance and history after expiry',async()=>{
  const {path}=await fixture();
  budget.initializeBudget(path,{threadId,maxRequests:8,usedRequests:3,expiresAt:2000},{now:()=>1000});
  const before=await readFile(path,'utf8');
  const approval={operationId:'time-only',threadId,expectedMaxRequests:8,expectedUsedRequests:3,additionalRequests:0,expiresAt:5000};
  const state=budget.extendBudget(path,approval,{now:()=>3000});
  assert.deepEqual(state,{threadId,maxRequests:8,usedRequests:3,remaining:5,expiresAt:5000});
  assert.ok((await readFile(path,'utf8')).startsWith(before));
  assert.throws(()=>budget.extendBudget(path,approval,{now:()=>3001}),/BUDGET_EXTENSION_EXISTS/);
  const owner=budget.openBudget(path,{now:()=>4000});owner.reserve();owner.close();
  assert.equal(budget.readBudget(path).remaining,4);
});
test('explicit extension preserves old ledger and usage, works after expiry, and cannot replay',async()=>{
  assert.equal(typeof budget.extendBudget,'function');
  const {path}=await fixture();
  budget.initializeBudget(path,{threadId,maxRequests:4,usedRequests:2,expiresAt:2000},{now:()=>1000});
  const before=await readFile(path,'utf8');
  const approval={operationId:'approve-1',threadId,expectedMaxRequests:4,expectedUsedRequests:2,additionalRequests:4,expiresAt:5000};
  const result=budget.extendBudget(path,approval,{now:()=>3000});
  assert.equal(result.usedRequests,2);assert.equal(result.maxRequests,8);assert.equal(result.remaining,6);
  assert.ok((await readFile(path,'utf8')).startsWith(before));
  assert.throws(()=>budget.extendBudget(path,approval,{now:()=>3001}),/BUDGET_EXTENSION_EXISTS/);
  const ledger=budget.openBudget(path,{now:()=>4000});ledger.reserve();ledger.close();
  assert.equal(budget.readBudget(path).usedRequests,3);
});

test('extensions reject concurrent owners, stale approvals, other task IDs and malformed limits',async()=>{
  assert.equal(typeof budget.extendBudget,'function');
  const {path}=await fixture();budget.initializeBudget(path,{threadId,maxRequests:4,usedRequests:2,expiresAt:2000},{now:()=>1000});
  const approval={operationId:'approve-1',threadId,expectedMaxRequests:4,expectedUsedRequests:2,additionalRequests:4,expiresAt:5000};
  const owner=budget.openBudget(path);assert.throws(()=>budget.extendBudget(path,approval,{now:()=>3000}),/BUDGET_LOCKED/);owner.close();
  for(const patch of [{threadId:'019c7a40-5678-7123-8123-123456789abc'},{expectedUsedRequests:1},{expectedMaxRequests:5},{additionalRequests:-1},{additionalRequests:100},{expiresAt:2999},{expiresAt:8_000_000},{secret:'private'}])
    assert.throws(()=>budget.extendBudget(path,{...approval,...patch},{now:()=>3000}),/BUDGET_EXTENSION_INVALID/);
  assert.equal(budget.readBudget(path).maxRequests,4);
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'router-budget-'));
  const path = join(dir, 'budget.jsonl');
  const grant = { threadId, maxRequests: 100, usedRequests: 8, expiresAt: Date.now() + 60_000 };
  return { path, grant };
}
test('budget is explicitly initialized, cannot overwrite, and restores reserved attempts', async () => {
  assert.equal(typeof budget.initializeBudget, 'function');
  const { path, grant } = await fixture();
  budget.initializeBudget(path, grant);
  assert.throws(() => budget.initializeBudget(path, grant), /BUDGET_EXISTS/);
  let ledger = budget.openBudget(path);
  assert.equal(ledger.snapshot().remaining, 92);
  ledger.reserve(); ledger.close();
  ledger = budget.openBudget(path);
  assert.equal(ledger.snapshot().usedRequests, 9);
  assert.equal(ledger.snapshot().expiresAt, grant.expiresAt);
  ledger.close();
});
test('exclusive ownership and corrupt/truncated records fail closed', async () => {
  assert.equal(typeof budget.openBudget, 'function');
  const { path, grant } = await fixture(); budget.initializeBudget(path, grant);
  const owner = budget.openBudget(path);
  assert.throws(() => budget.openBudget(path), /BUDGET_LOCKED/);
  owner.close();
  await appendFile(path, '{"sequence":');
  assert.throws(() => budget.openBudget(path), /BUDGET_CORRUPT/);
});
test('no refunds, expiration and budget exhaustion persist across restarts', async () => {
  assert.equal(typeof budget.readBudget, 'function');
  const { path, grant } = await fixture();
  budget.initializeBudget(path, { ...grant, maxRequests: 9 });
  const ledger = budget.openBudget(path); ledger.reserve(); ledger.close();
  const next = budget.openBudget(path);
  assert.throws(() => next.reserve(), /BUDGET_EXHAUSTED/); next.close();
  const expired = budget.openBudget(path, { now: () => grant.expiresAt });
  assert.throws(() => expired.reserve(), /BUDGET_EXPIRED/); expired.close();
  assert.equal(budget.readBudget(path).usedRequests, 9);
  assert.doesNotMatch(await readFile(path, 'utf8'), /Bearer|secret/);
});
test('invalid grants and missing ledgers cannot silently create new authorization', async () => {
  assert.equal(typeof budget.initializeBudget, 'function');
  const { path, grant } = await fixture();
  assert.throws(() => budget.openBudget(path), /BUDGET_UNAVAILABLE/);
  for (const patch of [{ usedRequests: -1 }, { usedRequests: 101 }, { maxRequests: 101 }, { threadId: 'bad' }, { expiresAt: Date.now() + 8_000_000 }, { key: 'secret' }])
    assert.throws(() => budget.initializeBudget(path, { ...grant, ...patch }), /BUDGET_GRANT_INVALID/);
});
