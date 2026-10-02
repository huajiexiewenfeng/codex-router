import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,access,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {connectAppServer} from '../src/app-server-client.mjs';
import {planDesktopProvider,applyDesktopProvider} from '../src/desktop-provider-install.mjs';

// Explicit local binary opt-in. No account, thread/start or turn/start calls.
test('native CLI distinguishes temporary provider from installed provider in fresh processes',{
 skip:!process.env.CODEX_ROUTER_TEST_EXECUTABLE,
},async()=>{
 const root=await mkdtemp(join(tmpdir(),'router-native-config-'));
 const home=join(root,'home'),cwd=join(root,'workspace');
 await mkdir(home);await mkdir(cwd);
 const children=[];
 const spawnIsolated=(exe,args,options)=>{
  const env={...options.env??process.env};
  for(const key of Object.keys(env))if(/^(CODEX_|OPENAI_|CHATGPT_)/i.test(key))delete env[key];
  assert.equal(options.env.CODEX_HOME,home);
  env.CODEX_HOME=options.env.CODEX_HOME;
  env.CODEX_ROUTER_DESKTOP_INGRESS=options.env?.CODEX_ROUTER_DESKTOP_INGRESS??'';
  const child=spawn(exe,args,{...options,cwd,env});children.push(child);return child;
 };
 const connect=router=>connectAppServer(process.env.CODEX_ROUTER_TEST_EXECUTABLE,{
  timeoutMs:10000,codexHome:home,router,spawnProcess:spawnIsolated,
 });
 let rpc;
 try{
  rpc=await connect({port:59508,ingressToken:'a'.repeat(64)});
  const first=await rpc.request('config/read',{cwd,includeLayers:false});
  const provider=first.config?.model_providers?.codex_router_desktop;
  assert.equal(provider?.base_url,'http://127.0.0.1:59508/v1');
  assert.equal(provider?.requires_openai_auth,true);
  assert.equal(provider?.wire_api,'responses');
  assert.equal(provider?.env_http_headers?.['X-Worker-Router-Token'],'CODEX_ROUTER_DESKTOP_INGRESS');
  await rpc.close();rpc=null;
  rpc=await connect();
  const second=await rpc.request('config/read',{cwd,includeLayers:false});
  assert.equal(second.config?.model_providers?.codex_router_desktop,undefined);
  await assert.rejects(access(join(home,'config.toml')),{code:'ENOENT'});
  await assert.rejects(access(join(home,'sessions')),{code:'ENOENT'});
  await rpc.close();rpc=null;
  const configPath=join(home,'config.toml');
  await writeFile(configPath,'model = "gpt-6-sol"\n');
  await applyDesktopProvider(configPath,await planDesktopProvider(configPath,59508));
  rpc=await connect();
  const third=await rpc.request('config/read',{cwd,includeLayers:false});
  assert.equal(third.config?.model_providers?.codex_router_desktop?.base_url,'http://127.0.0.1:59508/v1');
  assert.equal(third.config?.model,'gpt-6-sol');
  await assert.rejects(access(join(home,'sessions')),{code:'ENOENT'});
  await rpc.close();rpc=null;
  for(const child of children){
   assert.equal(child.stdout.destroyed,true,'close must release stdout even after process exit');
   assert.equal(child.stderr.destroyed,true,'close must release stderr even after process exit');
  }
 }finally{
  await rpc?.close();
  // Cleanup also on a regression failure, without masking the assertions above.
  for(const child of children){child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();}
  await rm(root,{recursive:true,force:true});
 }
});
