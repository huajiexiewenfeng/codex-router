import {createServer} from 'node:http';
import {readFileSync,openSync,closeSync,unlinkSync,appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {openBudget,readBudget} from './router-budget.mjs';
import {readRouterRegistry} from './router-registry.mjs';
import {atomicJson,loadRouterConfig,routerStatus} from './router-service.mjs';
import {safeTransportFailure} from './transport-diagnostics.mjs';
const fail=code=>{throw new Error(code);};
const deny=(res,status,error)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify({error}));};
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export async function serveSharedRouter(configPath,runId) {
  const config=loadRouterConfig(configPath),base=config.registryPath;
  let serviceLock;
  try{serviceLock=openSync(base+'.service.lock','wx',0o600);}
  catch(e){fail(e.code==='EEXIST'?'ROUTER_SERVICE_LOCKED':'ROUTER_START_FAILED');}
  const slots=new Map();let adapter,server,pulse,closing=false,refreshing=null,closePromise,registryHealthy=false;
  const statusOf=slot=>{
    const budget=slot.ledger?.snapshot()??slot.grant;
    const state=budget.expiresAt!==null&&Date.now()>=budget.expiresAt?'expired':budget.remaining===0?'budget_exhausted':slot.router&&!slot.router.snapshot().stopped?'running':'unavailable';
    return {threadId:slot.threadId,ready:state==='running',state,active:slot.router?.snapshot().active===true,...(slot.error?{error:slot.error}:{})};
  };
  const publish=state=>atomicJson(base+'.status.json',{runId,pid:process.pid,state,updatedAt:Date.now(),port:server?.address()?.port??0,
    registryHealthy,active:[...slots.values()].some(s=>s.router?.snapshot().active),bindings:[...slots.values()].map(statusOf)});
  const release=async slot=>{
    let failed=false;
    try{slot.router?.stop();}catch{failed=true;}
    try{await slot.router?.close?.();}catch{failed=true;}
    try{slot.ledger?.close();}catch{failed=true;}
    if(failed)fail('ROUTER_CLEANUP_FAILED');
  };
  const refresh=()=>{
    if(refreshing)return refreshing;
    refreshing=(async()=>{
      try {
        const registry=readRouterRegistry(base);
        for(const prior of slots.values())if(!registry.bindings.some(b=>b.threadId===prior.threadId&&b.budgetPath===prior.budgetPath))fail('ROUTER_BINDING_INVALID');
        for(const binding of registry.bindings){
          if(closing)return;
          if(slots.has(binding.threadId))continue;
          const budget=readBudget(binding.budgetPath);
          if(budget.threadId!==binding.threadId)fail('ROUTER_BINDING_INVALID');
          const slot={...binding,grant:budget,ledger:null,router:null};
          // Exhausted/expired grants remain visible and rejected; never create a fresh allowance.
          if(budget.remaining!==0&&(budget.expiresAt===null||Date.now()<budget.expiresAt)){
            try {
              slot.ledger=openBudget(binding.budgetPath);
              slot.router=await adapter.createManagedRouter({grant:slot.ledger.snapshot(),options:config.adapterOptions,
                guardTransport:transport=>async request=>{
                  if(closing||request.signal?.aborted)fail('BUDGET_UNAVAILABLE');
                  try{slot.ledger.reserve();}catch(error){
                    if(error.message==='BUDGET_WRITE_FAILED'){
                      slot.error='BUDGET_WRITE_FAILED';
                      const storageCode=['EIO','EBADF','EACCES','EPERM','ENOSPC','ENOENT','ESTALE','ENOTCONN','ETIMEDOUT','UNKNOWN'].includes(error.storageCode)?error.storageCode:'UNKNOWN';
                      try{appendFileSync(base+'.'+runId+'.events.jsonl',JSON.stringify({timestamp:Date.now(),threadId:binding.threadId,stage:'failure',code:'local_storage_failed',storageCode})+'\n',{mode:0o600});}catch{/* diagnostic only */}
                      slot.router?.stop('local_storage_failed');
                    }
                    throw error;
                  }
                  const started=performance.now();
                  try{return await transport(request);}
                  catch(error){
                    const receipt={timestamp:Date.now(),threadId:binding.threadId,usedRequests:slot.ledger.snapshot().usedRequests,
                      stage:'failure',code:'transport_failed_before_headers',...safeTransportFailure(error),
                      elapsedMs:Math.max(0,Math.round(performance.now()-started)),aborted:request.signal?.aborted===true};
                    if(['official','company'].includes(request.route))receipt.route=request.route;
                    try{appendFileSync(base+'.'+runId+'.events.jsonl',JSON.stringify(receipt)+'\n',{mode:0o600});}catch{/* diagnostic only */}
                    throw error;
                  }
                },
                record:event=>{
                  const receipt={timestamp:Date.now(),threadId:binding.threadId,usedRequests:slot.ledger.snapshot().usedRequests};
                  for(const key of ['stage','code'])if(typeof event[key]==='string'&&/^[a-zA-Z_]{1,64}$/.test(event[key]))receipt[key]=event[key];
                  for(const key of ['model','upstreamModel'])if(typeof event[key]==='string'&&/^[a-zA-Z0-9_.-]{1,80}$/.test(event[key]))receipt[key]=event[key];
                  if(uuid.test(event.turnId??''))receipt.turnId=event.turnId;
                  if(['official','company'].includes(event.route))receipt.route=event.route;
                  if(Number.isInteger(event.upstreamStatus)&&event.upstreamStatus>=100&&event.upstreamStatus<=599)receipt.upstreamStatus=event.upstreamStatus;
                  try{appendFileSync(base+'.'+runId+'.events.jsonl',JSON.stringify(receipt)+'\n',{mode:0o600});}catch{/* diagnostic only */}
                },
              });
              if(slot.router.port!==config.port)fail('ROUTER_BINDING_INVALID');
              if(closing){await release(slot);return;}
            }catch(error){
              await release(slot).catch(()=>{});
              slot.router=null;
              slot.error=['BUDGET_LOCKED','BUDGET_UNAVAILABLE','BUDGET_CORRUPT','MANAGED_CONFIG_CHANGED','MANAGED_INGRESS_UNAVAILABLE','MANAGED_CREDENTIAL_UNAVAILABLE'].includes(error.message)?error.message:'ROUTER_BINDING_INITIALIZATION_FAILED';
              // Do not retry credential loading every heartbeat or disable unrelated tasks.
            }
          }
          slots.set(binding.threadId,slot);
        }
        registryHealthy=true;
      }catch{registryHealthy=false;}
    })().finally(()=>{refreshing=null;});
    return refreshing;
  };
  const close=()=>{
    if(closePromise)return closePromise;
    closing=true;clearInterval(pulse);
    closePromise=(async()=>{
      await refreshing;
      let failed=false;
      // Stop all bindings before draining the listener; one adapter cannot skip others.
      for(const slot of slots.values())try{slot.router?.stop();}catch{failed=true;}
      try{if(server?.listening)await new Promise(r=>{server.close(r);server.closeAllConnections();});}catch{failed=true;}
      for(const slot of slots.values())try{await release(slot);}catch{failed=true;}
      try{publish('stopped');}catch{failed=true;}
      try{closeSync(serviceLock);}catch{failed=true;}
      try{unlinkSync(base+'.service.lock');}catch{failed=true;}
      if(failed){
        try{appendFileSync(base+'.lifecycle-errors.jsonl',JSON.stringify({runId,operation:'close',code:'ROUTER_CLEANUP_FAILED'})+'\n',{mode:0o600});}catch{/* diagnostic only */}
        fail('ROUTER_CLEANUP_FAILED');
      }
    })();
    return closePromise;
  };
  try {
    const bytes=readFileSync(config.adapterPath);
    if(createHash('sha256').update(bytes).digest('hex')!==config.adapterSha256)fail('ROUTER_ADAPTER_CHANGED');
    adapter=await import(pathToFileURL(config.adapterPath).href);
    await refresh();if(!registryHealthy)fail('ROUTER_REGISTRY_INVALID');
    server=createServer((req,res)=>{
      if(closing||!registryHealthy){deny(res,503,'router_registry_unavailable');return;}
      let metadata;try{metadata=JSON.parse(req.headers['x-codex-turn-metadata']);}catch{deny(res,403,'request_rejected');return;}
      const slot=slots.get(metadata?.thread_id);
      if(!slot){deny(res,403,'thread_not_registered');return;}
      const state=statusOf(slot).state;
      if(state!=='running'){deny(res,state==='expired'?410:state==='budget_exhausted'?429:503,state==='expired'?'router_expired':state==='budget_exhausted'?'budget_exhausted':slot.error==='BUDGET_WRITE_FAILED'?'local_storage_failed':'router_unavailable');return;}
      // The existing per-task core still authenticates ingress and verifies metadata/body/model.
      Promise.resolve().then(()=>slot.router.handle(req,res)).catch(()=>{slot.router.stop();res.destroy();});
    });
    server.requestTimeout=65_000;server.headersTimeout=10_000;
    await new Promise((yes,no)=>{server.once('error',no);server.listen(config.port,'127.0.0.1',()=>{server.off('error',no);yes();});});
    server.on('error',()=>{void close().catch(()=>{});});publish('running');
    pulse=setInterval(()=>{
      let stop;try{stop=JSON.parse(readFileSync(base+'.stop.json','utf8'));}catch{/* absent */}
      if(stop?.runId===runId){void close().catch(()=>{});return;}
      void refresh().then(()=>{if(!closing)publish('running');}).catch(()=>{void close().catch(()=>{});});
    },250);
    return {close,status:()=>routerStatus(configPath)};
  }catch(error){await close().catch(()=>{});throw new Error(error.code==='EADDRINUSE'?'ROUTER_PORT_BUSY':error.message);}
}
