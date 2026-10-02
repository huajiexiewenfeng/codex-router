import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync,utimesSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createDesktopServiceRecovery} from '../src/desktop-service-recovery.mjs';
const runId='11111111-1111-4111-8111-111111111111';
test('recover stale unlocked status, preserving a different generation stop and ledger',async t=>{
 const f=fixture(t);rmSync(f.base+'.service.lock');
 const foreign=JSON.stringify({runId:'22222222-2222-4222-8222-222222222222'});
 writeFileSync(f.base+'.stop.json',foreign);const ledger=readFileSync(f.budget),saved=readFileSync(f.base+'.status.json');
 const p=await f.api.prepare();assert.equal(p.lockCount,1);
 const r=await f.api.recover({token:p.token,confirmed:true});
 assert.equal(r.state,'stopped');assert.equal(existsSync(f.base+'.service.lock'),false);
 assert.equal(readFileSync(f.base+'.stop.json','utf8'),foreign);assert.deepEqual(readFileSync(f.budget),ledger);
 assert.deepEqual(readFileSync(join(r.backupPath,'status.json')),saved);
});
for(const [label,overrides] of [['live',{isProcessAbsent:async()=>false}],['busy',{isPortFree:async()=>false}]])test('unlocked stale status refuses '+label,async t=>{
 const f=fixture(t,overrides);rmSync(f.base+'.service.lock');await assert.rejects(f.api.prepare(),/RECOVERY/);
 assert.equal(JSON.parse(readFileSync(f.base+'.status.json')).state,'running');
});
test('unlocked recovery refuses a new service lock after preparation',async t=>{
 const f=fixture(t);rmSync(f.base+'.service.lock');const p=await f.api.prepare();writeFileSync(f.base+'.service.lock','new owner');
 await assert.rejects(f.api.recover({token:p.token,confirmed:true}),/RECOVERY/);assert.equal(readFileSync(f.base+'.service.lock','utf8'),'new owner');
});
function fixture(t,overrides={}) {
 const dir=mkdtempSync(join(tmpdir(),'router-recovery-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const configPath=join(dir,'config.json'),base=join(dir,'registry'),budget=join(dir,'budget');
 writeFileSync(configPath,JSON.stringify({registryPath:base,port:12345,adapterPath:join(dir,'adapter.mjs'),adapterSha256:'a'.repeat(64),adapterOptions:{}}));
 writeFileSync(base,'{"schemaVersion":1}\n'+JSON.stringify({threadId:runId,budgetPath:budget})+'\n');
 writeFileSync(budget,JSON.stringify({type:'grant',version:2,threadId:runId,maxRequests:null,expiresAt:null,usedRequests:0})+'\n');
 writeFileSync(base+'.service.lock','');utimesSync(base+'.service.lock',new Date(1000),new Date(1000));
 const stamp=Date.now()+1000,now=()=>stamp+61000;
 writeFileSync(base+'.status.json',JSON.stringify({runId,pid:123456789,state:'running',updatedAt:stamp,port:12345,bindings:[]}));
 writeFileSync(base+'.stop.json',JSON.stringify({runId}));
 writeFileSync(budget+'.lock',JSON.stringify({pid:123456789})+'\n');
 return {base,budget,configPath,api:createDesktopServiceRecovery({configPath,now,isProcessAbsent:async()=>true,isPortFree:async()=>true,...overrides})};
}
test('prepare is read-only; confirmed recovery preserves ledger and backs up original state',async t=>{
 const f=fixture(t),ledger=readFileSync(f.budget),status=readFileSync(f.base+'.status.json');
 const p=await f.api.prepare();assert.equal(existsSync(f.base+'.service.lock'),true);
 await assert.rejects(f.api.recover({token:p.token}),/CONFIRMATION/);
 const result=await f.api.recover({token:p.token,confirmed:true});
 assert.equal(result.state,'stopped');assert.equal(existsSync(f.base+'.service.lock'),false);
 assert.equal(existsSync(f.budget+'.lock'),false);assert.equal(existsSync(f.base+'.stop.json'),false);
 assert.deepEqual(readFileSync(f.budget),ledger);assert.equal(JSON.parse(readFileSync(f.base+'.status.json')).state,'stopped');
 assert.deepEqual(readFileSync(join(result.backupPath,'status.json')),status);
});
for(const [name,overrides] of [['live process',{isProcessAbsent:async()=>false}],['permission unknown',{isProcessAbsent:async()=>{throw Error('EPERM');}}],['busy port',{isPortFree:async()=>false}]])test('refuse '+name,async t=>{
 const f=fixture(t,overrides);await assert.rejects(f.api.prepare(),/RECOVERY/);assert.ok(existsSync(f.base+'.service.lock'));
});
test('changed snapshots and foreign budget owner fail closed',async t=>{
 const f=fixture(t),p=await f.api.prepare();writeFileSync(f.budget+'.lock','{"pid":42}\n');
 await assert.rejects(f.api.recover({token:p.token,confirmed:true}),/RECOVERY/);assert.ok(existsSync(f.base+'.service.lock'));
 await assert.rejects(f.api.prepare(),/RECOVERY/);
});
test('foreign stop generation fails closed',async t=>{
 const f=fixture(t);writeFileSync(f.base+'.stop.json','{"runId":"foreign"}');await assert.rejects(f.api.prepare(),/RECOVERY/);
});
test('fresh heartbeat refuses even a missing PID',async t=>{
 const f=fixture(t,{now:Date.now});await assert.rejects(f.api.prepare(),/STATUS_AMBIGUOUS/);
});
test('default process probe refuses this live test process',async t=>{
 const f=fixture(t,{isProcessAbsent:undefined});
 const status=JSON.parse(readFileSync(f.base+'.status.json'));status.pid=process.pid;
 writeFileSync(f.base+'.status.json',JSON.stringify(status));writeFileSync(f.budget+'.lock',JSON.stringify({pid:process.pid}));
 await assert.rejects(f.api.prepare(),/PROCESS_NOT_ABSENT/);
});
test('second inspection checks process again before mutation',async t=>{
 let checks=0;const f=fixture(t,{isProcessAbsent:async()=>++checks===1}),p=await f.api.prepare();
 await assert.rejects(f.api.recover({token:p.token,confirmed:true}),/PROCESS_NOT_ABSENT/);
 assert.ok(existsSync(f.budget+'.lock'));assert.equal(JSON.parse(readFileSync(f.base+'.status.json')).state,'running');
});
for(const changed of ['registry','ledger','status','service'])test('refuse changed '+changed+' snapshot',async t=>{
 const f=fixture(t),p=await f.api.prepare();
 const target={registry:f.base,ledger:f.budget,status:f.base+'.status.json',service:f.base+'.service.lock'}[changed];
 writeFileSync(target,Buffer.concat([readFileSync(target),Buffer.from('\n')]));
 await assert.rejects(f.api.recover({token:p.token,confirmed:true}),/RECOVERY/);
 assert.ok(existsSync(f.base+'.service.lock'));assert.ok(existsSync(f.budget+'.lock'));
});
test('another registry mutation blocks recovery',async t=>{
 const f=fixture(t),p=await f.api.prepare();writeFileSync(f.base+'.mutation.lock','');
 await assert.rejects(f.api.recover({token:p.token,confirmed:true}),/REGISTRY_BUSY/);
 assert.ok(existsSync(f.base+'.service.lock'));
});
function maintenance(f,{absentStatus=false,ownerChanges={}}={}){
 const saved=JSON.parse(readFileSync(f.base+'.status.json'));saved.state='stopped';
 writeFileSync(f.base+'.status.json',JSON.stringify(saved));
 if(absentStatus)rmSync(f.base+'.status.json');
 writeFileSync(f.base+'.service.lock',JSON.stringify({kind:'official-models-sync',pid:123456789,createdAt:saved.updatedAt+1,configPath:f.configPath,...ownerChanges}));
}
for(const absentStatus of [true,false])test('recover identified maintenance lock only; status absent='+absentStatus,async t=>{
 const f=fixture(t);maintenance(f,{absentStatus});
 const before=[f.budget,f.budget+'.lock',f.base+'.stop.json',f.base,...(!absentStatus?[f.base+'.status.json']:[])].map(path=>[path,readFileSync(path)]);
 const plan=await f.api.prepare();assert.equal(plan.kind,'official-models-sync');assert.equal(plan.lockCount,1);
 const done=await f.api.recover({token:plan.token,confirmed:true});assert.equal(done.recoveredLocks,1);assert.equal(existsSync(f.base+'.service.lock'),false);
 for(const [path,bytes] of before)assert.deepEqual(readFileSync(path),bytes);
 assert.equal(existsSync(f.base+'.status.json'),!absentStatus);
});
for(const ownerChanges of [{configPath:'C:\\wrong-config.json'},{kind:'runtime'},{createdAt:Date.now()+120000}])test('reject ambiguous maintenance owner '+JSON.stringify(ownerChanges),async t=>{
 const f=fixture(t);maintenance(f,{ownerChanges});await assert.rejects(f.api.prepare(),/RECOVERY/);assert.ok(existsSync(f.base+'.service.lock'));
});
test('maintenance lock cannot authorize recovery of running status',async t=>{
 const f=fixture(t);maintenance(f);const status=JSON.parse(readFileSync(f.base+'.status.json'));status.state='running';writeFileSync(f.base+'.status.json',JSON.stringify(status));
 await assert.rejects(f.api.prepare(),/RECOVERY/);
});
for(const [label,overrides] of [['live owner',{isProcessAbsent:async()=>false}],['busy port',{isPortFree:async()=>false}]])test('maintenance refuses '+label,async t=>{
 const f=fixture(t,overrides);maintenance(f,{absentStatus:true});await assert.rejects(f.api.prepare(),/RECOVERY/);assert.ok(existsSync(f.base+'.service.lock'));
});
test('maintenance recovery refuses status created after prepare',async t=>{
 const f=fixture(t);maintenance(f,{absentStatus:true});const p=await f.api.prepare();
 writeFileSync(f.base+'.status.json',JSON.stringify({state:'stopped',runId,pid:123456789,updatedAt:Date.now()}));
 await assert.rejects(f.api.recover({token:p.token,confirmed:true}),/SNAPSHOT_CHANGED/);assert.ok(existsSync(f.base+'.service.lock'));
});
for(const servicePresent of [false,true])test('recover identified control maintenance lock; service present='+servicePresent,async t=>{
 const f=fixture(t);maintenance(f,{absentStatus:true});
 writeFileSync(f.configPath+'.desktop-control.lock',readFileSync(f.base+'.service.lock'));
 if(!servicePresent)rmSync(f.base+'.service.lock');
 const p=await f.api.prepare();assert.equal(p.lockCount,servicePresent?2:1);
 const result=await f.api.recover({token:p.token,confirmed:true});assert.equal(result.recoveredLocks,servicePresent?2:1);
 assert.equal(existsSync(f.configPath+'.desktop-control.lock'),false);assert.equal(existsSync(f.base+'.service.lock'),false);
 assert.ok(existsSync(f.budget+'.lock'));assert.ok(existsSync(f.base+'.stop.json'));
});
test('unknown control guard refuses runtime recovery',async t=>{
 const f=fixture(t);writeFileSync(f.configPath+'.desktop-control.lock','');await assert.rejects(f.api.prepare(),/RECOVERY/);
});
test('different maintenance owners refuse both locks',async t=>{
 const f=fixture(t);maintenance(f);const owner=JSON.parse(readFileSync(f.base+'.service.lock'));owner.pid++;
 writeFileSync(f.configPath+'.desktop-control.lock',JSON.stringify(owner));await assert.rejects(f.api.prepare(),/RECOVERY/);
});
test('maintenance recovery permits absent registry without creating it',async t=>{
 const f=fixture(t);maintenance(f,{absentStatus:true});rmSync(f.base);
 const p=await f.api.prepare(),result=await f.api.recover({token:p.token,confirmed:true});
 assert.equal(result.recoveredLocks,1);assert.equal(existsSync(f.base),false);assert.equal(existsSync(f.base+'.service.lock'),false);
 assert.ok(existsSync(f.budget+'.lock'));
});
