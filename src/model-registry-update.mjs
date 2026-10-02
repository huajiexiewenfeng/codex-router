import { isDeepStrictEqual } from 'node:util';
import { fail, validateModelRegistry, usesActiveGateway, safeModelId } from './model-registry.mjs';

// Read-only comparison, not an authorization or an apply token. The eventual
// writer must reread the current generation under its own concurrency control.
export function validateModelBindings(bindings,models,global=false){
 if(bindings!==undefined){
  if(!Array.isArray(bindings))fail('MR_UPDATE_BINDINGS');
  const seen=new Set(),ids=new Set(models.map(m=>m.selectionId));
  for(const b of bindings){
   if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).sort().join(',')!=='allowedModels,hostId,threadId'||b.hostId!=='local'||typeof b.threadId!=='string'||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(b.threadId)||seen.has(b.threadId)||!Array.isArray(b.allowedModels)||(!global&&!b.allowedModels.length)||new Set(b.allowedModels).size!==b.allowedModels.length||b.allowedModels.some(id=>global?!safeModelId(id):!ids.has(id)))fail('MR_UPDATE_BINDINGS');
   seen.add(b.threadId);
  }
 }
}
export function planModelRegistryUpdate(current, draft, bindings){
 const before=validateModelRegistry(current),after=validateModelRegistry(draft);
 if(before.schemaVersion!==2||after.schemaVersion!==2)fail('MR_UPDATE_SCHEMA');
 if(after.generation<=before.generation)fail('MR_UPDATE_GENERATION');
 const global=usesActiveGateway(after);
 validateModelBindings(bindings,[...before.models,...after.models],global);
 const issues=[];
 if(usesActiveGateway(before)&&!global)issues.push({code:'MR_UPDATE_ROUTING_MODE'});
 if(before.suffix!==after.suffix)issues.push({code:'MR_UPDATE_SUFFIX'});
 const oldProviders=new Map(before.providers.map(p=>[p.id,p]));
 const providers=new Map(after.providers.map(p=>[p.id,p]));
 for(const previous of before.providers){
  const next=providers.get(previous.id);
  if(!next){issues.push({code:'MR_UPDATE_PROVIDER_REMOVED',providerId:previous.id});continue;}
  const fields=['kind','wireApi','responsesUrl','credentialRef','allowHttp'].filter(field=>previous[field]!==next[field]);
  if(fields.length)issues.push({code:'MR_UPDATE_PROVIDER_CHANGED',providerId:previous.id,fields});
 }
 const oldModels=new Map(before.models.map(m=>[m.modelId,m]));
 const models=new Map(after.models.map(m=>[m.modelId,m]));
 const aliasKey=m=>global?JSON.stringify([m.providerId,m.selectionId]):m.selectionId;
 const aliases=new Map(after.models.map(m=>[aliasKey(m),m]));
 for(const previous of before.models){
  const next=models.get(previous.modelId),alias=aliases.get(aliasKey(previous));
  if(alias&&alias.modelId!==previous.modelId)issues.push({code:'MR_UPDATE_ALIAS_REUSED',modelId:previous.modelId});
  if(!next){issues.push({code:'MR_UPDATE_MODEL_REMOVED',modelId:previous.modelId});continue;}
  if(!global&&previous.enabled!==false&&next.enabled===false){
   if(bindings===undefined)issues.push({code:'MR_UPDATE_DISABLE_REQUIRES_REVIEW',modelId:previous.modelId});
   else{
    const workers=bindings.filter(b=>b.allowedModels.includes(previous.selectionId)).map(({hostId,threadId})=>({hostId,threadId}));
    if(workers.length)issues.push({code:'MR_UPDATE_MODEL_BOUND',modelId:previous.modelId,selectionId:previous.selectionId,workers});
   }
  }
  const fields=['selectionId','providerId','upstreamModel'].filter(field=>previous[field]!==next[field]);
  if(fields.length)issues.push({code:'MR_UPDATE_MODEL_CHANGED',modelId:previous.modelId,fields});
 }
 return {
  status:issues.length?'blocked':'compatible',schemaVersion:2,
  fromGeneration:before.generation,toGeneration:after.generation,
  addedProviderIds:after.providers.filter(p=>!oldProviders.has(p.id)).map(p=>p.id),
  addedModelIds:after.models.filter(m=>!oldModels.has(m.modelId)).map(m=>m.modelId),
  removedModelIds:before.models.filter(m=>!models.has(m.modelId)).map(m=>m.modelId),
  changedModelIds:after.models.filter(m=>oldModels.has(m.modelId)&&!isDeepStrictEqual(m,oldModels.get(m.modelId))).map(m=>m.modelId),
  issues,applies:false,sendsRequest:false,loadsCredential:false,evidenceScope:'provided-snapshots-only'
 };
}
