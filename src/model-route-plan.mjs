import { fail, safeModelId, validateModelRegistry, usesActiveGateway, currentGatewayModels } from './model-registry.mjs';
import {validateModelBindings} from './model-registry-update.mjs';

const requestFields=['hostId','threadId','turnId','selectionId','historyMode','inputModalities','usesTools','reasoningEffort','estimatedInputTokens','maxOutputTokens'];
const bindingFields=['hostId','threadId','allowedModels'];
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function object(value){return value!==null&&typeof value==='object'&&!Array.isArray(value);}
function exact(value,fields){return object(value)&&Object.keys(value).length===fields.length&&Object.keys(value).every(field=>fields.includes(field));}
function inputs(value){return Array.isArray(value)&&value.length>0&&value.every(item=>typeof item==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(item))&&new Set(value).size===value.length;}
function validIdentity(hostId,threadId){return hostId==='local'&&typeof threadId==='string'&&uuid.test(threadId);}

export function planModelRoute(registry,request,bindings){
 const validated=validateModelRegistry(registry);
 if(!exact(request,requestFields)||!validIdentity(request.hostId,request.threadId)||typeof request.turnId!=='string'||!uuid.test(request.turnId)||!safeModelId(request.selectionId)||request.historyMode!=='explicit-portable'||!inputs(request.inputModalities)||typeof request.usesTools!=='boolean'||typeof request.reasoningEffort!=='string'||!Number.isSafeInteger(request.estimatedInputTokens)||request.estimatedInputTokens<0||!Number.isSafeInteger(request.maxOutputTokens)||request.maxOutputTokens<=0)fail('MR_ROUTE_REQUEST');
 if(!Array.isArray(bindings))fail('MR_ROUTE_BINDING');
 const global=usesActiveGateway(validated);
 if(global){try{validateModelBindings(bindings,validated.models,true);}catch{fail('MR_ROUTE_BINDING');}}
 const bindingKeys=new Set();
 for(const binding of global?[]:bindings){
  if(!exact(binding,bindingFields)||!validIdentity(binding.hostId,binding.threadId)||!Array.isArray(binding.allowedModels)||binding.allowedModels.length===0||!binding.allowedModels.every(safeModelId)||new Set(binding.allowedModels).size!==binding.allowedModels.length)fail('MR_ROUTE_BINDING');
  const key=`${binding.hostId}:${binding.threadId}`;if(bindingKeys.has(key))fail('MR_ROUTE_BINDING');bindingKeys.add(key);
  for(const selectionId of binding.allowedModels)if(!validated.models.some(model=>model.selectionId===selectionId))fail('MR_ROUTE_BINDING');
 }
 if(global&&validated.activeProviderId===null)fail('MR_ACTIVE_PROVIDER_REQUIRED');
 const model=currentGatewayModels(validated).find(item=>item.selectionId===request.selectionId);
 if(!model)fail('MR_ROUTE_MODEL');
 if(model.enabled===false)fail('MR_ROUTE_DISABLED');
 if(!global&&model.readiness!=='verified')fail('MR_ROUTE_PENDING');
 const binding=bindings.find(item=>item.hostId===request.hostId&&item.threadId===request.threadId);
 if(!binding||!global&&!binding.allowedModels.includes(request.selectionId))fail('MR_ROUTE_BINDING');
 const capabilities=model.capabilities;
 if(request.inputModalities.some(item=>!capabilities.inputModalities.includes(item))||(request.usesTools&&!capabilities.tools)||!capabilities.reasoningEfforts.includes(request.reasoningEffort))fail('MR_ROUTE_CAPABILITIES');
 if(request.estimatedInputTokens+request.maxOutputTokens>capabilities.contextWindow)fail('MR_ROUTE_BUDGET');
 const provider=validated.providers.find(item=>item.id===model.providerId);
 return {schemaVersion:validated.schemaVersion,...(validated.schemaVersion===2?{modelId:model.modelId}:{}),generation:validated.generation,hostId:request.hostId,threadId:request.threadId,turnId:request.turnId,selectionId:model.selectionId,upstreamModel:model.upstreamModel,providerId:provider.id,responsesUrl:provider.responsesUrl,credentialRef:provider.credentialRef,fallback:'none',createsThread:false,sendsRequest:false,loadsCredential:false,evidenceScope:'declared-metadata-only'};
}
