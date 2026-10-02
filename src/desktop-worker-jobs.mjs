import {open,readFile,realpath,stat} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {planWorkerCreation,createWorkerCreation,readWorkerCreationReceipt} from './worker-creation.mjs';

const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const fail=code=>{throw Error(code);};
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===keys.sort().join(',');
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function exclusive(path,value){const f=await open(path,'wx',0o600);try{await f.writeFile(JSON.stringify(value)+'\n');await f.sync();}finally{await f.close();}}
async function exists(path){try{await stat(path);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
const receiptStates=new Set(['starting','created','initialization-requested','needs-reconciliation','initialized-awaiting-desktop-confirmation']);

// Host-only controller. makeRequest owns executable/config/credentials scope;
// renderer input can never override those fields. A durable intent is never replayed.
export async function createDesktopWorkerJobs({jobRoot,makeRequest},{plan=planWorkerCreation,create=createWorkerCreation,workerDeps={}}={}){
 if(typeof makeRequest!=='function'||!isAbsolute(jobRoot))fail('DW_HOST');
 const root=await realpath(jobRoot);if(!(await stat(root)).isDirectory())fail('DW_HOST');
 const active=new Set(),pending=new Map();
 const path=(id,suffix)=>{if(!uuid.test(id??''))fail('DW_INPUT');return join(root,id+suffix);};
 async function load(id){try{const data=JSON.parse(await readFile(path(id,'.job.json'),'utf8'));if(data.operationId!==id||data.schemaVersion!==1)fail('DW_RECORD');return data;}catch(e){if(e.code==='ENOENT')fail('DW_UNKNOWN');if(e.message==='DW_INPUT')throw e;fail('DW_RECORD');}}
 async function requestFor(input,id){
  const r=await makeRequest({...input,operationId:id});
  if(r.operationId!==id||r.mode!=='router'||r.hostId!=='local'||await realpath(r.receiptDirectory)!==root||r.initialization?.authorized!==true)fail('DW_HOST');
  return r;
 }
 async function status(id){
  await load(id);
  if(await exists(path(id,'.json'))){
   let r;try{r=await readWorkerCreationReceipt(path(id,'.json'));}catch{fail('DW_RECORD');}
   if(r.operationId!==id||r.mode!=='router'||!receiptStates.has(r.status)||r.threadId!==null&&!uuid.test(r.threadId??''))fail('DW_RECORD');
   return {operationId:id,status:r.status,threadId:r.threadId??null,persistenceVerified:r.persistenceVerified===true,desktopVerified:false,sendsModelRequest:r.sendsModelRequest===true,active:active.has(id)};
  }
  const started=await exists(path(id,'.started.json'));
  return {operationId:id,status:active.has(id)?'creation-in-progress':started?'needs-reconciliation':'prepared',threadId:null,desktopVerified:false,sendsModelRequest:started?'unknown':false};
 }
 return Object.freeze({status,async wait(id){await load(id);await pending.get(id);return status(id);},async prepare(input){
  if(!exact(input,['cwd','title','model'])||typeof input.cwd!=='string'||!isAbsolute(input.cwd)||typeof input.title!=='string'||!input.title.trim()||input.title.length>120||/[\x00-\x1f]/.test(input.title)||!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(input.model??''))fail('DW_INPUT');
  const selected={...input,cwd:await realpath(input.cwd),title:input.title.trim()};
  if(!(await stat(selected.cwd)).isDirectory())fail('DW_INPUT');
  const id=randomUUID(),r=await requestFor(selected,id);
  let p;try{p=await plan(r,workerDeps);}catch{fail('DW_PREPARE_FAILED');}
  if(p.status!=='ready_to_create')fail('DW_NOT_READY');
  await exclusive(path(id,'.job.json'),{schemaVersion:1,operationId:id,input:selected,requestHash:hash(r)});
  return {operationId:id,status:'prepared',sendsModelRequest:false,initializationOnStart:true};
 },async start(input){
  if(!exact(input,['operationId','confirmed'])||input.confirmed!==true)fail('DW_CONFIRM');
  const id=input.operationId,record=await load(id),before=await status(id);
  if(before.status!=='prepared')return before;
  const r=await requestFor(record.input,id);if(hash(r)!==record.requestHash)fail('DW_CHANGED');
  let p;try{p=await plan(r,workerDeps);}catch{fail('DW_PREPARE_FAILED');}if(p.status!=='ready_to_create')fail('DW_NOT_READY');
  try{await exclusive(path(id,'.started.json'),{operationId:id,startedAt:new Date().toISOString()});}
  catch(e){if(e.code==='EEXIST')return status(id);fail('DW_STORAGE');}
  active.add(id);
  // All failures remain inspectable through the real receipt, or the durable
  // intent if creation did not reach receipt persistence. Never emit raw errors.
  pending.set(id,Promise.resolve().then(()=>create(r,workerDeps)).catch(()=>{}).finally(()=>{active.delete(id);pending.delete(id);}));
  return {operationId:id,status:'creation-in-progress',threadId:null,desktopVerified:false,sendsModelRequest:'unknown'};
 }});
}
