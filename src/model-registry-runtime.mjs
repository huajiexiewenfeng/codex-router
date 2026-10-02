import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fail, validateModelRegistry } from './model-registry.mjs';
import { planModelRegistryUpdate } from './model-registry-update.mjs';
import { planModelRoute } from './model-route-plan.mjs';
import { planNativeModelRoute } from './native-model-route.mjs';

// Request-boundary consumer only. The adapter must retain the returned snapshot
// throughout dispatch/stream handling, and still own ingress authentication.
export function createModelRegistryRuntime(registryPath){
 if(typeof registryPath!=='string'||!registryPath.trim())fail('MR_RUNTIME_PATH');
 const path=resolve(registryPath);
 let active=null,digest=null,healthy=false,lastError=null;
 function load(bindings){
  try{
   let bytes;try{bytes=readFileSync(path);}catch{fail('MR_RUNTIME_READ');}
   const nextDigest=createHash('sha256').update(bytes).digest('hex');
   if(active&&nextDigest===digest){healthy=true;lastError=null;return active;}
   let parsed;try{parsed=JSON.parse(bytes.toString('utf8'));}catch{fail('MR_RUNTIME_INPUT');}
   const next=validateModelRegistry(parsed);
   if(next.schemaVersion!==2)fail('MR_RUNTIME_SCHEMA');
   if(active){
    if(next.generation<=active.generation)fail('MR_RUNTIME_GENERATION');
    if(planModelRegistryUpdate(active,next,bindings).status!=='compatible')fail('MR_RUNTIME_UPDATE_BLOCKED');
   }
   active=next;digest=nextDigest;healthy=true;lastError=null;return active;
  }catch(error){healthy=false;lastError=error.message;throw error;}
 }
 return Object.freeze({
  capture(request,bindings){
   const registry=load(bindings);
   // planModelRoute returns only scalar values; a shallow freeze is sufficient.
   return Object.freeze({...planModelRoute(registry,request,bindings),registrySha256:digest});
  },
  captureNative(identity,payload,bindings){
   const route=planNativeModelRoute(load(bindings),identity,payload,bindings);
   return Object.freeze({...route,inputModalities:Object.freeze(route.inputModalities),registrySha256:digest});
  },
  status(){return {healthy,generation:active?.generation??null,lastError,observation:'last-capture-only'};}
 });
}
