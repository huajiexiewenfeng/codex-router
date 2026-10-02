import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const api=()=>import('../src/desktop-worker-jobs.mjs');
test('CLI can wait for the same job without replaying or changing desktop async start',async()=>{
 const {createDesktopWorkerJobs}=await api();const f=await fixture();let finish,calls=0;
 const pending=new Promise(r=>finish=r);
 const jobs=await createDesktopWorkerJobs(f.options,{plan:async()=>({status:'ready_to_create'}),create:async()=>{calls++;await pending;throw Error('private');}});
 const p=await jobs.prepare(f.input);await jobs.start({operationId:p.operationId,confirmed:true});
 let done=false;const waiting=jobs.wait(p.operationId).then(r=>{done=true;return r;});
 await new Promise(r=>setImmediate(r));assert.equal(done,false);finish();
 assert.equal((await waiting).status,'needs-reconciliation');
 assert.equal((await jobs.wait(p.operationId)).status,'needs-reconciliation');assert.equal(calls,1);
});
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'worker-jobs-'));await mkdir(join(root,'jobs'));
 const options={jobRoot:join(root,'jobs'),makeRequest:async input=>({...input,hostId:'local',mode:'router',receiptDirectory:join(root,'jobs'),codexExecutable:join(root,'codex.exe'),routerConfigPath:join(root,'router.json'),provider:'codex_router_desktop',initialization:{authorized:true}})};
 const input={cwd:root,title:'Test',model:'gpt-6-sol_self'};
 return {root,options,input};
}
test('start requires confirmation, is asynchronous and never duplicates a creation',async()=>{
 const {createDesktopWorkerJobs}=await api();const f=await fixture();let calls=0,finish;
 const pending=new Promise(resolve=>finish=resolve);
 const jobs=await createDesktopWorkerJobs(f.options,{plan:async()=>({status:'ready_to_create'}),create:async()=>{calls++;await pending;}});
 const p=await jobs.prepare(f.input);assert.equal(p.sendsModelRequest,false);
 await assert.rejects(()=>jobs.start({operationId:p.operationId,confirmed:false}),/DW_CONFIRM/);
 assert.equal(calls,0);await jobs.start({operationId:p.operationId,confirmed:true});
 await jobs.start({operationId:p.operationId,confirmed:true});assert.equal(calls,1);
 assert.equal((await jobs.status(p.operationId)).status,'creation-in-progress');finish();
});
test('restart keeps uncertain intent without replay and sanitizes failure',async()=>{
 const {createDesktopWorkerJobs}=await api();const f=await fixture();let calls=0;
 const deps={plan:async()=>({status:'ready_to_create'}),create:async()=>{calls++;throw Error('SECRET key and private url');}};
 const jobs=await createDesktopWorkerJobs(f.options,deps),p=await jobs.prepare(f.input);
 await jobs.start({operationId:p.operationId,confirmed:true});
 for(let i=0;i<50;i++){if((await jobs.status(p.operationId)).status==='needs-reconciliation')break;await new Promise(r=>setTimeout(r,5));}
 const restarted=await createDesktopWorkerJobs(f.options,deps);
 const result=await restarted.start({operationId:p.operationId,confirmed:true});
 assert.equal(calls,1);assert.equal(result.status,'needs-reconciliation');assert.doesNotMatch(JSON.stringify(result),/SECRET|private url/);
 assert.doesNotMatch(await readFile(join(f.options.jobRoot,p.operationId+'.job.json'),'utf8'),/SECRET/);
});
test('status recovers actual worker receipt after host recreation without creation',async()=>{
 const {createDesktopWorkerJobs}=await api();const f=await fixture();const jobs=await createDesktopWorkerJobs(f.options,{plan:async()=>({status:'ready_to_create'})});
 const p=await jobs.prepare(f.input),threadId='00000000-0000-4000-8000-000000000001';
 await writeFile(join(f.options.jobRoot,p.operationId+'.json'),JSON.stringify({schemaVersion:2,operationId:p.operationId,mode:'router',hostId:'local',threadId,status:'initialized-awaiting-desktop-confirmation',persistenceVerified:true,sendsModelRequest:true}));
 const restarted=await createDesktopWorkerJobs(f.options);const result=await restarted.status(p.operationId);
 assert.equal(result.threadId,threadId);assert.equal(result.persistenceVerified,true);assert.equal(result.desktopVerified,false);
});
test('renderer cannot supply executable, arbitrary paths for receipts or malformed IDs',async()=>{
 const {createDesktopWorkerJobs}=await api();const f=await fixture();let plans=0;
 const jobs=await createDesktopWorkerJobs(f.options,{plan:async()=>{plans++;return {status:'ready_to_create'};}});
 await assert.rejects(()=>jobs.prepare({...f.input,codexExecutable:'evil.exe'}),/DW_INPUT/);
 await assert.rejects(()=>jobs.status('../other'),/DW_INPUT/);
 await assert.rejects(()=>jobs.start({operationId:'00000000-0000-4000-8000-000000000001',confirmed:true}),/DW_UNKNOWN/);
 assert.equal(plans,0);
});
test('two host controllers racing to start one operation still create only once',async()=>{
 const {createDesktopWorkerJobs}=await api();const f=await fixture();let calls=0,finish;
 const pending=new Promise(resolve=>finish=resolve),deps={plan:async()=>({status:'ready_to_create'}),create:async()=>{calls++;await pending;}};
 const a=await createDesktopWorkerJobs(f.options,deps),b=await createDesktopWorkerJobs(f.options,deps),p=await a.prepare(f.input);
 await Promise.all([a.start({operationId:p.operationId,confirmed:true}),b.start({operationId:p.operationId,confirmed:true})]);
 assert.equal(calls,1);finish();
});
test('changed host request cannot reuse an old confirmation receipt',async()=>{
 const {createDesktopWorkerJobs}=await api();const f=await fixture();let port=1,calls=0;
 const opts={...f.options,makeRequest:async input=>({...await f.options.makeRequest(input),provider:'router_'+port})};
 const jobs=await createDesktopWorkerJobs(opts,{plan:async()=>({status:'ready_to_create'}),create:async()=>{calls++;}}),p=await jobs.prepare(f.input);
 port=2;await assert.rejects(()=>jobs.start({operationId:p.operationId,confirmed:true}),/DW_CHANGED/);assert.equal(calls,0);
});
