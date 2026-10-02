import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,mkdir,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {modelRegistry,binding} from './fixtures/router-model-registry.mjs';
async function fixture(t,allowServiceControl=false){
 const dir=await mkdtemp(join(tmpdir(),'desktop-bridge-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const paths=Object.fromEntries(['models','bindings','config','credentials'].map(k=>[k,join(dir,k+'.json')]));
 const adapterPath=fileURLToPath(new URL('../src/managed-model-router.mjs',import.meta.url));
 const config={adapterPath,adapterSha256:createHash('sha256').update(await readFile(adapterPath)).digest('hex'),registryPath:join(dir,'registry.jsonl'),port:57643,adapterOptions:{schemaVersion:1,modelRegistryPath:paths.models,bindingsPath:paths.bindings,credentialConfigPath:paths.credentials,ingressCredentialRef:'ingress',officialModels:['gpt-6-sol'],port:57643,officialProxyUrl:null}};
 await writeFile(paths.models,JSON.stringify(modelRegistry()));await writeFile(paths.bindings,JSON.stringify([{...binding,allowedModels:['two_self']}]));await writeFile(paths.config,JSON.stringify(config));
 const root=join(dir,'drafts');await mkdir(root);
 const api=await import('../src/desktop-config-bridge.mjs').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});
 assert.equal(typeof api.createDesktopConfigBridge,'function','desktop bridge factory exists');
 return {...paths,configPath:paths.config,dir,config,bridge:await api.createDesktopConfigBridge({routerConfigPath:paths.config,draftRoot:root,allowServiceControl})};
}

test('official proxy saves only the explicit stopped-service setting, backed up and immediately readable',async t=>{
 const f=await fixture(t,true),before=await readFile(f.configPath,'utf8'),models=await readFile(f.models,'utf8'),bindings=await readFile(f.bindings,'utf8');
 const view=await f.bridge.dispatch({operation:'official-proxy-read'});
 assert.equal(view.ok,true);assert.equal(view.proxyUrl,null);assert.match(view.revision,/^[a-f0-9]{64}$/);
 const saved=await f.bridge.dispatch({operation:'official-proxy-save',proxyUrl:'http://127.0.0.1:7897',revision:view.revision,confirmed:true});
 assert.equal(saved.ok,true,JSON.stringify(saved));assert.equal(saved.status,'saved');assert.equal(saved.sendsRequest,false);assert.equal(saved.backupSaved,true);
 const expected=structuredClone(f.config);expected.adapterOptions.officialProxyUrl='http://127.0.0.1:7897';
 assert.deepEqual(JSON.parse(await readFile(f.configPath)),expected);
 const backup=(await readdir(f.dir)).find(n=>n.startsWith('config.json.official-proxy-backup-'));
 assert.ok(backup);assert.equal(await readFile(join(f.dir,backup),'utf8'),before);
 assert.equal(await readFile(f.models,'utf8'),models);assert.equal(await readFile(f.bindings,'utf8'),bindings);
 assert.equal((await f.bridge.dispatch({operation:'read'})).ok,true);
 assert.equal((await f.bridge.dispatch({operation:'router-status'})).state,'not_started');
 const next=await f.bridge.dispatch({operation:'official-proxy-read'});assert.equal(next.proxyUrl,expected.adapterOptions.officialProxyUrl);
 assert.equal((await f.bridge.dispatch({operation:'official-proxy-save',proxyUrl:null,revision:view.revision,confirmed:true})).code,'OP_STALE');
 assert.equal((await f.bridge.dispatch({operation:'official-proxy-save',proxyUrl:null,revision:next.revision,confirmed:true})).ok,true);
 assert.equal(JSON.parse(await readFile(f.configPath)).adapterOptions.officialProxyUrl,null);
});

test('official proxy requires confirmation, host capability and a safe URL; errors contain no URL credentials',async t=>{
 const f=await fixture(t,true),before=await readFile(f.configPath,'utf8'),view=await f.bridge.dispatch({operation:'official-proxy-read'});
 const req={operation:'official-proxy-save',proxyUrl:null,revision:view.revision,confirmed:true};
 assert.equal((await f.bridge.dispatch({...req,confirmed:false})).code,'OP_CONFIRM');
 for(const proxyUrl of ['socks5://localhost:1','http://user:private-secret@localhost:1','https://example/a','http://localhost/?key=private-secret','http://localhost/#private-secret','',23]){
  const result=await f.bridge.dispatch({...req,proxyUrl});assert.equal(result.code,'OP_URL');assert.doesNotMatch(JSON.stringify(result),/private-secret/);
 }
 assert.equal((await f.bridge.dispatch({...req,configPath:'other'})).code,'DESKTOP_CONFIG_REQUEST');
 assert.equal(await readFile(f.configPath,'utf8'),before);
 const ro=await fixture(t);assert.equal((await ro.bridge.dispatch({...req})).code,'DESKTOP_SERVICE_DISABLED');
});

