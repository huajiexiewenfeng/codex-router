import {readFile,open,unlink} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {validateModelRegistry,usesActiveGateway,currentGatewayModels} from './model-registry.mjs';
import {validateModelBindings} from './model-registry-update.mjs';
import {atomicWrite} from './store.mjs';
const fail=code=>{throw new Error(code);};
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export async function inspectWorkerModels(options,model){
 if(options.modelRegistryPath===undefined&&options.bindingsPath===undefined)return null;
 try{
  if(!isAbsolute(options.modelRegistryPath)||!isAbsolute(options.bindingsPath))throw Error();
  const registry=validateModelRegistry(JSON.parse(await readFile(options.modelRegistryPath,'utf8')));
  if(registry.schemaVersion!==2)throw Error();
  const bindings=JSON.parse(await readFile(options.bindingsPath,'utf8')),ids=new Set();
  const global=usesActiveGateway(registry);
  if(global)validateModelBindings(bindings,registry.models,true);
  if(!Array.isArray(bindings))throw Error();
  for(const b of global?[]:bindings){
   if(!b||Object.keys(b).sort().join(',')!=='allowedModels,hostId,threadId'||b.hostId!=='local'||!uuid.test(b.threadId)||ids.has(b.threadId)||!Array.isArray(b.allowedModels)||!b.allowedModels.length||new Set(b.allowedModels).size!==b.allowedModels.length||b.allowedModels.some(id=>!registry.models.some(m=>m.selectionId===id)))throw Error();
   ids.add(b.threadId);
  }
  const allowedModels=currentGatewayModels(registry).filter(m=>m.enabled!==false&&(global||m.readiness==='verified')).map(m=>m.selectionId);
  if(model.endsWith('_self')?!allowedModels.includes(model):!options.officialModels?.includes(model))fail('WORKER_MODEL_UNAVAILABLE');
  if(!global&&!allowedModels.length)throw Error();
  return {bindings,allowedModels,registry};
 }catch(error){if(error.message==='WORKER_MODEL_UNAVAILABLE')throw error;fail('WORKER_MODEL_BINDING_INVALID');}
}
export async function bindWorkerModels(options,model,threadId){
 if(options.modelRegistryPath===undefined&&options.bindingsPath===undefined)return;
 let lock;
 try{
  if(!uuid.test(threadId))fail('WORKER_MODEL_BINDING_INVALID');
  lock=await open(options.bindingsPath+'.lock','wx',0o600);
  const {bindings,allowedModels,registry}=await inspectWorkerModels(options,model);
  if(bindings.some(b=>b.threadId===threadId))fail('WORKER_MODEL_BINDING_CONFLICT');
  await atomicWrite(options.bindingsPath,JSON.stringify([...bindings,{hostId:'local',threadId,allowedModels:usesActiveGateway(registry)?[]:allowedModels}],null,2)+'\n');
 }catch(error){if(error.code==='EEXIST')fail('WORKER_MODEL_BINDING_LOCKED');if(error.message?.startsWith('WORKER_'))throw error;fail('WORKER_MODEL_BINDING_INVALID');}
 finally{if(lock){await lock.close();await unlink(options.bindingsPath+'.lock');}}
}
