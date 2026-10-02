import { readFileSync, writeFileSync, appendFileSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { openBudget, readBudget } from './router-budget.mjs';

const safeCodes = new Set(['BUDGET_LOCKED','BUDGET_UNAVAILABLE','BUDGET_CORRUPT','BUDGET_EXPIRED','BUDGET_EXHAUSTED',
  'BUDGET_WRITE_FAILED','ROUTER_CONFIG_INVALID','ROUTER_ADAPTER_CHANGED','ROUTER_START_FAILED','ROUTER_START_TIMEOUT',
  'ROUTER_NOT_RUNNING','ROUTER_STATUS_UNAVAILABLE','ROUTER_STOP_FAILED','ROUTER_PORT_BUSY',
  'MANAGED_CONFIG_CHANGED','MANAGED_INGRESS_UNAVAILABLE','MANAGED_CREDENTIAL_UNAVAILABLE','MANAGED_ROUTER_FAILED',
  'ROUTER_SERVICE_LOCKED','ROUTER_REGISTRY_INVALID','ROUTER_BINDING_INVALID']);
const safeCode = e => safeCodes.has(e?.message) ? e.message : 'ROUTER_START_FAILED';
const fail = code => { throw new Error(code); };
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export function loadRouterConfig(path) {
  try {
    const config=JSON.parse(readFileSync(path,'utf8'));
    const shared=config.registryPath!==undefined;
    if(Object.keys(config).sort().join(',')!==(shared?'adapterOptions,adapterPath,adapterSha256,port,registryPath':'adapterOptions,adapterPath,adapterSha256,budgetPath') ||
      !isAbsolute(shared?config.registryPath:config.budgetPath) || !isAbsolute(config.adapterPath) ||
      (shared&&(!Number.isInteger(config.port)||config.port<0||config.port>65535)) ||
      !/^[0-9a-f]{64}$/.test(config.adapterSha256) || !config.adapterOptions ||
      typeof config.adapterOptions!=='object' || Array.isArray(config.adapterOptions)) fail('ROUTER_CONFIG_INVALID');
    return config;
  }catch { fail('ROUTER_CONFIG_INVALID'); }
}
export function atomicJson(path,value) {
  const tmp=path+'.'+randomUUID()+'.tmp';
  try {
    writeFileSync(tmp,JSON.stringify(value)+'\n',{flag:'wx',mode:0o600});
    // Windows readers can briefly deny replacement while a status poll holds the file.
    // Retry only metadata rename, never model requests or budget reservations.
    for(let attempt=0;;attempt++) {
      try { renameSync(tmp,path);break; }
      catch(error) {
        if(attempt>=10 || !['EPERM','EACCES','EBUSY'].includes(error.code))throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
      }
    }
  }
  finally { if(existsSync(tmp))unlinkSync(tmp); }
}
function savedStatus(config) {
  try {
    const s=JSON.parse(readFileSync((config.registryPath??config.budgetPath)+'.status.json','utf8'));
    if(!UUID.test(s.runId)||!Number.isSafeInteger(s.pid)||!Number.isSafeInteger(s.updatedAt) ||
       !['running','stopped'].includes(s.state) || !Number.isInteger(s.port) || s.port<0||s.port>65535) throw Error();
    // Read back only the manager-owned scalar allowlist, never arbitrary file fields.
    return {runId:s.runId,pid:s.pid,state:s.state,updatedAt:s.updatedAt,port:s.port,
      active:s.active===true,stopRequested:s.stopRequested===true,
      ...(config.registryPath?{kind:'shared',registryHealthy:s.registryHealthy===true,bindings:Array.isArray(s.bindings)?s.bindings.filter(b=>UUID.test(b?.threadId??'')).map(b=>({threadId:b.threadId,ready:b.ready===true,state:['running','expired','budget_exhausted','unavailable'].includes(b.state)?b.state:'unavailable',
        active:b.active===true,...(['BUDGET_WRITE_FAILED','BUDGET_LOCKED','BUDGET_UNAVAILABLE','BUDGET_CORRUPT','MANAGED_CONFIG_CHANGED','MANAGED_INGRESS_UNAVAILABLE','MANAGED_CREDENTIAL_UNAVAILABLE','ROUTER_BINDING_INITIALIZATION_FAILED'].includes(b.error)?{error:b.error}:{})})):[]}:{}),
    };
  } catch { return null; }
}
export function routerStatus(configPath) {
  const config=loadRouterConfig(configPath), saved=savedStatus(config);
  if(config.registryPath) {
    const lockPresent=existsSync(config.registryPath+'.service.lock');
    const statusPresent=existsSync(config.registryPath+'.status.json');
    const state=saved?.state==='stopped'?'stopped':saved&&lockPresent&&Date.now()-saved.updatedAt<=5000&&saved.updatedAt<=Date.now()+1000?'running':lockPresent||saved||statusPresent?'unknown':'not_started';
    // stopRouter writes this generation-specific request before the service's next heartbeat.
    let stopRequested=saved?.stopRequested===true;
    if(saved?.state==='running') {
      try{const stop=JSON.parse(readFileSync(config.registryPath+'.stop.json','utf8'));stopRequested ||= stop?.runId===saved.runId;}
      catch{/* absence is normal; never mistake an old generation for the current one */}
    }
    const bindings=(saved?.bindings??[]).map(b=>({...b}));
    // Budget authority stays in each immutable ledger, not the heartbeat snapshot.
    try {
      const raw=readFileSync(config.registryPath,'utf8');
      for(const line of raw.trimEnd().split('\n').slice(1)) {
        const entry=JSON.parse(line),binding=bindings.find(b=>b.threadId===entry.threadId);
        if(binding&&isAbsolute(entry.budgetPath)) {
          const budget=readBudget(entry.budgetPath);
          if(budget.threadId!==entry.threadId)throw Error();
          Object.assign(binding,{maxRequests:budget.maxRequests,usedRequests:budget.usedRequests,remaining:budget.remaining,expiresAt:budget.expiresAt});
        }
      }
    }catch { /* heartbeat remains diagnostic; no budget is guessed when unreadable */ }
    return {...(saved??{}),kind:'shared',state,lockPresent,bindings,stopRequested};
  }
  const budget=readBudget(config.budgetPath);
  const lockPresent=existsSync(config.budgetPath+'.lock');
  let state=saved?.state??(lockPresent?'unknown':'not_started');
  if(state==='running' && (!lockPresent || Date.now()-saved.updatedAt>5000 || saved.updatedAt>Date.now()+1000))state='unknown';
  else if(state==='running'&&budget.expiresAt!==null&&Date.now()>=budget.expiresAt)state='expired';
  else if(state==='running'&&budget.remaining===0)state='budget_exhausted';
  return {...(saved??{}),...budget,state,lockPresent};
}
export function stopRouter(configPath) {
  const config=loadRouterConfig(configPath), saved=savedStatus(config);
  if(!saved||saved.state!=='running')fail('ROUTER_NOT_RUNNING');
  // Generation-specific stop request: no process kill and no effect on a future run.
  try { atomicJson((config.registryPath??config.budgetPath)+'.stop.json',{runId:saved.runId}); }
  catch { fail('ROUTER_STOP_FAILED'); }
  return {state:'stop_requested',runId:saved.runId};
}
export async function serveRouter(configPath,runId=randomUUID()) {
  if(!UUID.test(runId))fail('ROUTER_CONFIG_INVALID');
  const config=loadRouterConfig(configPath);
  if(config.registryPath)return (await import('./shared-router.mjs')).serveSharedRouter(configPath,runId);
  let bytes;
  try { bytes=readFileSync(config.adapterPath); } catch { fail('ROUTER_ADAPTER_CHANGED'); }
  if(createHash('sha256').update(bytes).digest('hex')!==config.adapterSha256)fail('ROUTER_ADAPTER_CHANGED');
  const ledger=openBudget(config.budgetPath);
  let router,server,pulse,closed=false,closePromise;
  const grant=ledger.snapshot();
  const statusPath=config.budgetPath+'.status.json';
  const stopPath=config.budgetPath+'.stop.json';
  const publish=state=>{
    try { atomicJson(statusPath,{runId,pid:process.pid,state,updatedAt:Date.now(),
      port:server?.address()?.port??0,active:router?.snapshot().active===true}); }
    catch(error) {
      try { appendFileSync(config.budgetPath+'.lifecycle-errors.jsonl',JSON.stringify({runId,operation:'status_publish',
        code:['EACCES','EPERM','EBUSY','ENOENT','ENOSPC'].includes(error.code)?error.code:'IO_ERROR'})+'\n'); } catch { /* no raw path or payload */ }
      throw error;
    }
  };
  const close=()=>{
    if(closePromise)return closePromise;
    closed=true;clearInterval(pulse);
    closePromise=(async()=>{
      router?.stop();
      if(server?.listening) {
        await new Promise(r=>{server.close(r);server.closeAllConnections();});
      }
      try { await router?.close?.(); } finally {
        try { publish('stopped'); } finally { ledger.close(); }
      }
    })();
    return closePromise;
  };
  try {
    if(grant.expiresAt!==null&&Date.now()>=grant.expiresAt)fail('BUDGET_EXPIRED');
    if(grant.remaining===0)fail('BUDGET_EXHAUSTED');
    const adapter=await import(pathToFileURL(config.adapterPath).href);
    router=await adapter.createManagedRouter({grant,options:config.adapterOptions,
      record:event=>{
        const safe={timestamp:Date.now(),usedRequests:ledger.snapshot().usedRequests};
        for(const key of ['stage','code']) {
          if(typeof event[key]==='string'&&/^[a-zA-Z_]{1,64}$/.test(event[key]))safe[key]=event[key];
        }
        for(const key of ['model','upstreamModel']) {
          if(typeof event[key]==='string'&&/^[a-zA-Z0-9_.-]{1,80}$/.test(event[key]))safe[key]=event[key];
        }
        for(const key of ['threadId','turnId'])if(UUID.test(event[key]??''))safe[key]=event[key];
        if(['official','company'].includes(event.route))safe.route=event.route;
        if(Number.isInteger(event.upstreamStatus)&&event.upstreamStatus>=100&&event.upstreamStatus<=599)safe.upstreamStatus=event.upstreamStatus;
        // Diagnostics are best-effort. Budget enforcement above is independently fsynced.
        try { appendFileSync(config.budgetPath+'.'+runId+'.events.jsonl',JSON.stringify(safe)+'\n',{mode:0o600}); } catch { /* no raw errors */ }
      },
      guardTransport:transport=>async request=>{
        if(closed||request.signal?.aborted)fail('BUDGET_UNAVAILABLE');
        // Do not use best-effort diagnostic callbacks for enforcement. fsync precedes network I/O.
        try { ledger.reserve(); }
        catch(e) {
          if(e.message==='BUDGET_WRITE_FAILED')void close().catch(()=>{});
          throw e;
        }
        return transport(request);
      },
    });
    if(!Number.isInteger(router.port)||router.port<0||router.port>65535 ||
      typeof router.handle!=='function'||typeof router.stop!=='function'||typeof router.snapshot!=='function')
      fail('ROUTER_CONFIG_INVALID');
    server=createServer((req,res)=>{
      Promise.resolve().then(()=>router.handle(req,res)).catch(()=>{
        res.destroy();void close().catch(()=>{});
      });
    });
    server.requestTimeout=65_000;server.headersTimeout=10_000;
    await new Promise((yes,no)=>{
      server.once('error',no);server.listen(router.port,'127.0.0.1',()=>{server.off('error',no);yes();});
    });
    server.on('error',()=>{void close().catch(()=>{});});
    publish('running');
    pulse=setInterval(()=>{
      try {
        let stop;
        try { stop=JSON.parse(readFileSync(stopPath,'utf8')); } catch { /* no stop request */ }
        if(stop?.runId===runId || grant.expiresAt!==null&&Date.now()>=grant.expiresAt+300_000 || router.snapshot().stopped && (grant.expiresAt===null||Date.now()<grant.expiresAt)) {
          void close().catch(()=>{});return;
        }
        publish('running');
      }catch { void close().catch(()=>{}); }
    },250);
    return {close,status:()=>routerStatus(configPath)};
  } catch(e) {
    // Keep the ledger intact and release only this process's ownership.
    try { router?.stop();await router?.close?.(); } catch { /* sanitized below */ }
    if(server?.listening)await new Promise(r=>server.close(r));
    ledger.close();
    throw new Error(e.code==='EADDRINUSE'?'ROUTER_PORT_BUSY':safeCode(e));
  }
}
export function startRouter(configPath) {
  // Validate locally before spawning, but the child alone acquires ledger ownership.
  loadRouterConfig(configPath);
  return new Promise((yes,no)=>{
    const runId=randomUUID();
    const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'--serve',resolve(configPath),runId],{
      detached:true,windowsHide:true,stdio:['ignore','ignore','ignore','ipc'],
    });
    let settled=false;
    const finish=(error,result)=>{
      if(settled)return;settled=true;clearTimeout(timer);
      if(child.connected)child.disconnect();child.unref();
      if(error)no(new Error(safeCode(error)));else yes(result);
    };
    const timer=setTimeout(()=>finish(new Error('ROUTER_START_TIMEOUT')),10_000);
    child.once('error',()=>finish(new Error('ROUTER_START_FAILED')));
    child.once('exit',()=>finish(new Error('ROUTER_START_FAILED')));
    child.once('message',message=>{
      if(message?.runId!==runId)return finish(new Error('ROUTER_START_FAILED'));
      if(message.error)return finish(new Error(message.error));
      try { finish(null,routerStatus(configPath)); }catch(e){finish(e);}
    });
  });
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  if(process.argv[2]!=='--serve')process.exitCode=1;
  else {
    const runId=process.argv[4];
    serveRouter(process.argv[3],runId).then(service=>{
      process.send?.({runId,ready:true});
      const stop=()=>{void service.close().catch(()=>{process.exitCode=1;});};
      process.once('SIGINT',stop);process.once('SIGTERM',stop);
    }).catch(error=>{
      process.send?.({runId,error:safeCode(error)});
      process.exitCode=1;
    });
  }
}
