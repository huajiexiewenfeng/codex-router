import { readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { ModelRoutingError, fail } from './model-registry.mjs';
import { planModelRegistryUpdate } from './model-registry-update.mjs';
import { atomicWrite } from './store.mjs';
import { withFileLocks } from './registry-projection.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const validHash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
function parse(bytes){try{return JSON.parse(bytes.toString('utf8'));}catch{fail('MR_STORE_INPUT');}}
async function safeOperation(operation){
 try{return await operation();}catch(error){if(error instanceof ModelRoutingError)throw error;fail('MR_STORE_IO');}
}

export async function saveModelDraft(currentPath,candidatePath,draftPath){
 return safeOperation(async()=>{
  const target=await realpath(currentPath),bytes=await readFile(target),registry=parse(await readFile(candidatePath));
  const plan=planModelRegistryUpdate(parse(bytes),registry);
  const envelope={schemaVersion:1,target,baseSha256:hash(bytes),registry};
  const content=JSON.stringify(envelope,null,2)+'\n';
  try{await atomicWrite(draftPath,content,true);}catch(error){if(error.code==='EEXIST')fail('MR_STORE_EXISTS');throw error;}
  return {status:'saved',draftSha256:hash(content),plan,runtimeActivated:false,sendsRequest:false,loadsCredential:false};
 });
}

export async function applyModelDraft(currentPath,draftPath,expectedDraftSha256,bindingsPath){
 return safeOperation(async()=>{
  if(!validHash(expectedDraftSha256))fail('MR_STORE_DRAFT_HASH');
  const target=await realpath(currentPath);
  const bindingTarget=bindingsPath===undefined?undefined:await realpath(bindingsPath);
  if(bindingTarget===target)fail('MR_STORE_TARGET');
  try{return await withFileLocks([target+'.model-update.lock',...(bindingTarget?[bindingTarget+'.lock']:[])],async()=>{
   const draftBytes=await readFile(draftPath);
   if(hash(draftBytes)!==expectedDraftSha256)fail('MR_STORE_DRAFT_CHANGED');
   const draft=parse(draftBytes);
   if(!draft||Array.isArray(draft)||typeof draft!=='object'||Object.keys(draft).length!==4||draft.schemaVersion!==1||typeof draft.target!=='string'||!validHash(draft.baseSha256)||!Object.hasOwn(draft,'registry'))fail('MR_STORE_DRAFT');
   if(draft.target!==target)fail('MR_STORE_TARGET');
   const currentBytes=await readFile(target);
   if(hash(currentBytes)!==draft.baseSha256)fail('MR_STORE_STALE');
   const bindings=bindingTarget===undefined?undefined:parse(await readFile(bindingTarget));
   const plan=planModelRegistryUpdate(parse(currentBytes),draft.registry,bindings);
   if(plan.status!=='compatible')fail('MR_STORE_BLOCKED');
   await atomicWrite(target,JSON.stringify(draft.registry,null,2)+'\n');
   return {status:'applied',generation:draft.registry.generation,runtimeActivated:false,sendsRequest:false,loadsCredential:false};
  });}catch(error){if(error.code==='EEXIST')fail('MR_STORE_LOCKED');throw error;}
 });
}
