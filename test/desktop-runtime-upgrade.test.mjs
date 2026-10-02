import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,readdir,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {initializeDesktopData} from '../src/desktop-bootstrap.mjs';
import {modelRegistry,binding} from './fixtures/router-model-registry.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
async function api(){const m=await import('../src/desktop-runtime-upgrade.mjs').catch(()=>({}));assert.equal(typeof m.upgradeDesktopRuntime,'function','host upgrade API exists');return m.upgradeDesktopRuntime;}
async function fixture(count=1){
 const base=await mkdtemp(join(tmpdir(),'router-upgrade-')),root=join(base,'data'),runtimeRoot=join(base,'runtime');
 const {host}=await initializeDesktopData(root);await mkdir(join(runtimeRoot,'src'),{recursive:true});
 const files={'node.exe':'fixture node','src/managed-model-router.mjs':'fixture adapter','src/desktop-stdio.mjs':'fixture stdio'};
 for(const [name,bytes] of Object.entries(files))await writeFile(join(runtimeRoot,name),bytes);
 const manifest={schemaVersion:1,files:Object.fromEntries(Object.entries(files).map(([n,b])=>[n,hash(b)]))};
 await writeFile(join(runtimeRoot,'runtime-manifest.json'),JSON.stringify(manifest));
 const c=JSON.parse(await readFile(host.routerConfigPath));c.adapterPath=join(base,'removed-old-runtime','src','managed-model-router.mjs');c.adapterSha256='a'.repeat(64);c.port=12345;c.adapterOptions.port=12345;c.adapterOptions.officialModels=['gpt-6-sol'];
 await writeFile(host.routerConfigPath,JSON.stringify(c));
 const registry=modelRegistry();registry.providers=registry.providers.slice(0,count);registry.models=registry.models.slice(0,count);if(registry.models[0])registry.models[0].enabled=false;
 await writeFile(join(root,'models.json'),JSON.stringify(registry));
 await writeFile(join(root,'bindings.json'),JSON.stringify(count?[{...binding,allowedModels:registry.models.map(m=>m.selectionId)}]:[]));
 // Opaque file is not read/decrypted/replaced by migration.
 await writeFile(join(root,'existing.dpapi'),'opaque encrypted fixture');
 await writeFile(join(root,'credentials.json'),JSON.stringify({schemaVersion:1,credentials:[{credentialRef:'one-key',filePath:join(root,'existing.dpapi')}]}));
 const before=Object.fromEntries(await Promise.all(['config.json','models.json','bindings.json','credentials.json','existing.dpapi'].map(async n=>[n,await readFile(join(root,n),'utf8')])));
 return {root,runtimeRoot,configPath:host.routerConfigPath,before,manifest};
}
test('stopped upgrade backs up exact bytes, migrates sole gateway and preserves all other data; repeat is no-op',async()=>{
 const upgrade=await api(),f=await fixture();const result=await upgrade(f.configPath,f.runtimeRoot);
 assert.equal(result.status,'updated');assert.equal(result.activeProviderId,'one');assert.equal(result.backupSaved,true);
 const c=JSON.parse(await readFile(f.configPath)),old=JSON.parse(f.before['config.json']);
 assert.deepEqual(c,{...old,adapterPath:join(f.runtimeRoot,'src/managed-model-router.mjs'),adapterSha256:f.manifest.files['src/managed-model-router.mjs']});
 const r=JSON.parse(await readFile(join(f.root,'models.json')));assert.deepEqual(r,{...JSON.parse(f.before['models.json']),generation:2,activeProviderId:'one'});
 for(const n of ['bindings.json','credentials.json','existing.dpapi'])assert.equal(await readFile(join(f.root,n),'utf8'),f.before[n]);
 const backups=(await readdir(f.root)).filter(n=>n.startsWith('runtime-upgrade-backup-'));assert.equal(backups.length,1);
 for(const n of ['config.json','models.json'])assert.equal(await readFile(join(f.root,backups[0],n),'utf8'),f.before[n]);
 assert.equal((await upgrade(f.configPath,f.runtimeRoot)).status,'current');assert.equal((await readdir(f.root)).filter(n=>n.startsWith('runtime-upgrade-backup-')).length,1);
});
test('multiple or zero legacy gateways require choice; explicit null/current selection is preserved',async()=>{
 const upgrade=await api();
 for(const count of [0,2]){const f=await fixture(count);assert.equal((await upgrade(f.configPath,f.runtimeRoot)).activeProviderId,null);}
 for(const selected of [null,'two']){const f=await fixture(2),r=JSON.parse(f.before['models.json']);r.activeProviderId=selected;const bytes=JSON.stringify(r);await writeFile(join(f.root,'models.json'),bytes);await upgrade(f.configPath,f.runtimeRoot);assert.equal(await readFile(join(f.root,'models.json'),'utf8'),bytes);}
});
test('running, stale service lock and unknown status defer without changing config; stopped retry upgrades',async()=>{
 const upgrade=await api(),f=await fixture(),registry=JSON.parse(f.before['config.json']).registryPath;
 const status={runId:'00000000-0000-4000-8000-000000000010',pid:process.pid,updatedAt:Date.now(),state:'running',port:12345,active:false,registryHealthy:true};
 await writeFile(registry+'.status.json',JSON.stringify(status));await writeFile(registry+'.service.lock','owned');
 assert.equal((await upgrade(f.configPath,f.runtimeRoot)).status,'pending-stop');assert.equal(await readFile(f.configPath,'utf8'),f.before['config.json']);
 await writeFile(registry+'.status.json',JSON.stringify({...status,state:'stopped'}));assert.equal((await upgrade(f.configPath,f.runtimeRoot)).status,'pending-stop');
 await unlink(registry+'.service.lock');await writeFile(registry+'.status.json','broken');assert.equal((await upgrade(f.configPath,f.runtimeRoot)).status,'pending-stop');
 await writeFile(registry+'.status.json',JSON.stringify({...status,state:'stopped'}));assert.equal((await upgrade(f.configPath,f.runtimeRoot)).status,'updated');
});
test('damaged package and unowned adapter reject without backup or mutations',async()=>{
 const upgrade=await api();
 for(const bad of ['hash','path','adapter']){const f=await fixture();
  if(bad==='hash')await writeFile(join(f.runtimeRoot,'node.exe'),'tampered');
  if(bad==='path'){f.manifest.files['../outside']='a'.repeat(64);await writeFile(join(f.runtimeRoot,'runtime-manifest.json'),JSON.stringify(f.manifest));}
  if(bad==='adapter'){const c=JSON.parse(f.before['config.json']);c.adapterPath=join(f.root,'custom.mjs');f.before['config.json']=JSON.stringify(c);await writeFile(f.configPath,f.before['config.json']);}
  await assert.rejects(upgrade(f.configPath,f.runtimeRoot),new RegExp(bad==='adapter'?'DU_CONFIG_UNSUPPORTED':'DU_PACKAGE_INVALID'));
  assert.equal(await readFile(f.configPath,'utf8'),f.before['config.json']);assert.equal(await readFile(join(f.root,'models.json'),'utf8'),f.before['models.json']);assert.equal((await readdir(f.root)).some(n=>n.startsWith('runtime-upgrade-backup-')),false);
 }
});
test('configuration locks are respected and interrupted config-first update converges',async()=>{
 const upgrade=await api(),f=await fixture();await writeFile(f.configPath+'.desktop-control.lock','owned');
 await assert.rejects(upgrade(f.configPath,f.runtimeRoot),/DU_LOCKED/);assert.equal(await readFile(f.configPath,'utf8'),f.before['config.json']);await unlink(f.configPath+'.desktop-control.lock');
 const c=JSON.parse(f.before['config.json']);c.adapterPath=join(f.runtimeRoot,'src/managed-model-router.mjs');c.adapterSha256=f.manifest.files['src/managed-model-router.mjs'];await writeFile(f.configPath,JSON.stringify(c));
 assert.equal((await upgrade(f.configPath,f.runtimeRoot)).status,'updated');assert.equal(JSON.parse(await readFile(join(f.root,'models.json'))).activeProviderId,'one');
});
test('bundled bridge upgrades before first read and reports pending or blocked while leaving stop controls available',async()=>{
 const {createDesktopConfigBridge}=await import('../src/desktop-config-bridge.mjs');
 for(const mode of ['stopped','running','damaged']){
  const f=await fixture(),registry=JSON.parse(f.before['config.json']).registryPath;
  if(mode==='running'){await writeFile(registry+'.service.lock','owned');await writeFile(registry+'.status.json',JSON.stringify({runId:'00000000-0000-4000-8000-000000000010',pid:process.pid,updatedAt:Date.now(),state:'running',port:12345,active:false,registryHealthy:true}));}
  if(mode==='damaged')await writeFile(join(f.runtimeRoot,'node.exe'),'bad');
  const bridge=await createDesktopConfigBridge({routerConfigPath:f.configPath,draftRoot:join(f.root,'drafts'),allowServiceControl:true,bundledRuntimeRoot:f.runtimeRoot});
  const response=await bridge.dispatch({operation:'read'});assert.equal(response.ok,true);assert.equal(response.runtimeUpgrade?.status,mode==='stopped'?'updated':mode==='running'?'pending-stop':'blocked');
  if(mode==='stopped'){assert.equal(response.activeProviderId,'one');assert.equal(response.routingMode,'single-active-gateway');}
  else {assert.equal(await readFile(f.configPath,'utf8'),f.before['config.json']);const start=await bridge.dispatch({operation:'router-start'});assert.equal(start.ok,false);assert.equal(start.code,mode==='running'?'DU_STOP_REQUIRED':'DU_PACKAGE_INVALID');}
 }
});
test('same-directory replacement updates pinned digest without rewriting selected registry',async()=>{
 const upgrade=await api(),f=await fixture(),c=JSON.parse(f.before['config.json']);c.adapterPath=join(f.runtimeRoot,'src/managed-model-router.mjs');await writeFile(f.configPath,JSON.stringify(c));
 const r=JSON.parse(f.before['models.json']);r.activeProviderId='one';const bytes=JSON.stringify(r);await writeFile(join(f.root,'models.json'),bytes);
 assert.equal((await upgrade(f.configPath,f.runtimeRoot)).status,'updated');assert.equal(JSON.parse(await readFile(f.configPath)).adapterSha256,f.manifest.files['src/managed-model-router.mjs']);assert.equal(await readFile(join(f.root,'models.json'),'utf8'),bytes);
});
test('corrupt stored model data and expected config drift do not get overwritten',async()=>{
 const upgrade=await api();
 for(const mode of ['corrupt','drift']){const f=await fixture();if(mode==='corrupt')await writeFile(join(f.root,'models.json'),'broken');
  await assert.rejects(upgrade(f.configPath,f.runtimeRoot,{expectedConfigIdentity:mode==='drift'?'other':undefined}),/DU_/);
  assert.equal(await readFile(f.configPath,'utf8'),f.before['config.json']);assert.equal(await readFile(join(f.root,'models.json'),'utf8'),mode==='corrupt'?'broken':f.before['models.json']);
 }
});
