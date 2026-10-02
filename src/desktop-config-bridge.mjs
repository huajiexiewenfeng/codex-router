import {readFile,writeFile,realpath,mkdtemp,stat} from 'node:fs/promises';
import {openSync,writeFileSync,readFileSync,closeSync,unlinkSync} from 'node:fs';
import {join,isAbsolute} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {loadRouterConfig,routerStatus} from './router-service.mjs';
import {atomicWrite} from './store.mjs';
import {desktopServiceSnapshot,controlDesktopService} from './desktop-service-control.mjs';
import {prepareDesktopEndpoint} from './desktop-endpoint.mjs';
import {prepareDesktopIngress} from './desktop-ingress.mjs';
import {validateManagedOptions} from './managed-model-router.mjs';
import {validateModelRegistry,usesActiveGateway} from './model-registry.mjs';
import {planModelRegistryUpdate,validateModelBindings} from './model-registry-update.mjs';
import {saveModelDraft,applyModelDraft} from './model-registry-store.mjs';
import {withFileLocks} from './registry-projection.mjs';
import {createGatewayEnrollment} from './gateway-enrollment.mjs';
import {syncGatewayModels} from './gateway-model-sync.mjs';
import {verifyDesktopModel} from './desktop-model-verification.mjs';
import {discoverDesktopCodex,discoverDesktopBackend} from './desktop-codex-discovery.mjs';
import {launchDesktopCodex} from './desktop-codex-launch.mjs';
import {planDesktopProvider,applyDesktopProvider} from './desktop-provider-install.mjs';
import {upgradeDesktopRuntime} from './desktop-runtime-upgrade.mjs';
import {syncDesktopCatalog,readDesktopOfficialCatalog} from './desktop-catalog-sync.mjs';
import {readBundledOfficialModels} from './desktop-official-catalog.mjs';
import {createDesktopServiceRecovery} from './desktop-service-recovery.mjs';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=code=>{throw new Error(code);};
const exact=(value,keys)=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
async function optionalBytes(path){try{return await readFile(path,'utf8');}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function withMaintenanceLocks(paths,owner,operation){
 const held=[],bytes=JSON.stringify(owner);
 try{
  // Install one common owner synchronously on each exclusive lock before any await.
  for(const path of paths){const handle=openSync(path,'wx',0o600);held.push({path,handle});writeFileSync(handle,bytes);}
  return await operation();
 }finally{
  for(const {path,handle} of held.reverse()){
   closeSync(handle);
   if(readFileSync(path,'utf8')!==bytes)fail('OM_LOCK_CHANGED');
   unlinkSync(path);
  }
 }
}
const safeCodes=new Set(['DESKTOP_CONFIG_REQUEST','DESKTOP_CONFIG_CHANGED','DESKTOP_CONFIG_STALE','DESKTOP_CONFIG_DRAFT','MR_STORE_BLOCKED','MR_STORE_STALE','MR_STORE_DRAFT_CHANGED','MR_STORE_LOCKED','MR_UPDATE_BINDINGS']);
for(const code of ['OP_CONFIRM','OP_URL','OP_STALE','OP_STOP_REQUIRED'])safeCodes.add(code);
for(const code of ['OM_CONFIRM','OM_STALE','OM_STOP_REQUIRED','OM_SOURCE_UNAVAILABLE','OM_SHARED_ONLY','OM_LOCK_CHANGED','OM_PORT_REQUIRED'])safeCodes.add(code);
for(const code of ['STATUS_AMBIGUOUS','PROCESS_NOT_ABSENT','PORT_NOT_FREE','LOCK_OWNER_AMBIGUOUS','BUDGET_OWNER_AMBIGUOUS','STOP_OWNER_AMBIGUOUS','SNAPSHOT_CHANGED','REGISTRY_BUSY','SHARED_ONLY','PATH_UNSAFE','FILE_TOO_LARGE','CHECK_FAILED','CONFIRMATION_REQUIRED','BUSY','PLAN_EXPIRED','FAILED','GUARD_RELEASE_FAILED'])safeCodes.add('ROUTER_RECOVERY_'+code);
for(const code of ['DW_DISABLED','DW_INPUT','DW_CONFIRM','DW_UNKNOWN','DW_RECORD','DW_HOST','DW_PREPARE_FAILED','DW_NOT_READY','DW_CHANGED','DW_STORAGE'])safeCodes.add(code);
for(const code of ['GM_INPUT','GM_REDIRECT','GM_AUTH','GM_UNSUPPORTED','GM_HTTP','GM_TOO_LARGE','GM_FORMAT','GM_PAGINATION','GM_EMPTY','GM_TIMEOUT','GM_NETWORK','DG_URL','DG_HTTP_CONFIRMATION'])safeCodes.add(code);
for(const code of ['GMG_BOUND','GMG_CONFIRM','GMG_SERVICE_ACTIVE','GMG_NAME','GMG_MISSING','GMG_BACKUP'])safeCodes.add(code);
for(const code of ['GV_NOT_READY','GV_WORKER_MISSING'])safeCodes.add(code);
for(const code of ['AG_ACTIVE_DELETE','AG_RUNTIME_UPDATE_REQUIRED'])safeCodes.add(code);
for(const code of ['DU_PACKAGE_INVALID','DU_FILE_INVALID','DU_CONFIG_UNSUPPORTED','DU_CONFIG_CHANGED','DU_LOCKED','DU_UPGRADE_FAILED','DU_STOP_REQUIRED'])safeCodes.add(code);
for(const code of ['GV_CONFIRM','GV_MODEL_MISSING','GV_INPUT','GV_URL','GV_REDIRECT','GV_AUTH','GV_HTTP','GV_CONTENT_TYPE','GV_INCOMPLETE','GV_FORMAT','GV_FAILED','GV_MARKER','GV_TOO_LARGE','GV_TIMEOUT','GV_NETWORK','RC_CONFIG','RC_REFERENCE','RC_PLATFORM','RC_UNAVAILABLE'])safeCodes.add(code);
for(const code of ['DESKTOP_CODEX_DISABLED','DESKTOP_CODEX_STALE','DESKTOP_CODEX_PORT_REQUIRED','DCD_HOME_UNAVAILABLE','DCD_INSTALLATION_AMBIGUOUS','DCD_INSTALLATION_INVALID','DCD_UNAVAILABLE','DCL_CODEX_RUNNING','DCL_PROCESS_CHECK_FAILED','DCL_ROUTER_UNAVAILABLE','DCL_PROVIDER_REQUIRED','DCL_CONFIG_CHANGED','DCL_CREDENTIAL_UNAVAILABLE','DCL_SPAWN_FAILED','DCL_LOCKED','DCL_UNAVAILABLE','DPI_CONFIG_INVALID','DPI_CONFLICT','DPI_STALE','DPI_LOCKED','DPI_BACKUP_CONFLICT','DPI_UNAVAILABLE'])safeCodes.add(code);
for(const code of ['DESKTOP_SERVICE_DISABLED','DESKTOP_SERVICE_NOT_RUNNING','DESKTOP_SERVICE_NOT_STARTABLE','ROUTER_REGISTRY_INVALID','ROUTER_REGISTRY_EXISTS','ROUTER_REGISTRY_WRITE_FAILED','ROUTER_ADAPTER_CHANGED','ROUTER_START_FAILED','ROUTER_START_TIMEOUT','ROUTER_PORT_BUSY','ROUTER_SERVICE_LOCKED','ROUTER_STOP_FAILED'])safeCodes.add(code);
for(const code of ['DE_CONFIG_INVALID','DE_CONFIG_CHANGED','DE_BINDINGS_PRESENT','DE_LOCKED','DE_PREPARE_FAILED'])safeCodes.add(code);
for(const code of ['DI_CONFIG_INVALID','DI_CONFIG_CHANGED','DI_FILE_INVALID','DI_REFERENCE_CONFLICT','DI_BINDINGS_PRESENT','DI_CREDENTIAL_CHANGED','DI_CREDENTIAL_UNCERTAIN','DI_PLAN_CHANGED','DI_MAPPING_CONFLICT','DI_LOCKED','DI_UNAVAILABLE'])safeCodes.add(code);

// Host-owned instance, not a web endpoint. Neither paths nor credentials are
// accepted by dispatch except a write-only Key in gateway-create-key.
// The IPC host owns caller authentication. Never log requests.
export async function createDesktopConfigBridge({routerConfigPath,draftRoot,allowServiceControl=false,bundledRuntimeRoot=null,workerJobs=null,codexIntegration={discover:discoverDesktopCodex,discoverBackend:discoverDesktopBackend,launch:launchDesktopCodex}}){
 let configPath,root,config,options,modelPath,bindingsPath;
 try{
  if(!isAbsolute(routerConfigPath)||!isAbsolute(draftRoot))throw Error();
  configPath=await realpath(routerConfigPath);root=await realpath(draftRoot);
  if(!(await stat(root)).isDirectory())throw Error();
  config=loadRouterConfig(configPath);options=validateManagedOptions(config.adapterOptions);
  modelPath=await realpath(options.modelRegistryPath);bindingsPath=await realpath(options.bindingsPath);
  if(modelPath===bindingsPath)throw Error();
 }catch{fail('DESKTOP_CONFIG_UNAVAILABLE');}
 let configIdentity=JSON.stringify(config);
 const drafts=new Map();
 let enrollment;
 let codexSetup;
 let officialPlan;
 const recovery=createDesktopServiceRecovery({configPath});
 async function gateway(){
  return enrollment??=await createGatewayEnrollment({modelRegistryPath:modelPath,bindingsPath,credentialConfigPath:options.credentialConfigPath,operationRoot:root});
 }
 async function checkConfig(){
  if(JSON.stringify(loadRouterConfig(configPath))!==configIdentity||await realpath(options.modelRegistryPath)!==modelPath||await realpath(options.bindingsPath)!==bindingsPath)fail('DESKTOP_CONFIG_CHANGED');
 }
 let runtimeUpgrade=null;
 async function upgradeRuntime(){
  if(!bundledRuntimeRoot)return;
  await checkConfig();
  try{
   const result=await upgradeDesktopRuntime(configPath,bundledRuntimeRoot,{expectedConfigIdentity:configIdentity});
   if(result.status==='updated'){
    // Adopt only the identity returned by our own locked upgrade, not disk drift.
    config=JSON.parse(result.configIdentity);options=validateManagedOptions(config.adapterOptions);configIdentity=result.configIdentity;
    await checkConfig();drafts.clear();enrollment=null;codexSetup=null;
   }
   const {configIdentity:ignored,...safe}=result;runtimeUpgrade=safe;
  }catch(e){runtimeUpgrade={status:'blocked',code:safeCodes.has(e.message)?e.message:'DU_UPGRADE_FAILED'};}
 }
 await upgradeRuntime();
 function bundledLoader(target){return async()=>{
  if(typeof codexIntegration.discoverBackend!=='function')throw Error('DOC_UNAVAILABLE');
  const backend=await codexIntegration.discoverBackend();
  if(backend.codexHome!==target.codexHome)throw Error('DOC_UNAVAILABLE');
  return readBundledOfficialModels({codexExecutable:backend.codexExecutable});
 };}
 async function officialSource(){
  const target=await codexIntegration.discover();await checkConfig();
  const source=await readDesktopOfficialCatalog({configPath:join(target.codexHome,'config.toml'),loadBundledModels:bundledLoader(target)});
  const ids=source.models.filter(m=>m.visibility==='list'&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(m.slug)&&!m.slug.endsWith('_self')).map(m=>m.slug).sort();
  return {target,ids};
 }
 async function syncCatalog(){
  if(!allowServiceControl)return {status:'failed',code:'DCM_DISABLED'};
  try{
   const target=await codexIntegration.discover();await checkConfig();
   return await syncDesktopCatalog({configPath:join(target.codexHome,'config.toml'),registryPath:modelPath,stateRoot:root,loadBundledModels:bundledLoader(target)});
  }catch(e){return {status:'failed',code:/^(DCM|DCD)_[A-Z_]+$/.test(e.message)?e.message:'DCM_UNAVAILABLE'};}
 }
 async function snapshot(){
  const bytes=await readFile(modelPath),registry=validateModelRegistry(JSON.parse(bytes));
  if(registry.schemaVersion!==2)fail('DESKTOP_CONFIG_UNAVAILABLE');
  return {registry,revision:digest(bytes)};
 }
 async function gatewayWorkers(registry,providerId){
  const bindings=JSON.parse(await readFile(bindingsPath,'utf8'));validateModelBindings(bindings,registry.models,usesActiveGateway(registry));
  if(usesActiveGateway(registry))return registry.activeProviderId===providerId?bindings.map(b=>({hostId:b.hostId,threadId:b.threadId,allowedModels:registry.models.filter(m=>m.providerId===providerId&&m.enabled!==false).map(m=>m.selectionId)})):[];
  const aliases=new Set(registry.models.filter(m=>m.providerId===providerId).map(m=>m.selectionId));
  return bindings.filter(b=>b.allowedModels.some(id=>aliases.has(id))).map(b=>({hostId:b.hostId,threadId:b.threadId,allowedModels:b.allowedModels.filter(id=>aliases.has(id))}));
 }
 function requireStopped(){const s=routerStatus(configPath);if(!['not_started','stopped'].includes(s.state)||s.lockPresent||s.stopRequested||s.active)fail('GMG_SERVICE_ACTIVE');}
 return Object.freeze({async dispatch(request){
  try{
   await checkConfig();
   if(request?.operation==='router-recovery-prepare'&&exact(request,['operation'])){
    if(!allowServiceControl)fail('DESKTOP_SERVICE_DISABLED');
    return {ok:true,...await recovery.prepare()};
   }
   if(request?.operation==='router-recovery-confirm'&&exact(request,['operation','token','confirmed'])){
    if(!allowServiceControl)fail('DESKTOP_SERVICE_DISABLED');
    await checkConfig();return {ok:true,...await recovery.recover({token:request.token,confirmed:request.confirmed}),sendsRequest:false,requiresServiceStart:true};
   }
   if(request?.operation==='official-models-prepare'&&exact(request,['operation'])){
    if(!allowServiceControl)fail('DESKTOP_SERVICE_DISABLED');officialPlan=null;
    if(config.port===0)fail('OM_PORT_REQUIRED');
    const source=await officialSource();if(!source.ids.length)fail('OM_SOURCE_UNAVAILABLE');
    officialPlan={...source,identity:configIdentity,receiptId:randomUUID()};
    return {ok:true,receiptId:officialPlan.receiptId,addedModels:source.ids.filter(id=>!options.officialModels.includes(id)),sendsRequest:false};
   }
   if(request?.operation==='official-models-sync'&&exact(request,['operation','receiptId','confirmed'])){
    if(!allowServiceControl)fail('DESKTOP_SERVICE_DISABLED');if(request.confirmed!==true)fail('OM_CONFIRM');
    const plan=officialPlan;if(!plan||plan.receiptId!==request.receiptId||plan.identity!==configIdentity)fail('OM_STALE');
    if(!config.registryPath)fail('OM_SHARED_ONLY');
    if(config.port===0)fail('OM_PORT_REQUIRED');
    const stopped=()=>{const s=routerStatus(configPath);if(!['not_started','stopped'].includes(s.state)||s.lockPresent||s.active||s.stopRequested)fail('OM_STOP_REQUIRED');};
    await checkConfig();stopped();
    const statePaths=['.status.json','.stop.json'].map(suffix=>config.registryPath+suffix),stateBytes=await Promise.all(statePaths.map(optionalBytes));
    const unchangedState=async()=>{for(const [i,path] of statePaths.entries())if(await optionalBytes(path)!==stateBytes[i])fail('OM_STALE');};
    // Slow discovery happens outside all service locks. Recheck before the short commit.
    const source=await officialSource();
    if(source.target.codexHome!==plan.target.codexHome||JSON.stringify(source.ids)!==JSON.stringify(plan.ids))fail('OM_STALE');
    await checkConfig();await unchangedState();stopped();
    const owner={configPath,createdAt:Date.now(),kind:'official-models-sync',pid:process.pid};
    const result=await withMaintenanceLocks([configPath+'.desktop-control.lock',config.registryPath+'.service.lock'],owner,async()=>{
      await checkConfig();await unchangedState();const before=await readFile(configPath,'utf8');
      const addedModels=plan.ids.filter(id=>!options.officialModels.includes(id));
      const next={...config,adapterOptions:{...options,officialModels:[...options.officialModels,...addedModels]}};
      validateManagedOptions(next.adapterOptions);
      if(addedModels.length){
       await atomicWrite(configPath+'.official-models-backup-'+randomUUID()+'.json',before,true);
       await checkConfig();await unchangedState();if(await readFile(configPath,'utf8')!==before)fail('OM_STALE');
       await atomicWrite(configPath,JSON.stringify(next,null,2)+'\n');
       config=next;options=validateManagedOptions(next.adapterOptions);configIdentity=JSON.stringify(next);await checkConfig();
      }
      officialPlan=null;
      return {ok:true,status:addedModels.length?'saved':'unchanged',addedModels,backupSaved:addedModels.length>0,sendsRequest:false,requiresServiceStart:true};
    });
    return {...result,catalog:await syncCatalog()};
   }
   if(request?.operation==='official-proxy-read'&&exact(request,['operation'])){
    return {ok:true,proxyUrl:options.officialProxyUrl,revision:digest(configIdentity),scope:'on-disk-configuration-only'};
   }
   if(request?.operation==='official-proxy-save'&&exact(request,['operation','proxyUrl','revision','confirmed'])){
    if(allowServiceControl!==true)fail('DESKTOP_SERVICE_DISABLED');
    if(request.confirmed!==true)fail('OP_CONFIRM');
    if(request.proxyUrl!==null&&(typeof request.proxyUrl!=='string'||request.proxyUrl!==request.proxyUrl.trim()||/[\x00-\x20\x7f]/.test(request.proxyUrl)))fail('OP_URL');
    try{validateManagedOptions({...options,officialProxyUrl:request.proxyUrl});}catch{fail('OP_URL');}
    return await withFileLocks([configPath+'.desktop-control.lock'],async()=>{
     await checkConfig();
     if(request.revision!==digest(configIdentity))fail('OP_STALE');
     const stopped=()=>{const s=routerStatus(configPath);if(!['not_started','stopped'].includes(s.state)||s.lockPresent||s.active||s.stopRequested)fail('OP_STOP_REQUIRED');};
     stopped();
     if(request.proxyUrl===options.officialProxyUrl)return {ok:true,status:'unchanged',backupSaved:false,sendsRequest:false};
     const before=await readFile(configPath,'utf8');
     await checkConfig();
     const next={...config,adapterOptions:{...options,officialProxyUrl:request.proxyUrl}};
     await atomicWrite(configPath+'.official-proxy-backup-'+randomUUID()+'.json',before,true);
     await checkConfig();stopped();
     if(await readFile(configPath,'utf8')!==before)fail('OP_STALE');
     await atomicWrite(configPath,JSON.stringify(next,null,2)+'\n');
     // Adopt only this operation's expected field edit. External changes remain blocked.
     config=next;options=validateManagedOptions(next.adapterOptions);configIdentity=JSON.stringify(next);
     await checkConfig();
     return {ok:true,status:'saved',backupSaved:true,sendsRequest:false,requiresServiceStart:true};
    });
   }
   if(request?.operation==='catalog-sync'&&exact(request,['operation','confirmed'])){
    if(request.confirmed!==true)fail('DESKTOP_CONFIG_REQUEST');
    return {ok:true,catalog:await syncCatalog()};
   }
   if(request?.operation==='worker-prepare'&&exact(request,['operation','input'])){
    if(!workerJobs)fail('DW_DISABLED');return {ok:true,...await workerJobs.prepare(request.input)};
   }
   if(request?.operation==='worker-start'&&exact(request,['operation','operationId','confirmed'])){
    if(!workerJobs)fail('DW_DISABLED');return {ok:true,...await workerJobs.start({operationId:request.operationId,confirmed:request.confirmed})};
   }
   if(request?.operation==='worker-status'&&exact(request,['operation','operationId'])){
    if(!workerJobs)fail('DW_DISABLED');return {ok:true,...await workerJobs.status(request.operationId)};
   }
   if(request?.operation==='codex-prepare'&&exact(request,['operation'])){
    codexSetup=null;
    if(allowServiceControl!==true)fail('DESKTOP_CODEX_DISABLED');
    if(!config.port)fail('DESKTOP_CODEX_PORT_REQUIRED');
    const target=await codexIntegration.discover(),plan=await planDesktopProvider(join(target.codexHome,'config.toml'),config.port);
    codexSetup={target,plan,id:randomUUID()};
    return {ok:true,receiptId:codexSetup.id,status:plan.status,...target};
   }
   if(['codex-apply','codex-launch'].includes(request?.operation)&&exact(request,['operation','receiptId'])){
    if(allowServiceControl!==true)fail('DESKTOP_CODEX_DISABLED');
    if(!codexSetup||request.receiptId!==codexSetup.id)fail('DESKTOP_CODEX_STALE');
    const setup=codexSetup,target=await codexIntegration.discover();
    await checkConfig();
    if(target.codexHome!==setup.target.codexHome||target.desktopExecutable!==setup.target.desktopExecutable)fail('DESKTOP_CODEX_STALE');
    const path=join(target.codexHome,'config.toml');
    if(request.operation==='codex-apply'){
     const result=await applyDesktopProvider(path,setup.plan);
     setup.plan=await planDesktopProvider(path,config.port);
     return {ok:true,status:result.status};
    }
    const current=await planDesktopProvider(path,config.port);
    if(current.status!=='already-installed'||current.beforeSha256!==setup.plan.beforeSha256)fail('DESKTOP_CODEX_STALE');
    codexSetup=null; // A launch is never automatically repeated from this receipt.
    return {ok:true,...await codexIntegration.launch({routerConfigPath:configPath,...target})};
   }
   if(request?.operation==='router-status'&&exact(request,['operation'])){
    return desktopServiceSnapshot(configPath);
   }
   if(['router-start','router-stop'].includes(request?.operation)&&exact(request,['operation'])){
    if(allowServiceControl!==true)fail('DESKTOP_SERVICE_DISABLED');
    if(request.operation==='router-start'&&bundledRuntimeRoot){
     await upgradeRuntime();
     if(runtimeUpgrade.status==='blocked')fail(runtimeUpgrade.code);
     if(runtimeUpgrade.status==='pending-stop')fail('DU_STOP_REQUIRED');
    }
    if(request.operation==='router-start'&&config.port===0){
     let endpoint;
     try{endpoint=await prepareDesktopEndpoint(configPath,{expectedConfigIdentity:configIdentity});}
     catch(e){if(e.message==='DE_SERVICE_ACTIVE')fail('DESKTOP_SERVICE_NOT_STARTABLE');if(e.message==='DE_REGISTRY_INVALID')fail('ROUTER_REGISTRY_INVALID');throw e;}
     // Adopt only our expected port edit, never arbitrary disk configuration.
     config={...config,port:endpoint.port,adapterOptions:{...config.adapterOptions,port:endpoint.port}};
     options=validateManagedOptions(config.adapterOptions);configIdentity=JSON.stringify(config);
     await checkConfig();
    }
    if(request.operation==='router-start'&&options.ingressCredentialRef==='desktop-unconfigured'&&['not_started','stopped'].includes(desktopServiceSnapshot(configPath).state)){
     try{await prepareDesktopIngress(configPath,{expectedConfigIdentity:configIdentity});}
     catch(e){if(e.message==='DI_SERVICE_ACTIVE')fail('DESKTOP_SERVICE_NOT_STARTABLE');throw e;}
     await checkConfig();
    }
    return await controlDesktopService(configPath,request.operation,checkConfig);
   }
   if(request?.operation==='gateway-models'&&exact(request,['operation','input']))return await syncGatewayModels(request.input);
   if(request?.operation==='gateway-activate'&&exact(request,['operation','providerId','revision','confirmed'])){
    if(request.confirmed!==true||typeof request.providerId!=='string'||typeof request.revision!=='string')fail('DESKTOP_CONFIG_REQUEST');
    return await withFileLocks([configPath+'.desktop-control.lock',modelPath+'.model-update.lock',bindingsPath+'.lock'],async()=>{
     await checkConfig();const {registry,revision}=await snapshot();if(revision!==request.revision)fail('DESKTOP_CONFIG_STALE');
     if(!registry.providers.some(p=>p.id===request.providerId))fail('GMG_MISSING');
     // Never write the new format into a service pinned to an older adapter.
     const expected=digest(await readFile(new URL('./managed-model-router.mjs',import.meta.url)));
     if(config.adapterSha256!==expected||digest(await readFile(config.adapterPath))!==expected)fail('AG_RUNTIME_UPDATE_REQUIRED');
     if(!usesActiveGateway(registry))requireStopped();
     if(registry.activeProviderId===request.providerId)return {ok:true,status:'already-active',sendsRequest:false};
     const before=await readFile(modelPath);if(digest(before)!==revision)fail('DESKTOP_CONFIG_STALE');
     const candidate=structuredClone(registry);candidate.activeProviderId=request.providerId;candidate.generation++;
     if(planModelRegistryUpdate(registry,candidate,JSON.parse(await readFile(bindingsPath))).status!=='compatible')fail('MR_STORE_BLOCKED');
     await atomicWrite(modelPath+'.active-gateway-backup-'+randomUUID()+'.json',before.toString('utf8'),true);
     await checkConfig();if(digest(await readFile(modelPath))!==revision)fail('DESKTOP_CONFIG_STALE');
     await atomicWrite(modelPath,JSON.stringify(candidate,null,2)+'\n');
     return {ok:true,status:'active',activeProviderId:request.providerId,backupSaved:true,sendsRequest:false};
    });
   }
   if(request?.operation==='model-verify'&&exact(request,['operation','modelId','revision','confirmed'])){
    const {operation,...input}=request;
    return await verifyDesktopModel({modelRegistryPath:modelPath,bindingsPath,credentialConfigPath:options.credentialConfigPath,evidenceRoot:root,checkConfig},input);
   }
   if(request?.operation==='gateway-prepare'&&exact(request,['operation','input']))return await (await gateway()).prepare(request.input);
   if(request?.operation==='gateway-create-key'&&exact(request,['operation','receipt','secret']))return await (await gateway()).createKey(request.receipt,request.secret);
   if(request?.operation==='gateway-inspect'&&exact(request,['operation','receipt']))return await (await gateway()).inspect(request.receipt);
   if(request?.operation==='gateway-apply'&&exact(request,['operation','receipt']))return await (await gateway()).apply(request.receipt);
   if(['gateway-rename','gateway-delete'].includes(request?.operation)){
    const removing=request.operation==='gateway-delete';
    if(!exact(request,['operation','providerId','revision',removing?'confirmed':'displayName'])||typeof request.providerId!=='string'||typeof request.revision!=='string')fail('DESKTOP_CONFIG_REQUEST');
    if(removing&&request.confirmed!==true)fail('GMG_CONFIRM');
    if(!removing&&(typeof request.displayName!=='string'||!request.displayName.trim()||request.displayName.trim().length>80||/[\x00-\x1f\x7f]/.test(request.displayName)))fail('GMG_NAME');
    return await withFileLocks([configPath+'.desktop-control.lock',modelPath+'.model-update.lock',bindingsPath+'.lock'],async()=>{
     await checkConfig();const {registry,revision}=await snapshot();if(revision!==request.revision)fail('DESKTOP_CONFIG_STALE');
     const provider=registry.providers.find(p=>p.id===request.providerId);if(!provider)fail('GMG_MISSING');
     const workers=await gatewayWorkers(registry,provider.id);
     if(removing){if(usesActiveGateway(registry)&&registry.activeProviderId===provider.id)fail('AG_ACTIVE_DELETE');if(workers.length)fail('GMG_BOUND');requireStopped();}
     else if(registry.providers.some(p=>p.id!==provider.id&&(p.displayName??p.id)===request.displayName.trim()))fail('GMG_NAME');
     const before=await readFile(modelPath);if(digest(before)!==revision)fail('DESKTOP_CONFIG_STALE');
     const candidate=structuredClone(registry);candidate.generation++;
     if(removing){candidate.providers=candidate.providers.filter(p=>p.id!==provider.id);candidate.models=candidate.models.filter(m=>m.providerId!==provider.id);}
     else candidate.providers.find(p=>p.id===provider.id).displayName=request.displayName.trim();
     validateModelRegistry(candidate);
     const backup=modelPath+'.gateway-backup-'+revision+'.json';
     try{await atomicWrite(backup,before.toString('utf8'),true);}catch(e){if(e.code!=='EEXIST')throw e;if(!(await readFile(backup)).equals(before))fail('GMG_BACKUP');}
     if(digest(await readFile(modelPath))!==revision)fail('DESKTOP_CONFIG_STALE');
     if(removing)requireStopped();
     await atomicWrite(modelPath,JSON.stringify(candidate,null,2)+'\n');
     return {ok:true,status:removing?'deleted':'renamed',backupSaved:true,credentialsRetained:true,runtimeActivated:false};
    });
   }
   if(request?.operation==='read'&&exact(request,['operation'])){
    const {registry,revision}=await snapshot();
    const bindingBytes=await readFile(bindingsPath),workers=JSON.parse(bindingBytes);validateModelBindings(workers,registry.models,usesActiveGateway(registry));
    return {ok:true,revision,...(runtimeUpgrade?{runtimeUpgrade}:{}),routingMode:usesActiveGateway(registry)?'single-active-gateway':'legacy',activeProviderId:registry.activeProviderId??null,workers,generation:registry.generation,scope:'on-disk-configuration-only',serviceControl:allowServiceControl===true,workerCreation:workerJobs!==null,
     providers:await Promise.all(registry.providers.map(async p=>({id:p.id,responsesUrl:p.responsesUrl,...(p.displayName?{displayName:p.displayName}:{}),workers:await gatewayWorkers(registry,p.id)}))),
     models:registry.models.map(m=>({modelId:m.modelId,providerId:m.providerId,selectionId:m.selectionId,displayName:m.displayName,upstreamModel:m.upstreamModel,enabled:m.enabled!==false,readiness:m.readiness}))};
   }
   if(request?.operation==='save-selection'&&exact(request,['operation','revision','changes'])){
    if(typeof request.revision!=='string'||!/^[a-f0-9]{64}$/.test(request.revision)||!Array.isArray(request.changes)||!request.changes.length)fail('DESKTOP_CONFIG_REQUEST');
    const ids=new Set();
    for(const c of request.changes){
     if(!exact(c,['modelId','enabled'])||typeof c.modelId!=='string'||typeof c.enabled!=='boolean'||ids.has(c.modelId))fail('DESKTOP_CONFIG_REQUEST');
     ids.add(c.modelId);
    }
    return await withFileLocks([modelPath+'.model-update.lock',bindingsPath+'.lock'],async()=>{
     await checkConfig();
     const {registry,revision}=await snapshot();if(revision!==request.revision)fail('DESKTOP_CONFIG_STALE');
     if(request.changes.some(c=>!registry.models.some(m=>m.modelId===c.modelId)))fail('DESKTOP_CONFIG_REQUEST');
     const candidate=structuredClone(registry);candidate.generation++;
     for(const c of request.changes)candidate.models.find(m=>m.modelId===c.modelId).enabled=c.enabled;
     const plan=planModelRegistryUpdate(registry,candidate,JSON.parse(await readFile(bindingsPath,'utf8')));
     const dir=await mkdtemp(join(root,'selection-')),candidatePath=join(dir,'candidate.json'),draftPath=join(dir,'draft.json');
     await writeFile(candidatePath,JSON.stringify(candidate),{flag:'wx',mode:0o600});
     const saved=await saveModelDraft(modelPath,candidatePath,draftPath),draftId=randomUUID();
     drafts.set(draftId,{path:draftPath,hash:saved.draftSha256});
     return {ok:true,status:'saved',draftId,plan,runtimeActivated:false,sendsRequest:false};
    });
   }
   if(request?.operation==='apply'&&exact(request,['operation','draftId'])){
    if(typeof request.draftId!=='string'||!drafts.has(request.draftId))fail('DESKTOP_CONFIG_DRAFT');
    const draft=drafts.get(request.draftId);
    const result=await applyModelDraft(modelPath,draft.path,draft.hash,bindingsPath);
    drafts.delete(request.draftId);return {ok:true,...result,catalog:await syncCatalog()};
   }
   fail('DESKTOP_CONFIG_REQUEST');
  }catch(error){if(request?.operation?.startsWith?.('codex-'))codexSetup=null;return {ok:false,code:error.code==='EEXIST'?'MR_STORE_LOCKED':safeCodes.has(error.message)?error.message:'DESKTOP_CONFIG_UNAVAILABLE'};}
 }});
}
