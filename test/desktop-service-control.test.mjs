import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,access} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {initializeDesktopData} from '../src/desktop-bootstrap.mjs';
import {createDesktopConfigBridge} from '../src/desktop-config-bridge.mjs';
import {routerStatus,stopRouter} from '../src/router-service.mjs';

async function waitStopped(path){
 for(let i=0;i<80;i++){const s=routerStatus(path);if(s.state==='stopped'&&!s.lockPresent)return;await delay(50);}
 assert.fail('isolated service did not stop');
}
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'desktop-service-')),root=join(dir,'data');
 const {host}=await initializeDesktopData(root),config=JSON.parse(await readFile(host.routerConfigPath));
 t.after(async()=>{if(routerStatus(host.routerConfigPath).state==='running'){stopRouter(host.routerConfigPath);await waitStopped(host.routerConfigPath);}await rm(dir,{recursive:true,force:true});});
 return {host,root,config,bridge:await createDesktopConfigBridge({...host,allowServiceControl:true})};
}
test('owned desktop service initializes empty registry, starts, reuses, stops and restarts',async t=>{
 const f=await fixture(t),before=await readFile(f.host.routerConfigPath,'utf8');
 const started=await f.bridge.dispatch({operation:'router-start'});
 assert.equal((await f.bridge.dispatch({operation:'read'})).serviceControl,true);
 assert.equal(started.ok,true);assert.equal(started.state,'running');assert.equal(started.action,'started');
 assert.deepEqual(Object.keys(started).sort(),['action','canStop','checkedAt','ok','requests','scope','state']);
 const first=routerStatus(f.host.routerConfigPath);assert.ok(first.port>0);assert.deepEqual(first.bindings,[]);
 const credentialMapping=JSON.parse(await readFile(join(f.root,'credentials.json')));
 assert.equal(credentialMapping.credentials.length,1);
 const cipherPath=credentialMapping.credentials[0].filePath,cipherBefore=await readFile(cipherPath,'utf8');
 await writeFile(f.config.registryPath+'.stop.json',JSON.stringify({runId:first.runId}));
 assert.equal((await f.bridge.dispatch({operation:'router-start'})).code,'DESKTOP_SERVICE_NOT_STARTABLE');
 await waitStopped(f.host.routerConfigPath);
 assert.equal((await f.bridge.dispatch({operation:'router-start'})).state,'running');
 const second=routerStatus(f.host.routerConfigPath);
 assert.equal(await readFile(f.config.registryPath,'utf8'),'{"schemaVersion":1}\n');
 assert.equal((await f.bridge.dispatch({operation:'router-start'})).action,'reused');
 assert.equal(routerStatus(f.host.routerConfigPath).runId,second.runId);
 const stopped=await f.bridge.dispatch({operation:'router-stop'});assert.equal(stopped.state,'stopping');
 await waitStopped(f.host.routerConfigPath);
 assert.equal((await f.bridge.dispatch({operation:'router-start'})).state,'running');
 assert.notEqual(routerStatus(f.host.routerConfigPath).runId,first.runId);
 const saved=JSON.parse(await readFile(f.host.routerConfigPath,'utf8'));
 assert.ok(saved.port>0);assert.equal(saved.adapterOptions.port,saved.port);
 assert.deepEqual(saved,{...JSON.parse(before),port:first.port,adapterOptions:{...f.config.adapterOptions,port:first.port}});
 assert.equal(routerStatus(f.host.routerConfigPath).port,first.port);
 assert.equal((await f.bridge.dispatch({operation:'read'})).ok,true);
 assert.deepEqual(JSON.parse(await readFile(join(f.root,'credentials.json'))),credentialMapping);
 assert.equal(await readFile(cipherPath,'utf8'),cipherBefore);
});
test('live service with unhealthy registry can be gracefully stopped without repairing it',async t=>{
 const f=await fixture(t);assert.equal((await f.bridge.dispatch({operation:'router-start'})).state,'running');
 await writeFile(f.config.registryPath,'broken');
 for(let i=0;i<80&&routerStatus(f.host.routerConfigPath).registryHealthy;i++)await delay(50);
 const snapshot=await f.bridge.dispatch({operation:'router-status'});
 assert.equal(snapshot.state,'unknown');assert.equal(snapshot.canStop,true);
 assert.equal((await f.bridge.dispatch({operation:'router-stop'})).ok,true);
 await waitStopped(f.host.routerConfigPath);assert.equal(await readFile(f.config.registryPath,'utf8'),'broken');
});
test('adapter changes refuse startup with a safe error and preserve config',async t=>{
 const f=await fixture(t),changed={...f.config,adapterSha256:'0'.repeat(64)};
 await writeFile(f.host.routerConfigPath,JSON.stringify(changed));
 const bridge=await createDesktopConfigBridge({...f.host,allowServiceControl:true});
 assert.equal((await bridge.dispatch({operation:'router-start'})).code,'ROUTER_ADAPTER_CHANGED');
 assert.equal(routerStatus(f.host.routerConfigPath).lockPresent,false);
 const saved=await readFile(f.host.routerConfigPath,'utf8');assert.ok(JSON.parse(saved).port>0);
 assert.equal((await bridge.dispatch({operation:'read'})).ok,true);
 assert.equal((await bridge.dispatch({operation:'router-start'})).code,'ROUTER_ADAPTER_CHANGED');
 assert.equal(await readFile(f.host.routerConfigPath,'utf8'),saved);
});
test('start cannot migrate zero-port config with existing Worker model bindings',async t=>{
 const f=await fixture(t),before=await readFile(f.host.routerConfigPath,'utf8');
 await writeFile(f.config.adapterOptions.bindingsPath,'[{}]');
 assert.equal((await f.bridge.dispatch({operation:'router-start'})).code,'DE_BINDINGS_PRESENT');
 assert.equal(await readFile(f.host.routerConfigPath,'utf8'),before);
});
test('lost ingress ciphertext blocks restart without replacement or credential disclosure',async t=>{
 const f=await fixture(t);assert.equal((await f.bridge.dispatch({operation:'router-start'})).ok,true);
 assert.equal((await f.bridge.dispatch({operation:'router-stop'})).ok,true);await waitStopped(f.host.routerConfigPath);
 const path=JSON.parse(await readFile(join(f.root,'credentials.json'))).credentials[0].filePath;await rm(path);
 const result=await f.bridge.dispatch({operation:'router-start'});
 assert.deepEqual(result,{ok:false,code:'DI_CREDENTIAL_CHANGED'});assert.equal(routerStatus(f.host.routerConfigPath).state,'stopped');await assert.rejects(access(path));
});
test('legacy host and renderer overrides cannot control services',async t=>{
 const f=await fixture(t),legacy=await createDesktopConfigBridge(f.host);
 assert.equal((await legacy.dispatch({operation:'read'})).serviceControl,false);
 for(const operation of ['router-start','router-stop']){
  assert.equal((await legacy.dispatch({operation})).code,'DESKTOP_SERVICE_DISABLED');
  assert.equal((await f.bridge.dispatch({operation,path:f.host.routerConfigPath})).code,'DESKTOP_CONFIG_REQUEST');
 }
 await assert.rejects(access(f.config.registryPath));
});
test('abnormal lock and corrupt registry are preserved rather than repaired',async t=>{
 const f=await fixture(t),lock=f.config.registryPath+'.service.lock';
 await writeFile(lock,'stale-test');
 assert.equal((await f.bridge.dispatch({operation:'router-start'})).code,'DESKTOP_SERVICE_NOT_STARTABLE');
 assert.equal(await readFile(lock,'utf8'),'stale-test');await rm(lock);
 await writeFile(f.config.registryPath,'broken');
 assert.equal((await f.bridge.dispatch({operation:'router-start'})).code,'ROUTER_REGISTRY_INVALID');
 assert.equal(await readFile(f.config.registryPath,'utf8'),'broken');
});
