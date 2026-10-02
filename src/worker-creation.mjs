import {mkdir,open,readFile,stat,lstat} from 'node:fs/promises';
import {isAbsolute,join} from 'node:path';
import {workerModePlan} from './worker-mode.mjs';
import {connectAppServer} from './app-server-client.mjs';
import {atomicWrite} from './store.mjs';
import {initializeBudget} from './router-budget.mjs';
import {loadRouterConfig,routerStatus,startRouter} from './router-service.mjs';
import {registerRouterBudget,readRouterRegistry} from './router-registry.mjs';
import {inspectWorkerModels,bindWorkerModels} from './worker-model-binding.mjs';

const fail=code=>{throw new Error(code);};
const known=new Set(['WORKER_REQUEST_INVALID','WORKER_BUDGET_REQUIRED','WORKER_BUDGET_INVALID','WORKER_OFFICIAL_OVERRIDE',
  'WORKER_SHARED_ROUTER_REQUIRED','WORKER_ROUTER_UNAVAILABLE','WORKER_PROVIDER_INVALID','WORKER_MODEL_UNAVAILABLE',
  'WORKER_ROUTE_MISMATCH','WORKER_ROUTER_BINDING_PENDING','WORKER_CREATION_EXISTS','WORKER_MODEL_BINDING_INVALID','WORKER_MODEL_BINDING_CONFLICT','WORKER_MODEL_BINDING_LOCKED',
  'WORKER_INITIALIZATION_AUTH_REQUIRED','WORKER_INITIALIZATION_FAILED','WORKER_PERSISTENCE_UNVERIFIED','WORKER_ROUTER_START_FAILED']);
const initializationPrompt='请只回复 INIT_OK，不调用工具。';
const safe=error=>known.has(error?.message)?error.message:'WORKER_CREATION_FAILED';
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
function validate(request) {
  const mode=workerModePlan(request);if(mode.status==='needs_user_choice')return {mode};
  const allowed=['operationId','hostId','mode','title','model','cwd','receiptDirectory','codexExecutable','codexHome','provider','routerConfigPath','budget','initialization'];
  if(Object.keys(request).some(k=>!allowed.includes(k)))fail('WORKER_REQUEST_INVALID');
  const r={...request,title:mode.title};
  if(r.codexHome!==undefined&&(typeof r.codexHome!=='string'||!isAbsolute(r.codexHome)))fail('WORKER_REQUEST_INVALID');
  if(r.initialization!==undefined&&(!r.initialization||typeof r.initialization!=='object'||
    Object.keys(r.initialization).join(',')!=='authorized'||typeof r.initialization.authorized!=='boolean'))fail('WORKER_REQUEST_INVALID');
  if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(r.operationId??'')||r.hostId!=='local'||
    typeof r.model!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(r.model)||
    ['cwd','receiptDirectory','codexExecutable'].some(k=>typeof r[k]!=='string'||!isAbsolute(r[k])))fail('WORKER_REQUEST_INVALID');
  if(r.mode==='router') {
    if(r.budget!==undefined&&(!r.budget||typeof r.budget!=='object'||Array.isArray(r.budget)||Object.keys(r.budget).sort().join(',')!=='expiresAt,maxRequests'||
      !Number.isSafeInteger(r.budget.maxRequests)||r.budget.maxRequests<1||r.budget.maxRequests>100||
      !Number.isSafeInteger(r.budget.expiresAt)||r.budget.expiresAt<=Date.now()||r.budget.expiresAt-Date.now()>7_200_000))fail('WORKER_BUDGET_INVALID');
    if(typeof r.routerConfigPath!=='string'||!isAbsolute(r.routerConfigPath)||typeof r.provider!=='string'||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(r.provider)||r.provider==='openai')fail('WORKER_REQUEST_INVALID');
  }else if(r.budget!==undefined||r.routerConfigPath!==undefined||r.provider!==undefined&&r.provider!=='openai')fail('WORKER_REQUEST_INVALID');
  return {mode,r};
}
async function inspect(r,rpc,deps,{allowStartable=false}={}) {
  const {config}=await rpc.request('config/read',{cwd:r.cwd,includeLayers:false});
  const provider=r.mode==='official'?'openai':r.provider;
  let routerConfig,routerStartRequired=false;
  if(r.mode==='official') {
    if(config?.model_providers?.openai)fail('WORKER_OFFICIAL_OVERRIDE');
  }else {
    routerConfig=loadRouterConfig(r.routerConfigPath);
    const status=(deps.routerStatus??routerStatus)(r.routerConfigPath);
    if(!routerConfig.registryPath||status.kind!=='shared')fail('WORKER_SHARED_ROUTER_REQUIRED');
    routerStartRequired=allowStartable&&['stopped','not_started'].includes(status.state)&&status.lockPresent===false&&
      status.active!==true&&status.stopRequested!==true&&status.registryHealthy!==false;
    if(!routerStartRequired&&(status.state!=='running'||status.registryHealthy!==true||status.stopRequested===true))fail('WORKER_ROUTER_UNAVAILABLE');
    readRouterRegistry(routerConfig.registryPath);
    await inspectWorkerModels(routerConfig.adapterOptions,r.model);
    const p=config?.model_providers?.[provider];let url;
    try{url=new URL(p?.base_url);}catch{fail('WORKER_PROVIDER_INVALID');}
    if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||Number(url.port)!==(routerStartRequired?routerConfig.port:status.port)||
      !['/v1','/v1/'].includes(url.pathname)||url.username||url.password||url.search||url.hash||
      p.wire_api!=='responses'||p.requires_openai_auth!==true||p.supports_websockets!==false||
      p.request_max_retries!==0||p.stream_max_retries!==0||p.env_key||p.auth||p.http_headers||p.experimental_bearer_token||
      typeof p.env_http_headers?.['X-Worker-Router-Token']!=='string')fail('WORKER_PROVIDER_INVALID');
  }
  const models=await rpc.request('model/list',{includeHidden:false,limit:100});
  if(!models.data?.some(model=>model.id===r.model))fail('WORKER_MODEL_UNAVAILABLE');
  return {provider,routerConfig,routerStartRequired};
}
export async function planWorkerCreation(request,deps={}) {
  const {mode,r}=validate(request);if(!r)return mode;
  let rpc;
  try {
    // Reject recovery operations before readiness can be used to consume a team claim.
    // The exclusive receipt write in create still handles races after this read.
    try{await lstat(join(r.receiptDirectory,r.operationId+'.json'));fail('WORKER_CREATION_EXISTS');}
    catch(error){if(error.code!=='ENOENT')throw error;}
    rpc=await (deps.connect??connectAppServer)(r.codexExecutable,{codexHome:r.codexHome});
    const {provider,routerStartRequired}=await inspect(r,rpc,deps,{allowStartable:true});
    return {...mode,status:!r.initialization?.authorized?'needs_initialization_authorization':routerStartRequired?'needs_router_start':'ready_to_create',hostId:r.hostId,model:r.model,provider,
      routerStartRequired,
      usagePolicy:r.mode==='router'?(r.budget?'legacy-bounded':'unlimited'):'provider-managed',
      initialization:{prompt:initializationPrompt,willSendOnCreate:true,countsAgainstRouterBudget:r.mode==='router'&&r.budget!==undefined},
      sendsModelRequest:false,allocatesBudget:false,requiresExplicitCreateAuthorization:true};
  }catch(error){throw new Error(safe(error));}finally{await rpc?.close();}
}

