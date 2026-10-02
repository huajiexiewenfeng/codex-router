import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import {initializeDesktopData} from '../src/desktop-bootstrap.mjs';
import {initializeRouterRegistry} from '../src/router-registry.mjs';
import {startRouter,stopRouter,routerStatus} from '../src/router-service.mjs';
async function api(){const m=await import('../src/desktop-endpoint.mjs').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});assert.equal(typeof m.prepareDesktopEndpoint,'function');return m.prepareDesktopEndpoint;}
async function stopped(path){for(let i=0;i<100;i++){const s=routerStatus(path);if(s.state==='stopped'&&!s.lockPresent)return;await delay(50);}assert.fail('stop timeout');}
async function fixture(t){const dir=await mkdtemp(join(tmpdir(),'desktop-endpoint-'));const {host}=await initializeDesktopData(join(dir,'data'));const path=host.routerConfigPath;const config=JSON.parse(await readFile(path));t.after(async()=>{if(routerStatus(path).state==='running'){stopRouter(path);await stopped(path);}await rm(dir,{recursive:true,force:true});});return {path,config};}
test('preparation persists one loopback port and repeated preparation preserves bytes',async t=>{
 const prepare=await api(),f=await fixture(t),result=await prepare(f.path);
 assert.equal(result.changed,true);assert.ok(result.port>0);assert.equal(result.baseUrl,`http://127.0.0.1:${result.port}/v1`);
 const bytes=await readFile(f.path,'utf8'),saved=JSON.parse(bytes);
 assert.deepEqual(saved,{...f.config,port:result.port,adapterOptions:{...f.config.adapterOptions,port:result.port}});
 assert.equal((await prepare(f.path)).changed,false);assert.equal(await readFile(f.path,'utf8'),bytes);
 initializeRouterRegistry(saved.registryPath);
 assert.equal((await startRouter(f.path)).port,result.port);stopRouter(f.path);await stopped(f.path);
 assert.equal((await startRouter(f.path)).port,result.port);
 await assert.rejects(prepare(f.path),/DE_SERVICE_ACTIVE/);
});
test('occupied fixed port fails startup without changing saved endpoint',async t=>{
 const prepare=await api(),f=await fixture(t),{port}=await prepare(f.path),before=await readFile(f.path,'utf8');
 const server=createServer();await new Promise((yes,no)=>{server.once('error',no);server.listen(port,'127.0.0.1',yes);});t.after(()=>new Promise(r=>server.close(r)));
 assert.equal((await prepare(f.path)).port,port);initializeRouterRegistry(f.config.registryPath);
 await assert.rejects(startRouter(f.path),/ROUTER_PORT_BUSY/);assert.equal(await readFile(f.path,'utf8'),before);
});
test('locks, existing bindings and malformed registry refuse migration unchanged',async t=>{
 const prepare=await api(),f=await fixture(t),before=await readFile(f.path,'utf8');
 const lock=f.config.registryPath+'.service.lock';await writeFile(lock,'stale');await assert.rejects(prepare(f.path),/DE_SERVICE_ACTIVE/);await rm(lock);
 await writeFile(f.config.adapterOptions.bindingsPath,'[{}]');await assert.rejects(prepare(f.path),/DE_BINDINGS_PRESENT/);await writeFile(f.config.adapterOptions.bindingsPath,'[]');
 await writeFile(f.config.registryPath,'broken');await assert.rejects(prepare(f.path),/DE_REGISTRY_INVALID/);
 assert.equal(await readFile(f.path,'utf8'),before);
});
test('registered Workers and held preparation lock refuse endpoint mutation',async t=>{
 const prepare=await api(),f=await fixture(t),before=await readFile(f.path,'utf8');
 const lock=f.path+'.desktop-control.lock';await writeFile(lock,'held');await assert.rejects(prepare(f.path),/DE_LOCKED/);assert.equal(await readFile(lock,'utf8'),'held');await rm(lock);
 await writeFile(f.config.registryPath,JSON.stringify({schemaVersion:1})+'\n'+JSON.stringify({threadId:'11111111-1111-4111-8111-111111111111',budgetPath:join(tmpdir(),'unused-budget.jsonl')})+'\n');
 await assert.rejects(prepare(f.path),/DE_BINDINGS_PRESENT/);assert.equal(await readFile(f.path,'utf8'),before);
});
test('mismatched ports and relative config path fail without overwriting',async t=>{
 const prepare=await api(),f=await fixture(t),bytes=JSON.stringify({...f.config,port:12345});
 await writeFile(f.path,bytes);await assert.rejects(prepare(f.path),/DE_CONFIG_INVALID/);assert.equal(await readFile(f.path,'utf8'),bytes);
 await assert.rejects(prepare('relative.json'),/DE_CONFIG_INVALID/);
});
test('stale host identity is rejected inside preparation lock before any edit',async t=>{
 const prepare=await api(),f=await fixture(t),identity=JSON.stringify(f.config);
 const bytes=JSON.stringify({...f.config,adapterOptions:{...f.config.adapterOptions,officialModels:['gpt-6-sol']}});
 await writeFile(f.path,bytes);await assert.rejects(prepare(f.path,{expectedConfigIdentity:identity}),/DE_CONFIG_CHANGED/);
 assert.equal(await readFile(f.path,'utf8'),bytes);
});
