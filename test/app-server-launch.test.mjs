import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {mkdtemp,realpath,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {connectAppServer} from '../src/app-server-client.mjs';
const fixture=fileURLToPath(new URL('./fixtures/app-server-launch.mjs',import.meta.url));
const token='a'.repeat(64);
// Substitute only the executable transport. Exercise real pipes, environment and RPC.
const spawnFixture=(_exe,args,options)=>spawn(process.execPath,[fixture,...args],options);
test('Router launch uses fixed provider, loopback and child-only secret environment',async()=>{
 const before=process.env.CODEX_ROUTER_DESKTOP_INGRESS;
 const rpc=await connectAppServer('fixture',{router:{port:59508,ingressToken:token},spawnProcess:spawnFixture});
 try{
  const result=await rpc.request('fixture/inspect',{});
  assert.equal(result.tokenMatches,true);
  assert.equal(process.env.CODEX_ROUTER_DESKTOP_INGRESS,before);
  assert.equal(result.args.at(-1),'app-server');
  assert.match(result.args.join(' '),/model_providers\.codex_router_desktop=/);
  assert.match(result.args.join(' '),/http:\/\/127\.0\.0\.1:59508\/v1/);
  assert.match(result.args.join(' '),/requires_openai_auth = true/);
  assert.match(result.args.join(' '),/X-Worker-Router-Token/);
  assert.equal(result.args.join(' ').includes(token),false);
  await assert.rejects(rpc.request('fixture/fail',{}),/^Error: APP_SERVER_RPC_FAILED$/);
 }finally{await rpc.close();}
});
test('default launch retains original arguments and does not mutate environment',async()=>{
 let child;
 const rpc=await connectAppServer('fixture',{spawnProcess:(...args)=>(child=spawnFixture(...args))});
 try{assert.deepEqual((await rpc.request('fixture/inspect',{})).args,['app-server']);}
 finally{await rpc.close();}
 assert.notEqual(child.exitCode,null);
});
test('invalid router options reject before process launch without leaking input',async()=>{
 for(const router of [null,{}, {port:0,ingressToken:token},{port:65536,ingressToken:token},
  {port:1234.5,ingressToken:token},{port:1234,ingressToken:'secret\nvalue'},
  {port:1234,ingressToken:token,provider:'openai'}]){
  let called=false;
  await assert.rejects(connectAppServer('fixture',{router,spawnProcess:()=>{called=true;throw Error('bad');}}),/^Error: APP_SERVER_ROUTER_CONFIG_INVALID$/);
  assert.equal(called,false);
 }
});
test('simultaneous Router connections isolate their ingress values',async()=>{
 const connections=await Promise.all([token,'b'.repeat(64)].map(ingressToken=>
  connectAppServer('fixture',{router:{port:59508,ingressToken},spawnProcess:spawnFixture})));
 try{
  assert.equal((await connections[0].request('fixture/inspect',{})).tokenMatches,true);
  assert.equal((await connections[1].request('fixture/inspect',{})).tokenMatches,false);
 }finally{await Promise.all(connections.map(rpc=>rpc.close()));}
});
test('synchronous launch failures never surface launcher details or secrets',async()=>{
 await assert.rejects(connectAppServer('fixture',{router:{port:59508,ingressToken:token},
  spawnProcess:()=>{throw Error(token);}}),/^Error: APP_SERVER_START_FAILED$/);
});

test('trusted home selection stays in each native child and preserves the parent',async()=>{
 const before=process.env.CODEX_HOME;
 const homes=await Promise.all([1,2].map(async()=>realpath(await mkdtemp(join(tmpdir(),'router-native-home-')))));
 const connections=await Promise.all(homes.map(codexHome=>connectAppServer('fixture',{codexHome,router:{port:59508,ingressToken:token},spawnProcess:spawnFixture})));
 try{
  for(let i=0;i<connections.length;i++)assert.equal((await connections[i].request('fixture/inspect',{})).home,homes[i]);
  assert.equal(process.env.CODEX_HOME,before);
 }finally{await Promise.all(connections.map(r=>r.close()));}
});

test('invalid home selection fails before spawning and hides filesystem details',async()=>{
 const root=await mkdtemp(join(tmpdir(),'router-invalid-home-')),file=join(root,'not-a-directory');await writeFile(file,'test');
 for(const codexHome of ['', 'relative',null,join(root,'missing'),file]){
  let called=false;
  await assert.rejects(connectAppServer('fixture',{codexHome,spawnProcess:()=>{called=true;throw Error('unexpected spawn');}}),/^Error: APP_SERVER_HOME_INVALID$/);
  assert.equal(called,false);
 }
});

test('initialization turn can outlast short readiness RPC budget',async()=>{
 const rpc=await connectAppServer('fixture',{timeoutMs:150,turnTimeoutMs:1500,spawnProcess:spawnFixture});
 try{await rpc.request('fixture/delayed-turn',{});assert.equal((await rpc.waitTurn('test-turn')).status,'completed');}
 finally{await rpc.close();}
});
