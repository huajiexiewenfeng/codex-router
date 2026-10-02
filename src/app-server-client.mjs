import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

// Provider errors and stderr may contain credentials: expose fixed errors only.
export async function connectAppServer(executable, { timeoutMs = 180000, turnTimeoutMs = timeoutMs, router, codexHome, spawnProcess = spawn } = {}) {
 // Trusted host-only option, never forwarded from renderer payloads. No arbitrary
 // config/arguments/environment API: plaintext belongs only in the child env.
 const args=[],options={shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']};
 if(codexHome!==undefined){
  try{
   if(typeof codexHome!=='string'||!isAbsolute(codexHome))throw Error();
   const info=await lstat(codexHome);if(!info.isDirectory()||info.isSymbolicLink())throw Error();
   options.env={...process.env};
   for(const key of Object.keys(options.env))if(key.toUpperCase()==='CODEX_HOME')delete options.env[key];
   options.env.CODEX_HOME=await realpath(codexHome);
  }catch{throw Error('APP_SERVER_HOME_INVALID');}
 }
 if(router!==undefined){
  if(!router||typeof router!=='object'||Array.isArray(router)||
   Object.keys(router).sort().join(',')!=='ingressToken,port'||
   !Number.isInteger(router.port)||router.port<1||router.port>65535||
   typeof router.ingressToken!=='string'||!/^[a-f0-9]{64}$/.test(router.ingressToken))throw Error('APP_SERVER_ROUTER_CONFIG_INVALID');
  args.push('-c',`model_providers.codex_router_desktop={ name = "Codex Router Desktop", base_url = "http://127.0.0.1:${router.port}/v1", wire_api = "responses", requires_openai_auth = true, supports_websockets = false, request_max_retries = 0, stream_max_retries = 0, env_http_headers = { "X-Worker-Router-Token" = "CODEX_ROUTER_DESKTOP_INGRESS" } }`);
  options.env??={...process.env};
  for(const key of Object.keys(options.env))if(key.toUpperCase()==='CODEX_ROUTER_DESKTOP_INGRESS')delete options.env[key];
  options.env.CODEX_ROUTER_DESKTOP_INGRESS=router.ingressToken;
 }
 args.push('app-server');
 let child;
 try{child=spawnProcess(executable,args,options);}catch{throw Error('APP_SERVER_START_FAILED');}
 const pending=new Map(),turns=new Map(),waiters=new Map();
 let sequence=0,terminal=false;
 function fail(code){terminal=true;for(const map of [pending,waiters]){for(const p of map.values()){clearTimeout(p.timer);p.reject(new Error(code));}map.clear();}}
 child.stderr.on('data',()=>{});
 child.stdin.on('error',()=>fail('APP_SERVER_STDIN_FAILED'));
 child.on('error',()=>fail('APP_SERVER_START_FAILED'));
 child.on('exit',()=>fail('APP_SERVER_EXITED'));
 const lines=createInterface({input:child.stdout});
 lines.on('line',line=>{
  let m;try{m=JSON.parse(line);}catch{return;}
  if(m.method&&m.id!==undefined){child.stdin.write(JSON.stringify({id:m.id,error:{code:-32601,message:'Interactive approval unavailable during bootstrap; recover in desktop.'}})+'\n');return;}
  if(m.method==='turn/completed'){
   const t=m.params?.turn;
   if(t?.id){turns.set(t.id,{id:t.id,status:t.status});const w=waiters.get(t.id);if(w){clearTimeout(w.timer);waiters.delete(t.id);w.resolve(turns.get(t.id));}}
  }
  const p=pending.get(m.id);
  if(p){clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(new Error('APP_SERVER_RPC_FAILED')):p.resolve(m.result);}
 });
 function request(method,params){
  if(terminal)return Promise.reject(new Error('APP_SERVER_EXITED'));
  return new Promise((resolve,reject)=>{const id=++sequence;const timer=setTimeout(()=>{pending.delete(id);reject(new Error('APP_SERVER_TIMEOUT'));},timeoutMs);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({id,method,params})+'\n');});
 }
 function waitTurn(id){
  if(!id)return Promise.reject(new Error('MISSING_TURN_ID'));
  if(turns.has(id))return Promise.resolve(turns.get(id));
  if(terminal)return Promise.reject(new Error('APP_SERVER_EXITED'));
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{waiters.delete(id);reject(new Error('APP_SERVER_TIMEOUT'));},turnTimeoutMs);waiters.set(id,{resolve,reject,timer});});
 }
 async function close(){
  try{
   lines.close();child.stdin.end();if(child.exitCode!==null)return;
   await new Promise(resolve=>{const timer=setTimeout(()=>{child.kill();resolve();},1000);child.once('exit',()=>{clearTimeout(timer);resolve();});});
  }finally{
   // Native process exit need not close every inherited pipe handle. Release
   // our endpoints explicitly so a closed connection cannot keep Node alive.
   child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();
  }
 }
 try{await request('initialize',{clientInfo:{name:'codex_team_provider_worker',version:'0.1.0'},capabilities:{experimentalApi:true}});child.stdin.write(JSON.stringify({method:'initialized'})+'\n');return {request,waitTurn,close};}
 catch(e){await close();throw e;}
}