test('official proxy refuses active or uncertain service and control locks without stopping or restarting',async t=>{
 const f=await fixture(t,true),before=await readFile(f.configPath,'utf8'),view=await f.bridge.dispatch({operation:'official-proxy-read'});
 const req={operation:'official-proxy-save',proxyUrl:'http://127.0.0.1:7897',revision:view.revision,confirmed:true};
 await writeFile(f.configPath+'.desktop-control.lock','busy');
 assert.equal((await f.bridge.dispatch(req)).code,'MR_STORE_LOCKED');await rm(f.configPath+'.desktop-control.lock');
 await writeFile(f.config.registryPath+'.service.lock','{}');
 assert.equal((await f.bridge.dispatch(req)).code,'OP_STOP_REQUIRED');
 for(const status of [
  {state:'running',active:false,stopRequested:false},
  {state:'running',active:true,stopRequested:false},
  {state:'running',active:false,stopRequested:true},
  {state:'stopped',active:false,stopRequested:false}
 ]){
  await writeFile(f.config.registryPath+'.status.json',JSON.stringify({runId:'11111111-1111-4111-8111-111111111111',pid:1234,updatedAt:Date.now(),port:57643,registryHealthy:true,...status}));
  assert.equal((await f.bridge.dispatch(req)).code,'OP_STOP_REQUIRED',JSON.stringify(status));
 }
 assert.equal(await readFile(f.configPath,'utf8'),before);
 assert.equal((await readdir(f.dir)).some(n=>n.endsWith('.stop.json')),false);
});

test('official proxy preserves a preexisting setting and refuses external configuration drift',async t=>{
 const f=await fixture(t,true);f.config.adapterOptions.officialProxyUrl='http://127.0.0.1:8888';await writeFile(f.configPath,JSON.stringify(f.config));
 assert.equal((await f.bridge.dispatch({operation:'official-proxy-read'})).code,'DESKTOP_CONFIG_CHANGED');
 const {createDesktopConfigBridge}=await import('../src/desktop-config-bridge.mjs');
 const bridge=await createDesktopConfigBridge({routerConfigPath:f.configPath,draftRoot:join(f.dir,'drafts'),allowServiceControl:true});
 assert.equal((await bridge.dispatch({operation:'official-proxy-read'})).proxyUrl,'http://127.0.0.1:8888');
});

