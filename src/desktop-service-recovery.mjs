// Host-only: configPath and OS probes are supplied by the trusted desktop host.
import {readFileSync,lstatSync,realpathSync,openSync,closeSync,writeFileSync,mkdirSync,renameSync,unlinkSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createServer} from 'node:net';
import {loadRouterConfig,atomicJson} from './router-service.mjs';
import {readRouterRegistry} from './router-registry.mjs';
import {readBudget} from './router-budget.mjs';
const fail=code=>{throw Error('ROUTER_RECOVERY_'+code);};
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const samePath=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
function snapshot(path,optional=false){
 try{
  const stat=lstatSync(path);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||!samePath(realpathSync(path),resolve(path)))fail('PATH_UNSAFE');
  const bytes=readFileSync(path);
  if(bytes.length>16*1024*1024)fail('FILE_TOO_LARGE');
  return {path,bytes,identity:[stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs,stat.birthtimeMs,createHash('sha256').update(bytes).digest('hex')].join(':')};
 }catch(e){if(optional&&e.code==='ENOENT'){
   if(!samePath(realpathSync(dirname(path)),resolve(dirname(path))))fail('PATH_UNSAFE');
   return {path,identity:null};
  }throw e;
 }
}
function unchanged(files){for(const f of files)if(snapshot(f.path,true).identity!==f.identity)fail('SNAPSHOT_CHANGED');}
function processAbsent(pid){try{process.kill(pid,0);return false;}catch(e){return e.code==='ESRCH';}}
function portFree(port){return new Promise(resolveResult=>{
 const server=createServer();server.once('error',()=>resolveResult(false));
 server.listen({host:'127.0.0.1',port,exclusive:true},()=>server.close(()=>resolveResult(true)));
});}
export function createDesktopServiceRecovery({configPath,now=Date.now,isProcessAbsent=processAbsent,isPortFree=portFree}){
 const fixedPath=resolve(configPath),plans=new Map();let recovering=false;
 async function inspect(){
  const files=[snapshot(fixedPath)],config=loadRouterConfig(fixedPath);
  if(!config.registryPath)fail('SHARED_ONLY');
  const base=config.registryPath;
  files.push(snapshot(base,true));
  files.push(snapshot(base+'.mutation.lock',true));if(files.at(-1).identity!==null)fail('REGISTRY_BUSY');
  const lock=snapshot(base+'.service.lock',true),control=snapshot(fixedPath+'.desktop-control.lock',true),saved=snapshot(base+'.status.json',true),stop=snapshot(base+'.stop.json',true);
  files.push(lock,control,saved,stop);
  const lockOwner=lock.bytes?.length?JSON.parse(lock.bytes):null,controlOwner=control.bytes?.length?JSON.parse(control.bytes):null;
  const maintenanceOwner=controlOwner?.kind==='official-models-sync'?controlOwner:lockOwner?.kind==='official-models-sync'?lockOwner:null;
  if(maintenanceOwner){
   const maintenanceLocks=[lock,control].filter(f=>f.identity!==null);
   for(const file of maintenanceLocks){
    const stat=lstatSync(file.path),owner=JSON.parse(file.bytes);
    if(Object.keys(owner).sort().join(',')!=='configPath,createdAt,kind,pid'||typeof owner.configPath!=='string'||
     !samePath(owner.configPath,realpathSync(fixedPath))||!Number.isSafeInteger(owner.pid)||owner.pid<=0||
     !Number.isSafeInteger(owner.createdAt)||owner.createdAt<=0||now()-Math.max(owner.createdAt,stat.birthtimeMs,stat.mtimeMs)<=60000||config.port<=0||
     ['configPath','createdAt','kind','pid'].some(key=>owner[key]!==maintenanceOwner[key]))fail('LOCK_OWNER_AMBIGUOUS');
   }
   if(saved.identity!==null){
    const old=JSON.parse(saved.bytes);
    if(old.state!=='stopped'||!uuid.test(old.runId)||!Number.isSafeInteger(old.pid)||old.pid<=0||
     !Number.isSafeInteger(old.updatedAt)||old.updatedAt>maintenanceOwner.createdAt)fail('STATUS_AMBIGUOUS');
    if(await isProcessAbsent(old.pid)!==true)fail('PROCESS_NOT_ABSENT');
   }
   if(await isProcessAbsent(maintenanceOwner.pid)!==true)fail('PROCESS_NOT_ABSENT');
   if(await isPortFree(config.port)!==true)fail('PORT_NOT_FREE');
   unchanged(files);
   return {files,base,lock,control,saved,stop,maintenanceLocks,budgetLocks:[],kind:'official-models-sync',status:{runId:null,pid:maintenanceOwner.pid}};
  }
  if(control.identity!==null)fail('LOCK_OWNER_AMBIGUOUS');
  const registry=readRouterRegistry(base);
  if(saved.identity===null)fail('STATUS_AMBIGUOUS');
  const status=JSON.parse(saved.bytes);
  if(!uuid.test(status.runId)||!Number.isSafeInteger(status.pid)||status.pid<=0||!Number.isSafeInteger(status.updatedAt)||
   now()-status.updatedAt<=60000||!['running','stopped'].includes(status.state)||!Number.isInteger(status.port)||status.port<=0||status.port>65535||
   config.port!==0&&config.port!==status.port)fail('STATUS_AMBIGUOUS');
  if(lock.identity===null){
   if(status.state!=='running')fail('STATUS_AMBIGUOUS');
  }else if(lock.bytes.length===0){
   // Legacy shared services own an empty exclusive lock. Reject locks newer than their heartbeat.
   const stat=lstatSync(lock.path);
   if(stat.birthtimeMs>status.updatedAt||stat.mtimeMs>status.updatedAt)fail('LOCK_OWNER_AMBIGUOUS');
  }else{
   const owner=JSON.parse(lock.bytes);
   if(Object.keys(owner).sort().join(',')!=='pid,runId'||owner.pid!==status.pid||owner.runId!==status.runId)fail('LOCK_OWNER_AMBIGUOUS');
  }
  let preserveStop=false;
  if(stop.identity!==null){const request=JSON.parse(stop.bytes);
   if(Object.keys(request).join(',')!=='runId'||!uuid.test(request.runId))fail('STOP_OWNER_AMBIGUOUS');
   if(request.runId!==status.runId){if(lock.identity!==null)fail('STOP_OWNER_AMBIGUOUS');preserveStop=true;}
  }
  const budgetLocks=[];
  for(const binding of registry.bindings){
   files.push(snapshot(binding.budgetPath));if(readBudget(binding.budgetPath).threadId!==binding.threadId)fail('BUDGET_OWNER_AMBIGUOUS');
   const budgetLock=snapshot(binding.budgetPath+'.lock',true);files.push(budgetLock);
   if(budgetLock.identity!==null){const owner=JSON.parse(budgetLock.bytes);
    if(Object.keys(owner).join(',')!=='pid'||owner.pid!==status.pid)fail('BUDGET_OWNER_AMBIGUOUS');budgetLocks.push(budgetLock);
   }
  }
  if(await isProcessAbsent(status.pid)!==true)fail('PROCESS_NOT_ABSENT');
  if(await isPortFree(status.port)!==true)fail('PORT_NOT_FREE');
  unchanged(files);return {files,base,status,lock,control,saved,stop,budgetLocks,preserveStop};
 }
 async function safeInspect(){try{return await inspect();}catch(e){if(e.message?.startsWith('ROUTER_RECOVERY_'))throw e;fail('CHECK_FAILED');}}
 return {
  async prepare(){
   if(recovering)fail('BUSY');
   const plan=await safeInspect(),token=randomUUID();plans.clear();plans.set(token,plan);
   return {token,runId:plan.status.runId,pid:plan.status.pid,lockCount:plan.maintenanceLocks?.length??plan.budgetLocks.length+(plan.lock.identity===null?0:1),state:'recoverable',...(plan.kind?{kind:plan.kind}:{})};
  },
  async recover({token,confirmed}={}){
   if(confirmed!==true)fail('CONFIRMATION_REQUIRED');if(recovering)fail('BUSY');
   const prior=plans.get(token);if(!prior)fail('PLAN_EXPIRED');recovering=true;plans.delete(token);
   let guard,guardPath,controlGuard,serviceGuard;
   try{
    const current=await safeInspect();
    if(current.files.length!==prior.files.length||current.files.some((f,i)=>f.path!==prior.files[i].path||f.identity!==prior.files[i].identity))fail('SNAPSHOT_CHANGED');
    unchanged(prior.files);
    // Hold the common desktop writer guard ourselves when no dead maintenance owner already holds it.
    if(prior.control.identity===null)controlGuard=openSync(prior.control.path,'wx',0o600);
    guardPath=prior.base+'.mutation.lock';guard=openSync(guardPath,'wx',0o600);
    if(!prior.kind&&prior.lock.identity===null)serviceGuard=openSync(prior.lock.path,'wx',0o600);
    const protectedFiles=prior.files.filter(f=>f.path!==guardPath&&(controlGuard===undefined||f.path!==prior.control.path)&&(serviceGuard===undefined||f.path!==prior.lock.path));
    unchanged(protectedFiles);
    const backupPath=prior.base+'.recovery-'+randomUUID();mkdirSync(backupPath,{mode:0o700});
    // Preserve exact original bytes before any destructive change. No ledger/config rewrites.
    const originals=prior.kind==='official-models-sync'?prior.maintenanceLocks.map(f=>[f.path===prior.control.path?'desktop-control.lock':'service.lock',f]):[['status.json',prior.saved],...(prior.lock.identity!==null?[['service.lock',prior.lock]]:[]),...(prior.stop.identity!==null?[['stop.json',prior.stop]]:[]),...prior.budgetLocks.map((f,i)=>['budget-'+i+'.lock',f])];
    for(const [name,file] of originals)writeFileSync(join(backupPath,name),file.bytes,{flag:'wx',mode:0o600});
    writeFileSync(join(backupPath,'manifest.json'),JSON.stringify({runId:prior.status.runId,pid:prior.status.pid,files:originals.map(([name,f])=>({name,path:f.path,identity:f.identity}))}),{flag:'wx',mode:0o600});
    unchanged(protectedFiles);
    if(prior.kind==='official-models-sync'){
     let remaining=protectedFiles;
     for(const [name,file] of originals){
      unchanged(remaining);renameSync(file.path,join(backupPath,'removed-'+name));remaining=remaining.filter(f=>f.path!==file.path);
     }
     return {state:prior.saved.identity===null?'not_started':'stopped',runId:null,kind:prior.kind,backupPath,recoveredLocks:originals.length};
    }
    // Keep the exclusive service lock in place until metadata and budget locks are handled.
    // A failure leaves the lock held on disk for explicit inspection; never auto-start.
    let remaining=protectedFiles;
    for(const [i,file] of prior.budgetLocks.entries()){
     unchanged(remaining);renameSync(file.path,join(backupPath,'removed-budget-'+i+'.lock'));
     remaining=remaining.filter(f=>f.path!==file.path);
    }
    if(prior.stop.identity!==null&&!prior.preserveStop){unchanged(remaining);renameSync(prior.stop.path,join(backupPath,'removed-stop.json'));remaining=remaining.filter(f=>f.path!==prior.stop.path);}
    unchanged(remaining);
    atomicJson(prior.saved.path,{...prior.status,state:'stopped',active:false,stopRequested:false,updatedAt:now(),bindings:[]});
    unchanged(remaining.filter(f=>f.path!==prior.saved.path));
    if(prior.lock.identity!==null)renameSync(prior.lock.path,join(backupPath,'removed-service.lock'));
    return {state:'stopped',runId:prior.status.runId,backupPath,recoveredLocks:originals.filter(([name])=>name.endsWith('.lock')).length};
   }catch(e){if(e.message?.startsWith('ROUTER_RECOVERY_'))throw e;fail('FAILED');}
   finally{
    recovering=false;let releaseFailed=false;
    for(const [fd,path] of [[serviceGuard,prior.lock.path],[guard,guardPath],[controlGuard,prior.control.path]])if(fd!==undefined){try{closeSync(fd);unlinkSync(path);}catch{releaseFailed=true;}}
    if(releaseFailed)fail('GUARD_RELEASE_FAILED');
   }
  }
 };
}
