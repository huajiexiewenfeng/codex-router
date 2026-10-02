import { fail, safeModelId, validateModelRegistry, usesActiveGateway, currentGatewayModels } from './model-registry.mjs';
import {validateModelBindings} from './model-registry-update.mjs';

const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const tools=new Set(['function_call','function_call_output','custom_tool_call','custom_tool_call_output']);
export function describeNativeRequest(payload){
 if(!object(payload)||!safeModelId(payload.model)||payload.stream!==true||!Array.isArray(payload.input))fail('MR_NATIVE_REQUEST');
 if(payload.previous_response_id||payload.conversation)fail('MR_NATIVE_HISTORY_REFERENCE');
 if(payload.tools!==undefined&&(!Array.isArray(payload.tools)||payload.tools.some(t=>!object(t)||typeof t.type!=='string'||!t.type)))fail('MR_NATIVE_REQUEST');
 const modalities=new Set(['text']);let usesTools=Boolean(payload.tools?.length);
 for(const item of payload.input){
  if(!object(item))fail('MR_NATIVE_REQUEST');
  if(item.type==='additional_tools'){
   if(item.role!=='developer'||!Array.isArray(item.tools)||item.tools.some(t=>!object(t)||typeof t.type!=='string'||!t.type))fail('MR_NATIVE_REQUEST');
   usesTools ||= item.tools.length>0;continue;
  }
  if(tools.has(item.type)){usesTools=true;continue;}
  if(['reasoning','compaction'].includes(item.type))continue;
  if(item.type!==undefined&&item.type!=='message')fail('MR_NATIVE_REQUEST');
  if(!['user','assistant','system','developer'].includes(item.role))fail('MR_NATIVE_REQUEST');
  if(typeof item.content==='string')continue;
  if(!Array.isArray(item.content))fail('MR_NATIVE_REQUEST');
  for(const part of item.content){
   if(!object(part))fail('MR_NATIVE_REQUEST');
   if(['input_text','output_text'].includes(part.type)&&typeof part.text==='string')continue;
   if(part.type==='input_image'&&(typeof part.image_url==='string'||typeof part.file_id==='string')){modalities.add('image');continue;}
   fail('MR_NATIVE_REQUEST');
  }
 }
 if(payload.reasoning!==undefined&&(!object(payload.reasoning)||(payload.reasoning.effort!==undefined&&typeof payload.reasoning.effort!=='string')))fail('MR_NATIVE_REQUEST');
 if(payload.max_output_tokens!==undefined&&(!Number.isSafeInteger(payload.max_output_tokens)||payload.max_output_tokens<=0))fail('MR_NATIVE_REQUEST');
 return {selectionId:payload.model,inputModalities:[...modalities],usesTools,reasoningEffort:payload.reasoning?.effort??null,maxOutputTokens:payload.max_output_tokens??null,estimatedInputTokens:null,tokenBudgetValidation:'upstream-required'};
}

export function planNativeModelRoute(registry,identity,payload,bindings){
 const r=validateModelRegistry(registry),request=describeNativeRequest(payload);
 if(!object(identity)||Object.keys(identity).sort().join(',')!=='hostId,threadId,turnId'||identity.hostId!=='local'||!uuid.test(identity.threadId??'')||!uuid.test(identity.turnId??''))fail('MR_ROUTE_REQUEST');
 if(!Array.isArray(bindings))fail('MR_ROUTE_BINDING');
 const global=usesActiveGateway(r);
 if(global){try{validateModelBindings(bindings,r.models,true);}catch{fail('MR_ROUTE_BINDING');}}
 const keys=new Set();
 for(const b of global?[]:bindings){
  if(!object(b)||Object.keys(b).sort().join(',')!=='allowedModels,hostId,threadId'||b.hostId!=='local'||!uuid.test(b.threadId??'')||!Array.isArray(b.allowedModels)||!b.allowedModels.length||b.allowedModels.some(id=>!safeModelId(id)||!r.models.some(m=>m.selectionId===id))||new Set(b.allowedModels).size!==b.allowedModels.length)fail('MR_ROUTE_BINDING');
  const key=b.hostId+':'+b.threadId;if(keys.has(key))fail('MR_ROUTE_BINDING');keys.add(key);
 }
 if(global&&r.activeProviderId===null)fail('MR_ACTIVE_PROVIDER_REQUIRED');
 const model=currentGatewayModels(r).find(m=>m.selectionId===request.selectionId);
 if(!model)fail('MR_ROUTE_MODEL');if(model.enabled===false)fail('MR_ROUTE_DISABLED');if(!global&&model.readiness!=='verified')fail('MR_ROUTE_PENDING');
 if(!bindings.some(b=>b.hostId===identity.hostId&&b.threadId===identity.threadId&&(global||b.allowedModels.includes(model.selectionId))))fail('MR_ROUTE_BINDING');
 // The menu default is not proof that this request sent that effort. Preserve
 // absence rather than inventing a value or silently rewriting the payload.
 const reasoningEffort=request.reasoningEffort;
 if(request.inputModalities.some(v=>!model.capabilities.inputModalities.includes(v))||(request.usesTools&&!model.capabilities.tools)||(reasoningEffort!==null&&!model.capabilities.reasoningEfforts.includes(reasoningEffort)))fail('MR_ROUTE_CAPABILITIES');
 if(request.maxOutputTokens!==null&&request.maxOutputTokens>model.capabilities.contextWindow)fail('MR_ROUTE_BUDGET');
 const provider=r.providers.find(p=>p.id===model.providerId);
 return {schemaVersion:r.schemaVersion,generation:r.generation,modelId:model.modelId,...identity,...request,reasoningEffort,reasoningEffortSource:reasoningEffort===null?'upstream-default':'request',upstreamModel:model.upstreamModel,providerId:provider.id,responsesUrl:provider.responsesUrl,credentialRef:provider.credentialRef,allowHttp:provider.allowHttp,fallback:'none',loadsCredential:false,sendsRequest:false};
}