const gatewayInput={displayName:'新网关',baseUrl:'https://new.example/v1',allowHttp:false,models:['gpt-6-luna'],capabilities:{contextWindow:262144,inputModalities:['text'],tools:true,reasoningEfforts:['high']}};
async function officialFixture(t,onDiscover=async()=>{}){
 const f=await fixture(t,true),home=join(f.dir,'native'),catalog=join(f.dir,'catalog.json');await mkdir(home);
 await writeFile(join(home,'config.toml'),'model_catalog_json='+JSON.stringify(catalog.replaceAll('\\','/')));
 await writeFile(catalog,JSON.stringify({models:[{slug:'gpt-6-sol',instructions:'preserve'}]}));
 await writeFile(join(home,'models_cache.json'),JSON.stringify({fetched_at:new Date().toISOString(),models:[{slug:'gpt-6-sol',visibility:'list'},{slug:'gpt-6.1-sol',visibility:'list'},{slug:'hidden-official',visibility:'hide'}]}));
 await writeFile(f.models,JSON.stringify({...modelRegistry(),activeProviderId:'one'}));
 const {createDesktopConfigBridge}=await import('../src/desktop-config-bridge.mjs');
 return {...f,home,catalog,bridge:await createDesktopConfigBridge({routerConfigPath:f.configPath,draftRoot:join(f.dir,'drafts'),allowServiceControl:true,codexIntegration:{discover:async()=>{await onDiscover(f);return {codexHome:home};}}})};
}
test('official route preparation is read-only; explicit confirmed sync appends trusted visible IDs with backup',async t=>{
 const f=await officialFixture(t),before=await readFile(f.configPath,'utf8'),catalogBefore=await readFile(f.catalog,'utf8');
 const plan=await f.bridge.dispatch({operation:'official-models-prepare'});
 assert.equal(plan.ok,true,JSON.stringify(plan));assert.deepEqual(plan.addedModels,['gpt-6.1-sol']);
 assert.equal(await readFile(f.configPath,'utf8'),before);assert.equal(await readFile(f.catalog,'utf8'),catalogBefore);
 const req={operation:'official-models-sync',receiptId:plan.receiptId,confirmed:true};
 assert.equal((await f.bridge.dispatch({...req,confirmed:false})).code,'OM_CONFIRM');
 const result=await f.bridge.dispatch(req);assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.sendsRequest,false);assert.equal(result.requiresServiceStart,true);
 const next=JSON.parse(before);next.adapterOptions.officialModels.push('gpt-6.1-sol');assert.deepEqual(JSON.parse(await readFile(f.configPath)),next);
 assert.equal(JSON.parse(await readFile(f.catalog)).models[0].instructions,'preserve');
 const backup=(await readdir(f.dir)).find(n=>n.startsWith('config.json.official-models-backup-'));assert.ok(backup);assert.equal(await readFile(join(f.dir,backup),'utf8'),before);
 assert.equal((await f.bridge.dispatch(req)).code,'OM_STALE');assert.equal((await f.bridge.dispatch({operation:'read'})).ok,true);
});
test('automatic catalog sync never expands Router allowlist and route sync refuses active locks, source drift or renderer IDs',async t=>{
 const f=await officialFixture(t),before=await readFile(f.configPath,'utf8');
 await f.bridge.dispatch({operation:'catalog-sync',confirmed:true});assert.equal(await readFile(f.configPath,'utf8'),before);
 const plan=await f.bridge.dispatch({operation:'official-models-prepare'}),req={operation:'official-models-sync',receiptId:plan.receiptId,confirmed:true};
 assert.equal((await f.bridge.dispatch({...req,models:['evil']})).code,'DESKTOP_CONFIG_REQUEST');
 await writeFile(f.config.registryPath+'.service.lock','');assert.equal((await f.bridge.dispatch(req)).code,'OM_STOP_REQUIRED');await rm(f.config.registryPath+'.service.lock');
 const again=await f.bridge.dispatch({operation:'official-models-prepare'});await writeFile(join(f.home,'models_cache.json'),'{}');
 assert.equal((await f.bridge.dispatch({...req,receiptId:again.receiptId})).code,'OM_STALE');assert.equal(await readFile(f.configPath,'utf8'),before);
});
test('recovery bridge is host-gated and accepts only an opaque confirmation token',async t=>{
 const f=await fixture(t);assert.equal((await f.bridge.dispatch({operation:'router-recovery-prepare'})).code,'DESKTOP_SERVICE_DISABLED');
 assert.equal((await f.bridge.dispatch({operation:'router-recovery-confirm',token:'x',confirmed:true,configPath:'other'})).code,'DESKTOP_CONFIG_REQUEST');
 const rw=await fixture(t,true);
 assert.equal((await rw.bridge.dispatch({operation:'router-recovery-confirm',token:'x',confirmed:false})).code,'ROUTER_RECOVERY_CONFIRMATION_REQUIRED');
 assert.equal((await rw.bridge.dispatch({operation:'router-recovery-confirm',token:'x',confirmed:true})).code,'ROUTER_RECOVERY_PLAN_EXPIRED');
});
test('official sync holds no service lock during slow source inspection and rejects state drift',async t=>{
 let calls=0;const f=await officialFixture(t,async current=>{
  if(++calls!==2)return;
  assert.equal((await readdir(current.dir)).some(name=>name.endsWith('.service.lock')),false);
  await writeFile(current.config.registryPath+'.status.json','{}');
 });
 const before=await readFile(f.configPath,'utf8'),plan=await f.bridge.dispatch({operation:'official-models-prepare'});
 const result=await f.bridge.dispatch({operation:'official-models-sync',receiptId:plan.receiptId,confirmed:true});
 assert.equal(result.code,'OM_STALE');assert.equal(await readFile(f.configPath,'utf8'),before);
 assert.equal((await readdir(f.dir)).some(name=>name.endsWith('.service.lock')),false);
});
test('official sync refuses a direct CLI startup during source inspection without removing its lock',async t=>{
 let calls=0;const f=await officialFixture(t,async current=>{if(++calls===2)await writeFile(current.config.registryPath+'.service.lock','foreign',{flag:'wx'});});
 const before=await readFile(f.configPath,'utf8'),plan=await f.bridge.dispatch({operation:'official-models-prepare'});
 assert.equal((await f.bridge.dispatch({operation:'official-models-sync',receiptId:plan.receiptId,confirmed:true})).code,'OM_STOP_REQUIRED');
 assert.equal(await readFile(f.configPath,'utf8'),before);assert.equal(await readFile(f.config.registryPath+'.service.lock','utf8'),'foreign');
});
test('official sync respects the common desktop control mutex and preserves its existing owner',async t=>{
 const f=await officialFixture(t),before=await readFile(f.configPath,'utf8'),plan=await f.bridge.dispatch({operation:'official-models-prepare'});
 await writeFile(f.configPath+'.desktop-control.lock','another-config-writer');
 assert.equal((await f.bridge.dispatch({operation:'official-models-sync',receiptId:plan.receiptId,confirmed:true})).code,'MR_STORE_LOCKED');
 assert.equal(await readFile(f.configPath,'utf8'),before);assert.equal(await readFile(f.configPath+'.desktop-control.lock','utf8'),'another-config-writer');
 assert.equal((await readdir(f.dir)).some(name=>name.endsWith('.service.lock')),false);
});
test('official preparation refuses bootstrap port zero without creating maintenance locks',async t=>{
 const f=await fixture(t,true);f.config.port=0;f.config.adapterOptions.port=0;await writeFile(f.configPath,JSON.stringify(f.config));
 const {createDesktopConfigBridge}=await import('../src/desktop-config-bridge.mjs');
 const bridge=await createDesktopConfigBridge({routerConfigPath:f.configPath,draftRoot:join(f.dir,'drafts'),allowServiceControl:true});
 assert.equal((await bridge.dispatch({operation:'official-models-prepare'})).code,'OM_PORT_REQUIRED');
 assert.equal((await readdir(f.dir)).some(name=>name.endsWith('.lock')),false);
});
test('applying model selection synchronizes Codex and reports partial success without losing applied state',async t=>{
 const f=await fixture(t),home=join(f.dir,'codex-home'),catalog=join(f.dir,'catalog.json');await mkdir(home);
 await writeFile(join(home,'config.toml'),'model_catalog_json='+JSON.stringify(catalog.replaceAll('\\','/')));
 await writeFile(catalog,JSON.stringify({models:[{slug:'official'}]}));
 await writeFile(join(home,'models_cache.json'),JSON.stringify({fetched_at:new Date().toISOString(),models:[{slug:'official'},{slug:'new-official',visibility:'list'}]}));
 await writeFile(f.models,JSON.stringify({...modelRegistry(),activeProviderId:'one'}));
 const {createDesktopConfigBridge}=await import('../src/desktop-config-bridge.mjs');
 const bridge=await createDesktopConfigBridge({routerConfigPath:f.configPath,draftRoot:join(f.dir,'drafts'),allowServiceControl:true,codexIntegration:{discover:async()=>({codexHome:home})}});
 assert.equal((await bridge.dispatch({operation:'catalog-sync',confirmed:false})).ok,false);
 const synced=await bridge.dispatch({operation:'catalog-sync',confirmed:true});
 assert.equal(synced.catalog.status,'updated');assert.equal(synced.catalog.officialCatalog.addedCount,1);
 let view=await bridge.dispatch({operation:'read'});
 let draft=await bridge.dispatch({operation:'save-selection',revision:view.revision,changes:[{modelId:'model-one',enabled:false}]});
 let applied=await bridge.dispatch({operation:'apply',draftId:draft.draftId});assert.equal(applied.ok,true);assert.equal(applied.catalog.status,'updated');
 assert.deepEqual(JSON.parse(await readFile(catalog)).models.map(m=>m.slug),['official','new-official']);
 await writeFile(join(home,'config.toml'),'model="official"');
 view=await bridge.dispatch({operation:'read'});draft=await bridge.dispatch({operation:'save-selection',revision:view.revision,changes:[{modelId:'model-one',enabled:true}]});
 applied=await bridge.dispatch({operation:'apply',draftId:draft.draftId});assert.equal(applied.ok,true);assert.equal(applied.status,'applied');assert.equal(applied.catalog.status,'failed');assert.equal(applied.catalog.code,'DCM_NOT_CONFIGURED');
 assert.equal(JSON.parse(await readFile(f.models)).models[0].enabled,true);
});
test('worker jobs are host-gated and renderer cannot inject host parameters',async t=>{
 const f=await fixture(t);
 assert.equal((await f.bridge.dispatch({operation:'worker-prepare',input:{}})).code,'DW_DISABLED');
 const {createDesktopConfigBridge}=await import('../src/desktop-config-bridge.mjs');let prepared=0,started=0;
 const bridge=await createDesktopConfigBridge({routerConfigPath:f.configPath,draftRoot:join(f.dir,'drafts'),workerJobs:{
 prepare:async input=>{prepared++;return {operationId:'fixture',status:'prepared'};},
 start:async input=>{started++;return {status:'creation-in-progress'};},status:async()=>({status:'needs-reconciliation'})}});
 assert.equal((await bridge.dispatch({operation:'read'})).workerCreation,true);
 assert.equal((await bridge.dispatch({operation:'worker-prepare',input:{},executable:'evil'})).ok,false);
 assert.equal(prepared,0);
 assert.equal((await bridge.dispatch({operation:'worker-prepare',input:{}})).ok,true);
 assert.equal((await bridge.dispatch({operation:'worker-start',operationId:'fixture',confirmed:true})).ok,true);
 assert.equal(started,1);
 assert.equal((await bridge.dispatch({operation:'worker-status',operationId:'fixture'})).status,'needs-reconciliation');
});
test('removed model-bind operation never changes worker or registry files',async t=>{
 const f=await fixture(t),view=await f.bridge.dispatch({operation:'read'}),before=await readFile(f.models,'utf8');
 const req={operation:'model-bind',modelId:'model-one',threadId:binding.threadId,revision:view.revision,bindingsRevision:view.bindingsRevision,confirmed:true};
 assert.equal((await f.bridge.dispatch({...req,confirmed:false})).ok,false);
 assert.equal((await f.bridge.dispatch({...req,threadId:'00000000-0000-4000-8000-000000000099'})).ok,false);
 assert.equal((await f.bridge.dispatch({...req,secret:'not-accepted'})).ok,false);
 assert.equal((await f.bridge.dispatch(req)).code,'DESKTOP_CONFIG_REQUEST');
 assert.deepEqual(JSON.parse(await readFile(f.bindings))[0].allowedModels,['two_self']);
 assert.equal(await readFile(f.models,'utf8'),before);
 assert.equal((await f.bridge.dispatch(req)).code,'DESKTOP_CONFIG_REQUEST');
});
test('model binding refuses pending and disabled models',async t=>{
 const f=await fixture(t);
 for(const pending of [true,false]){
  const registry=modelRegistry();if(pending){registry.models[0].readiness='pending';delete registry.models[0].verificationRef;delete registry.models[0].catalogEntry;}else registry.models[0].enabled=false;
  await writeFile(f.models,JSON.stringify(registry));const view=await f.bridge.dispatch({operation:'read'});
  assert.equal((await f.bridge.dispatch({operation:'model-bind',modelId:'model-one',threadId:binding.threadId,revision:view.revision,bindingsRevision:view.bindingsRevision,confirmed:true})).code,'DESKTOP_CONFIG_REQUEST');
 }
});
test('current gateway activation is explicit, versioned, backed up and shared by all workers',async t=>{
 const f=await fixture(t),before=await readFile(f.bindings,'utf8');let view=await f.bridge.dispatch({operation:'read'});
 const req={operation:'gateway-activate',providerId:'one',revision:view.revision,confirmed:true};
 assert.equal((await f.bridge.dispatch({...req,confirmed:false})).ok,false);
 assert.equal((await f.bridge.dispatch({...req,providerId:'missing'})).ok,false);
 const result=await f.bridge.dispatch(req);assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.backupSaved,true);
 view=await f.bridge.dispatch({operation:'read'});assert.equal(view.activeProviderId,'one');assert.equal(view.routingMode,'single-active-gateway');
 assert.equal(view.providers[0].workers.length,1);assert.equal(view.providers[1].workers.length,0);
 assert.equal((await f.bridge.dispatch(req)).code,'DESKTOP_CONFIG_STALE');
 assert.equal((await f.bridge.dispatch({...req,providerId:'two',revision:view.revision})).ok,true);
 assert.equal(await readFile(f.bindings,'utf8'),before);
});
test('active gateway cannot be deleted and legacy adapter cannot be migrated',async t=>{
 const f=await fixture(t);let view=await f.bridge.dispatch({operation:'read'});
 assert.equal((await f.bridge.dispatch({operation:'gateway-activate',providerId:'one',revision:view.revision,confirmed:true})).ok,true);
 view=await f.bridge.dispatch({operation:'read'});
 assert.equal((await f.bridge.dispatch({operation:'gateway-delete',providerId:'one',revision:view.revision,confirmed:true})).code,'AG_ACTIVE_DELETE');
 const old=await fixture(t);old.config.adapterSha256='a'.repeat(64);await writeFile(old.configPath,JSON.stringify(old.config));
 const {createDesktopConfigBridge}=await import('../src/desktop-config-bridge.mjs');const bridge=await createDesktopConfigBridge({routerConfigPath:old.configPath,draftRoot:join(old.dir,'drafts')});
 view=await bridge.dispatch({operation:'read'});
 assert.equal((await bridge.dispatch({operation:'gateway-activate',providerId:'one',revision:view.revision,confirmed:true})).code,'AG_RUNTIME_UPDATE_REQUIRED');
});
test('gateway management renames without routing edits and backs up unbound deletion',async t=>{
 const f=await fixture(t);let view=await f.bridge.dispatch({operation:'read'});
 assert.deepEqual(view.providers.find(p=>p.id==='two').workers,[{hostId:'local',threadId:binding.threadId,allowedModels:['two_self']}]);
 let result=await f.bridge.dispatch({operation:'gateway-rename',providerId:'one',revision:view.revision,displayName:'公司 A'});
 assert.equal(result.ok,true);view=await f.bridge.dispatch({operation:'read'});assert.equal(view.providers[0].displayName,'公司 A');
 const before=await readFile(f.models,'utf8');
 result=await f.bridge.dispatch({operation:'gateway-delete',providerId:'one',revision:view.revision,confirmed:true});
 assert.equal(result.ok,true);assert.equal(result.credentialsRetained,true);
 assert.equal(await readFile(f.models+'.gateway-backup-'+view.revision+'.json','utf8'),before);
 const after=JSON.parse(await readFile(f.models));assert.deepEqual(after.providers.map(p=>p.id),['two']);assert.deepEqual(after.models.map(m=>m.providerId),['two']);
});
test('gateway deletion refuses bindings, active service, stale revision and missing confirmation',async t=>{
 const f=await fixture(t),view=await f.bridge.dispatch({operation:'read'}),before=await readFile(f.models,'utf8');
 const req={operation:'gateway-delete',providerId:'one',revision:view.revision,confirmed:true};
 assert.equal((await f.bridge.dispatch({...req,providerId:'two'})).code,'GMG_BOUND');
 assert.equal((await f.bridge.dispatch({...req,confirmed:false})).code,'GMG_CONFIRM');
 assert.equal((await f.bridge.dispatch({...req,revision:'a'.repeat(64)})).code,'DESKTOP_CONFIG_STALE');
 await writeFile(f.config.registryPath+'.service.lock','fixture');
 assert.equal((await f.bridge.dispatch(req)).code,'GMG_SERVICE_ACTIVE');
 assert.equal(await readFile(f.models,'utf8'),before);
});
test('gateway model IPC returns names without writing registry or accepting extra fields',async t=>{
 const f=await fixture(t),before=await readFile(f.models,'utf8');
 const server=createServer((req,res)=>res.end(JSON.stringify({data:[{id:'gpt-6-sol'}]})));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  const input={baseUrl:`http://127.0.0.1:${server.address().port}/v1`,allowHttp:true,secret:''};
  assert.deepEqual(await f.bridge.dispatch({operation:'gateway-models',input}),{ok:true,models:['gpt-6-sol']});
  assert.deepEqual(await f.bridge.dispatch({operation:'gateway-models',input:{...input,path:'no'}}),{ok:false,code:'GM_INPUT'});
  assert.equal(await readFile(f.models,'utf8'),before);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('router status is a read-only sanitized host-bound snapshot',async t=>{
 const f=await fixture(t),registry=f.config.registryPath;
 const first=await f.bridge.dispatch({operation:'router-status'});
 assert.equal(first.ok,true);assert.equal(first.state,'not_started');
 assert.equal(first.scope,'local-heartbeat-only');assert.equal(typeof first.checkedAt,'number');
 assert.equal((await f.bridge.dispatch({operation:'router-status',path:'other'})).code,'DESKTOP_CONFIG_REQUEST');
 await writeFile(registry+'.service.lock','fixture');
 assert.equal((await f.bridge.dispatch({operation:'router-status'})).state,'unknown');
 const status={runId:'11111111-1111-4111-8111-111111111111',pid:123,state:'running',updatedAt:Date.now(),port:57643,registryHealthy:true,bindings:[],secret:'private-test'};
 await writeFile(registry+'.status.json',JSON.stringify(status));
 assert.equal((await f.bridge.dispatch({operation:'router-status'})).state,'running');
 await writeFile(registry+'.stop.json',JSON.stringify({runId:status.runId}));
 const stopping=await f.bridge.dispatch({operation:'router-status'});assert.equal(stopping.state,'stopping');
 assert.deepEqual(Object.keys(stopping).sort(),['canStop','checkedAt','ok','requests','scope','state']);
 await writeFile(registry+'.status.json',JSON.stringify({...status,updatedAt:0}));
 assert.equal((await f.bridge.dispatch({operation:'router-status'})).state,'unknown');
 await writeFile(registry+'.status.json',JSON.stringify({...status,registryHealthy:false}));
 assert.equal((await f.bridge.dispatch({operation:'router-status'})).state,'unknown');
 await writeFile(registry+'.status.json',JSON.stringify({...status,state:'stopped'}));
 assert.equal((await f.bridge.dispatch({operation:'router-status'})).state,'stopped');
 assert.equal(JSON.parse(await readFile(f.models)).generation,1);
});
test('gateway IPC prepares, encrypts and recovers without exposing paths or Key',{skip:process.platform!=='win32'},async t=>{
 const f=await fixture(t);await writeFile(f.credentials,JSON.stringify({schemaVersion:1,credentials:[]}));
 const receipt=await f.bridge.dispatch({operation:'gateway-prepare',input:gatewayInput});assert.equal(receipt.ok,true);
 assert.equal((await f.bridge.dispatch({operation:'gateway-inspect',receipt})).status,'prepared');
 assert.equal((await f.bridge.dispatch({operation:'gateway-apply',receipt})).code,'GE_KEY_REQUIRED');
 const result=await f.bridge.dispatch({operation:'gateway-create-key',receipt,secret:'fixture-desktop-only'});assert.equal(result.status,'credential-ready');
 const {createDesktopConfigBridge}=await import('../src/desktop-config-bridge.mjs');
 const recovered=await createDesktopConfigBridge({routerConfigPath:f.configPath,draftRoot:join(f.dir,'drafts')});
 assert.equal((await recovered.dispatch({operation:'gateway-inspect',receipt})).status,'credential-ready');
 assert.equal((await recovered.dispatch({operation:'gateway-apply',receipt})).status,'applied');
 const view=await recovered.dispatch({operation:'read'});assert.equal(view.models.at(-1).enabled,false);
 assert.doesNotMatch(JSON.stringify([receipt,result,view]),/fixture-desktop-only|filePath|credentialRef/);
 assert.ok(!JSON.stringify([receipt,result,view]).includes(f.dir));
});
test('model verification IPC uses encrypted host credential and one local stream, never auto-binds',{skip:process.platform!=='win32'},async t=>{
 const f=await fixture(t);let calls=0;
 const server=createServer(async(req,res)=>{calls++;assert.equal(req.headers.authorization,'Bearer fixture-verification-key');let body='';for await(const chunk of req)body+=chunk;const input=JSON.parse(body);assert.equal(input.stream,true);const marker=input.input.match(/ROUTER_VERIFY_[a-f0-9]+/)[0];res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({type:'response.completed',response:{status:'completed',output:[{content:[{type:'output_text',text:marker}]}]}})+'\n\n');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
 await writeFile(f.credentials,JSON.stringify({schemaVersion:1,credentials:[]}));
 const receipt=await f.bridge.dispatch({operation:'gateway-prepare',input:{...gatewayInput,baseUrl:`http://127.0.0.1:${server.address().port}/v1`,allowHttp:true}});
 assert.equal((await f.bridge.dispatch({operation:'gateway-create-key',receipt,secret:'fixture-verification-key'})).ok,true);
 assert.equal((await f.bridge.dispatch({operation:'gateway-apply',receipt})).ok,true);
 const view=await f.bridge.dispatch({operation:'read'}),model=view.models.at(-1),before=await readFile(f.bindings,'utf8');
 const request={operation:'model-verify',modelId:model.modelId,revision:view.revision,confirmed:true};
 assert.equal((await f.bridge.dispatch({...request,secret:'injected'})).code,'DESKTOP_CONFIG_REQUEST');
 assert.equal((await f.bridge.dispatch({...request,confirmed:false})).code,'GV_CONFIRM');assert.equal(calls,0);
 const result=await f.bridge.dispatch(request);assert.equal(result.ok,true,JSON.stringify(result));assert.equal(calls,1);
 const after=await f.bridge.dispatch({operation:'read'});assert.equal(after.models.at(-1).readiness,'verified');assert.equal(after.models.at(-1).enabled,false);
 assert.equal(await readFile(f.bindings,'utf8'),before);assert.doesNotMatch(JSON.stringify(result),/fixture-verification-key|filePath/);
});
test('gateway IPC rejects extra paths and misplaced secrets before any preparation',async t=>{
 const f=await fixture(t);
 for(const request of [{operation:'gateway-prepare',input:gatewayInput,path:f.models},{operation:'gateway-prepare',input:{...gatewayInput,secret:'never-save'}},{operation:'gateway-inspect',receipt:{},secret:'never-save'},{operation:'gateway-create-key',receipt:{},secret:'never-save',filePath:f.models}]){
  const result=await f.bridge.dispatch(request);assert.equal(result.ok,false);assert.doesNotMatch(JSON.stringify(result),/never-save|filePath/);
 }
 assert.equal(JSON.parse(await readFile(f.models)).generation,1);
});
test('read returns projected model state without paths, credentials or writes',async t=>{
 const f=await fixture(t),before=await readFile(f.models,'utf8');const r=await f.bridge.dispatch({operation:'read'});
 assert.equal(r.ok,true);assert.equal(r.models[0].enabled,true);assert.match(r.revision,/^[a-f0-9]{64}$/);
 assert.doesNotMatch(JSON.stringify(r),/credentialRef|filePath|modelRegistryPath|fixture-proof/);assert.ok(!JSON.stringify(r).includes(f.dir));
 assert.equal(await readFile(f.models,'utf8'),before);
});
test('read exposes optional friendly provider name without replacing stable ID',async t=>{
 const f=await fixture(t),registry=JSON.parse(await readFile(f.models,'utf8'));
 registry.providers[0].displayName='公司网关';await writeFile(f.models,JSON.stringify(registry));
 const view=await f.bridge.dispatch({operation:'read'});
 assert.equal(view.ok,true);assert.deepEqual(view.providers[0],{id:'one',responsesUrl:'https://one.example/v1/responses',displayName:'公司网关',workers:[]});
 assert.equal(view.providers[1].displayName,undefined);
});
test('save is a draft only, then apply uses server-held receipt and actual binding file',async t=>{
 const f=await fixture(t);const initial=await f.bridge.dispatch({operation:'read'});
 const draft=await f.bridge.dispatch({operation:'save-selection',revision:initial.revision,changes:[{modelId:'model-one',enabled:false}]});
 assert.equal(draft.ok,true);assert.equal(draft.plan.status,'compatible');assert.equal(JSON.parse(await readFile(f.models,'utf8')).generation,1);
 const result=await f.bridge.dispatch({operation:'apply',draftId:draft.draftId});assert.equal(result.ok,true);assert.equal(result.runtimeActivated,false);
 assert.equal(JSON.parse(await readFile(f.models,'utf8')).models[0].enabled,false);
 assert.equal((await f.bridge.dispatch({operation:'apply',draftId:draft.draftId})).ok,false);
});
test('request cannot select paths, replace identity, inject unknown models or supply secrets',async t=>{
 const f=await fixture(t);const {revision}=await f.bridge.dispatch({operation:'read'});
 for(const request of [{operation:'read',path:f.models},{operation:'apply',draftId:'../models.json'},{operation:'save-selection',revision,changes:[{modelId:'missing',enabled:true}]},{operation:'save-selection',revision,changes:[{modelId:'model-one',enabled:false,providerId:'two'}]},{operation:'save-selection',revision,changes:[{modelId:'model-one',enabled:'false'}]},{operation:'save-key',secret:'private-fixture'}]){
  const r=await f.bridge.dispatch(request);assert.equal(r.ok,false);assert.doesNotMatch(JSON.stringify(r),/private-fixture|models.json/);
 }
 assert.equal(JSON.parse(await readFile(f.models,'utf8')).generation,1);
});
test('stale UI version and later binding changes fail closed',async t=>{
 const f=await fixture(t),view=await f.bridge.dispatch({operation:'read'});
 const req={operation:'save-selection',revision:view.revision,changes:[{modelId:'model-one',enabled:false}]};
 const draft=await f.bridge.dispatch(req);await writeFile(f.bindings,JSON.stringify([binding]));
 assert.equal((await f.bridge.dispatch({operation:'apply',draftId:draft.draftId})).code,'MR_STORE_BLOCKED');
 await writeFile(f.models,(await readFile(f.models,'utf8'))+' ');
 assert.equal((await f.bridge.dispatch(req)).code,'DESKTOP_CONFIG_STALE');
});
test('changed Router registration and malformed disk state expose only stable errors',async t=>{
 const f=await fixture(t);await writeFile(f.models,'private broken data');
 assert.deepEqual(await f.bridge.dispatch({operation:'read'}),{ok:false,code:'DESKTOP_CONFIG_UNAVAILABLE'});
 f.config.adapterOptions.modelRegistryPath=join(f.dir,'other.json');await writeFile(f.configPath,JSON.stringify(f.config));
 assert.deepEqual(await f.bridge.dispatch({operation:'read'}),{ok:false,code:'DESKTOP_CONFIG_CHANGED'});
});
test('concurrent application has one winner and binding lock prevents saving',async t=>{
 const f=await fixture(t),view=await f.bridge.dispatch({operation:'read'});
 const request={operation:'save-selection',revision:view.revision,changes:[{modelId:'model-one',enabled:false}]};
 await writeFile(f.bindings+'.lock','owner');assert.equal((await f.bridge.dispatch(request)).code,'MR_STORE_LOCKED');await rm(f.bindings+'.lock');
 const draft=await f.bridge.dispatch(request);
 const results=await Promise.all([f.bridge.dispatch({operation:'apply',draftId:draft.draftId}),f.bridge.dispatch({operation:'apply',draftId:draft.draftId})]);
 assert.equal(results.filter(r=>r.ok).length,1);assert.equal(JSON.parse(await readFile(f.models,'utf8')).generation,2);
});