// Service preparation is separate from the Manager's one-use creation claim.
// It never creates a task, sends a model request, or changes team membership.
export async function ensureWorkerRouter(request,deps={}) {
  const {mode,r}=validate(request);if(!r)return mode;
  if(r.initialization?.authorized!==true)fail('WORKER_INITIALIZATION_AUTH_REQUIRED');
  try {
    try{await lstat(join(r.receiptDirectory,r.operationId+'.json'));fail('WORKER_CREATION_EXISTS');}
    catch(error){if(error.code!=='ENOENT')throw error;}
    const plan=await planWorkerCreation(r,deps);
    if(!plan.routerStartRequired)return {...plan,routerStarted:false};
    try{await (deps.startRouter??startRouter)(r.routerConfigPath);}
    catch{fail('WORKER_ROUTER_START_FAILED');}
    const ready=await planWorkerCreation(r,deps);
    if(ready.status!=='ready_to_create')fail('WORKER_ROUTER_UNAVAILABLE');
    return {...ready,routerStarted:true};
  }catch(error){throw new Error(safe(error));}
}
export async function createWorkerCreation(request,deps={}) {
  const {mode,r}=validate(request);if(!r)return mode;
  if(r.initialization?.authorized!==true)fail('WORKER_INITIALIZATION_AUTH_REQUIRED');
  await mkdir(r.receiptDirectory,{recursive:true});
  const receiptPath=join(r.receiptDirectory,r.operationId+'.json');
  let file;
  try{file=await open(receiptPath,'wx',0o600);}catch(error){fail(error.code==='EEXIST'?'WORKER_CREATION_EXISTS':'WORKER_CREATION_FAILED');}
  const receipt={schemaVersion:2,operationId:r.operationId,hostId:'local',mode:r.mode,title:r.title,model:r.model,
    cwd:r.cwd,provider:r.mode==='official'?'openai':r.provider,threadId:null,status:'starting',registered:false,desktopVerified:false,
    sendsModelRequest:false,persistenceVerified:false,initializationAuthorized:true,createdAt:new Date().toISOString()};
  try{await file.writeFile(JSON.stringify(receipt,null,2)+'\n');await file.sync();}finally{await file.close();}
  const save=()=>atomicWrite(receiptPath,JSON.stringify(receipt,null,2)+'\n');let rpc;
  try {
    rpc=await (deps.connect??connectAppServer)(r.codexExecutable,{codexHome:r.codexHome});
    const {provider,routerConfig}=await inspect(r,rpc,deps);
    // Current native schema has no allowProviderModelFallback parameter. Enforce identity
    // with preflight plus returned model/provider checks before registration or any turn.
    const created=await rpc.request('thread/start',{model:r.model,modelProvider:provider,cwd:r.cwd,
      sandbox:'workspace-write',approvalPolicy:'on-request',ephemeral:false});
    if(typeof created.thread?.id!=='string'||!created.thread.id)fail('WORKER_ROUTE_MISMATCH');
    receipt.threadId=created.thread.id;receipt.status='created';await save();
    if(!uuid.test(receipt.threadId)||created.model!==r.model||created.modelProvider!==provider||created.thread.modelProvider!==provider)fail('WORKER_ROUTE_MISMATCH');
    await rpc.request('thread/name/set',{threadId:receipt.threadId,name:r.title});
    if(r.mode==='router') {
      // New tasks default to persistent metering without limits. Explicit old requests remain compatible.
      const budgetPath=join(r.receiptDirectory,r.operationId+'.budget.jsonl');
      initializeBudget(budgetPath,{threadId:receipt.threadId,usedRequests:0,...r.budget});
      receipt.usagePolicy=r.budget?'legacy-bounded':'unlimited';
      receipt.budgetPath=budgetPath;receipt.routerConfigPath=r.routerConfigPath;await save();
      await bindWorkerModels(routerConfig.adapterOptions,r.model,receipt.threadId);
      registerRouterBudget(routerConfig.registryPath,budgetPath);
      const until=Date.now()+(deps.bindingWaitMs??5000);let ready=false;
      do {
        const status=(deps.routerStatus??routerStatus)(r.routerConfigPath);
        ready=status.state==='running'&&status.registryHealthy===true&&status.bindings?.some(b=>b.threadId===receipt.threadId&&b.ready);
        if(ready)break;
        await new Promise(resolve=>setTimeout(resolve,50));
      }while(Date.now()<until);
      if(!ready)fail('WORKER_ROUTER_BINDING_PENDING');
    }
    // Record intent before dispatch. An uncertain result is never retried automatically.
    receipt.status='initialization-requested';receipt.sendsModelRequest=true;await save();
    const started=await rpc.request('turn/start',{threadId:receipt.threadId,model:r.model,
      input:[{type:'text',text:initializationPrompt}]});
    if(!uuid.test(started.turn?.id??''))fail('WORKER_INITIALIZATION_FAILED');
    receipt.initializationTurnId=started.turn.id;await save();
    const finished=await rpc.waitTurn(started.turn.id);
    if(finished.id!==started.turn.id||finished.status!=='completed')fail('WORKER_INITIALIZATION_FAILED');
    const persisted=await rpc.request('thread/read',{threadId:receipt.threadId,includeTurns:false});
    if(persisted.thread?.id!==receipt.threadId||persisted.thread.modelProvider!==provider)fail('WORKER_ROUTE_MISMATCH');
    try {
      const path=persisted.thread.path;
      if(typeof path!=='string'||!isAbsolute(path))throw Error();
      const file=await stat(path);if(!file.isFile()||file.size===0)throw Error();
    }catch{fail('WORKER_PERSISTENCE_UNVERIFIED');}
    // A live creator's metadata read does not prove the next process can load history.
    await rpc.close();rpc=null;
    rpc=await (deps.connect??connectAppServer)(r.codexExecutable,{codexHome:r.codexHome});
    let reread;
    try{reread=await rpc.request('thread/read',{threadId:receipt.threadId,includeTurns:true});}
    catch{fail('WORKER_PERSISTENCE_UNVERIFIED');}
    if(reread.thread?.id!==receipt.threadId||reread.thread.modelProvider!==provider||
      !reread.thread.turns?.some(t=>t.id===receipt.initializationTurnId&&t.status==='completed'))fail('WORKER_PERSISTENCE_UNVERIFIED');
    receipt.persistenceVerified=true;
    receipt.status='initialized-awaiting-desktop-confirmation';
    await save();return receipt;
  }catch(error){receipt.status='needs-reconciliation';receipt.failure=safe(error);await save();throw new Error(receipt.failure);}
  finally{await rpc?.close();}
}
export async function readWorkerCreationReceipt(path) {
  let r;try{r=JSON.parse(await readFile(path,'utf8'));}catch{fail('WORKER_RECEIPT_INVALID');}
  if(r.schemaVersion!==2||!['official','router'].includes(r.mode))fail('WORKER_RECEIPT_INVALID');
  return {operationId:r.operationId,status:r.status,hostId:r.hostId,threadId:r.threadId,mode:r.mode,title:r.title,model:r.model,provider:r.provider,
    registered:false,desktopVerified:false,sendsModelRequest:r.sendsModelRequest===true,
    usagePolicy:r.usagePolicy??(r.mode==='router'?'legacy-bounded':'provider-managed'),
    persistenceVerified:r.persistenceVerified===true,initializationTurnId:r.initializationTurnId??null};
}
