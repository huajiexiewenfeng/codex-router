import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {once} from 'node:events';
import {mkdtemp,writeFile,mkdir,rm,access,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {modelRegistry} from './fixtures/router-model-registry.mjs';
test('stdio processes real read/save/apply in sequence without accepting paths or leaking errors',async t=>{
 const script=fileURLToPath(new URL('../src/desktop-stdio.mjs',import.meta.url));
 assert.equal(await access(script).then(()=>true,()=>false),true,'stdio host exists');
 const dir=await mkdtemp(join(tmpdir(),'stdio-bridge-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const models=join(dir,'models.json'),bindings=join(dir,'bindings.json'),config=join(dir,'config.json'),drafts=join(dir,'drafts');
 await mkdir(drafts);await writeFile(models,JSON.stringify(modelRegistry()));await writeFile(bindings,'[]');
 await writeFile(config,JSON.stringify({adapterPath:join(dir,'adapter.mjs'),adapterSha256:'a'.repeat(64),registryPath:join(dir,'registry'),port:0,adapterOptions:{schemaVersion:1,modelRegistryPath:models,bindingsPath:bindings,credentialConfigPath:join(dir,'unused'),ingressCredentialRef:'ingress',officialModels:['gpt-6-sol'],port:0,officialProxyUrl:null}}));
 const child=spawn(process.execPath,[script,config,drafts],{stdio:['pipe','pipe','pipe'],windowsHide:true});t.after(()=>child.kill());
 const lines=createInterface({input:child.stdout})[Symbol.asyncIterator]();
 async function send(value){child.stdin.write(typeof value==='string'?value+'\n':JSON.stringify(value)+'\n');const r=await lines.next();assert.equal(r.done,false);return JSON.parse(r.value);}
 const view=await send({operation:'read'});assert.equal(view.ok,true);
 assert.equal(view.serviceControl,false);
 assert.equal((await send({operation:'router-start'})).code,'DESKTOP_SERVICE_DISABLED');
 const status=await send({operation:'router-status'});assert.equal(status.ok,true);assert.equal(status.state,'not_started');
 assert.equal(status.scope,'local-heartbeat-only');assert.deepEqual(Object.keys(status).sort(),['canStop','checkedAt','ok','requests','scope','state']);
 assert.deepEqual(status.requests,{available:false,scope:'current-run-tail',workers:[]});
 assert.equal((await send({operation:'router-status',routerConfigPath:config})).code,'DESKTOP_CONFIG_REQUEST');
 assert.equal((await send('{"secret":"private-fixture"')).ok,false);
 const draft=await send({operation:'save-selection',revision:view.revision,changes:[{modelId:'model-one',enabled:false}]});assert.equal(draft.ok,true);
 assert.equal((await send({operation:'apply',draftId:draft.draftId})).ok,true);
 assert.equal((await send({operation:'read'})).models[0].enabled,false);
 const exited=once(child,'exit');child.stdin.end();await exited;
});
test('data-root stdio controls only its own isolated service and survives host reopen',async t=>{
 if(process.platform!=='win32'){t.skip('Windows packaged-runtime integration');return;}
 const packageNode=process.env.CODEX_ROUTER_TEST_NODE??process.execPath;
 const nodeSha256=createHash('sha256').update(await readFile(packageNode)).digest('hex');
 const provenance=JSON.parse(await readFile(new URL('../docs/third-party/node-v22.23.3/provenance.json',import.meta.url),'utf8'));
 if(nodeSha256!==provenance.binarySha256){
  if(process.env.CODEX_ROUTER_TEST_NODE)assert.fail('CODEX_ROUTER_TEST_NODE must match archived Node checksum');
  t.skip('Set CODEX_ROUTER_TEST_NODE to verified Node v22.23.3 win-x64 for packaging integration');return;
 }
 const {routerStatus,stopRouter}=await import('../src/router-service.mjs');
 const {setTimeout:delay}=await import('node:timers/promises');
 const dir=await mkdtemp(join(tmpdir(),'stdio-service-')),root=join(dir,'data'),config=join(root,'config.json');
 const {prepareDesktopRuntime}=await import('../scripts/prepare-desktop-runtime.mjs');
 const runtime=join(dir,'runtime');
 await prepareDesktopRuntime({destination:runtime,nodePath:packageNode,nodeSha256});
 const script=join(runtime,'src/desktop-stdio.mjs');
 const children=[];
 async function waitStopped(){for(let i=0;i<80;i++){const s=routerStatus(config);if(s.state==='stopped'&&!s.lockPresent)return;await delay(50);}assert.fail('service did not stop');}
 t.after(async()=>{
  for(const child of children)if(child.exitCode===null)child.kill();
  if(await access(config).then(()=>true,()=>false)){
   if(routerStatus(config).state==='running'){stopRouter(config);await waitStopped();}
  }
  await rm(dir,{recursive:true,force:true});
 });
 function connect(){
  const child=spawn(join(runtime,'node.exe'),[script,'--data-root',root],{stdio:['pipe','pipe','pipe'],windowsHide:true});children.push(child);
  const lines=createInterface({input:child.stdout})[Symbol.asyncIterator]();
  return {async send(value){child.stdin.write(JSON.stringify(value)+'\n');const line=await lines.next();assert.equal(line.done,false);return JSON.parse(line.value);},async close(){const exited=once(child,'exit');child.stdin.end();await exited;}};
 }
 const first=connect(),firstView=await first.send({operation:'read'});assert.equal(firstView.serviceControl,true);
 // Explicit installed-Codex opt-in checks the real bundled host wiring, but
 // does not prepare/create a native task or send any model request.
 if(process.env.CODEX_ROUTER_TEST_EXECUTABLE)assert.equal(firstView.workerCreation,true);
 assert.equal((await first.send({operation:'router-start',allowServiceControl:true})).code,'DESKTOP_CONFIG_REQUEST');
 assert.equal((await first.send({operation:'router-start'})).state,'running');
 const runId=routerStatus(config).runId;await first.close();
 const second=connect();assert.equal((await second.send({operation:'router-status'})).state,'running');
 assert.equal((await second.send({operation:'router-start'})).action,'reused');assert.equal(routerStatus(config).runId,runId);
 await second.close();
 // Simulate an old installation pin while the isolated service is still alive.
 const old=JSON.parse(await readFile(config));old.adapterPath=join(dir,'removed-old','managed-model-router.mjs');old.adapterSha256='a'.repeat(64);await writeFile(config,JSON.stringify(old));
 const third=connect();assert.equal((await third.send({operation:'read'})).runtimeUpgrade.status,'pending-stop');
 assert.equal((await third.send({operation:'router-start'})).code,'DU_STOP_REQUIRED');
 assert.equal((await third.send({operation:'router-stop'})).ok,true);await waitStopped();
 assert.equal((await third.send({operation:'router-start'})).state,'running');
 assert.equal(JSON.parse(await readFile(config)).adapterPath,join(runtime,'src/managed-model-router.mjs'));
 assert.equal((await third.send({operation:'read'})).runtimeUpgrade.status,'updated');
 assert.equal((await third.send({operation:'router-stop'})).ok,true);await waitStopped();await third.close();
});
