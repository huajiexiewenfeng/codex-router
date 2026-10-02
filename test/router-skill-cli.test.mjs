import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const api=()=>import('../src/router-skill-cli.mjs');
test('separate CLI calls reuse durable jobs and finish once with a persisted real receipt',async()=>{
 const {runRouterSkill}=await api();const {createDesktopWorkerJobs}=await import('../src/desktop-worker-jobs.mjs');
 const root=await mkdtemp(join(tmpdir(),'router-skill-flow-')),config=join(root,'router.json'),input=join(root,'input.json');
 const threadId='00000000-0000-4000-8000-000000000009';let calls=0;
 await writeFile(input,JSON.stringify({cwd:root,title:'Router test',model:'model_self'}));
 const deps={host:async({jobRoot})=>{
  await mkdir(jobRoot,{recursive:true});
  return createDesktopWorkerJobs({jobRoot,makeRequest:async x=>({...x,hostId:'local',mode:'router',receiptDirectory:jobRoot,initialization:{authorized:true}})},
   {plan:async()=>({status:'ready_to_create'}),create:async r=>{
    calls++;await new Promise(resolve=>setTimeout(resolve,10));
    await writeFile(join(jobRoot,r.operationId+'.json'),JSON.stringify({schemaVersion:2,operationId:r.operationId,mode:'router',hostId:'local',threadId,status:'initialized-awaiting-desktop-confirmation',persistenceVerified:true,sendsModelRequest:true}));
   }});
 }};
 const out=[];await runRouterSkill(['prepare',config,input],x=>out.push(x),deps);const id=out[0].operationId;
 await runRouterSkill(['start',config,id,'--confirm-initialization'],x=>out.push(x),deps);
 assert.equal(out.at(-1).threadId,threadId);assert.equal(out.at(-1).active,false);assert.equal(out.at(-1).persistenceVerified,true);
 await runRouterSkill(['start',config,id,'--confirm-initialization'],x=>out.push(x),deps);
 await runRouterSkill(['job-status',config,id],x=>out.push(x),deps);assert.equal(calls,1);assert.equal(out.at(-1).desktopVerified,false);
});
test('status projects safe gateway information without starting a worker host',async()=>{
 const {runRouterSkill}=await api();let hosts=0;const output=[];
 await runRouterSkill(['status',join(tmpdir(),'router.json')],x=>output.push(x),{
  readStatus:()=>({state:'running',kind:'shared',registryHealthy:true,port:123}),
  readModels:async()=>({activeProviderId:'company',providers:[{id:'company',name:'Company',credentialRef:'secret'}],models:[{providerId:'company',selectionId:'model_self',enabled:true},{providerId:'company',selectionId:'disabled_self',enabled:false},{providerId:'other',selectionId:'other_self'}]}),
  host:async()=>{hosts++;}
 });
 assert.equal(hosts,0);assert.equal(output[0].activeGateway.id,'company');assert.doesNotMatch(JSON.stringify(output),/secret/);
 assert.deepEqual(output[0].enabledModels,['model_self']);
});
test('start needs explicit confirmation, waits, and returns the actual receipt',async()=>{
 const {runRouterSkill}=await api();const config=join(tmpdir(),'router.json'),id='00000000-0000-4000-8000-000000000001';let starts=0,waits=0;
 const deps={host:async()=>({start:async()=>{starts++;return {operationId:id,status:'creation-in-progress'};},wait:async()=>{waits++;return {operationId:id,status:'needs-reconciliation',threadId:id};}})};
 await assert.rejects(()=>runRouterSkill(['start',config,id],()=>{},deps),/RS_USAGE/);assert.equal(starts,0);
 const out=[];await runRouterSkill(['start',config,id,'--confirm-initialization'],x=>out.push(x),deps);
 assert.equal(starts,1);assert.equal(waits,1);assert.equal(out.at(-1).threadId,id);assert.equal(out.at(-1).status,'needs-reconciliation');
});
test('prepare rejects missing model and extra host parameters before opening host',async()=>{
 const {runRouterSkill}=await api();const root=await mkdtemp(join(tmpdir(),'router-skill-')),file=join(root,'input.json');let hosts=0;
 const deps={host:async()=>{hosts++;}};
 for(const request of [{cwd:root,title:'Router test'},{cwd:root,title:'Router test',model:'m_self',codexHome:root}]){
  await writeFile(file,JSON.stringify(request));await assert.rejects(()=>runRouterSkill(['prepare',join(root,'router.json'),file],()=>{},deps),/RS_INPUT/);
 }
 assert.equal(hosts,0);
});
