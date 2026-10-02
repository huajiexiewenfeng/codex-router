import {validateModelRegistry,safeModelId,usesActiveGateway} from './model-registry.mjs';
import {planModelRegistryUpdate} from './model-registry-update.mjs';

const fail=code=>{throw new Error(code);};
const exact=(value,keys)=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
export function responsesEndpoint(value,allowHttp){
 if(typeof value!=='string'||value!==value.trim()||/[\\\s%?#]/.test(value)||value.split('/').some(part=>part==='.'||part==='..'))fail('DG_URL');
 let url;try{url=new URL(value);}catch{fail('DG_URL');}
 if(url.username||url.password||!['https:','http:'].includes(url.protocol)||url.pathname.includes('//'))fail('DG_URL');
 if(url.protocol==='http:'&&!allowHttp)fail('DG_HTTP_CONFIRMATION');
 // Only documented forms: versioned base or explicit Responses endpoint.
 if(url.pathname.endsWith('/v1/'))url.pathname=url.pathname.slice(0,-1);
 if(url.pathname.endsWith('/v1'))url.pathname+='/responses';
 else if(!url.pathname.endsWith('/responses'))fail('DG_URL');
 return url.href;
}

// Pure host-side preparation. Returned registry contains references, never Key
// material. It is NOT a renderer receipt, a credential write, or an apply token.
export function prepareGatewayDraft(current,input,hostIdentity){
 if(!exact(input,['displayName','baseUrl','allowHttp','models','capabilities'])||!exact(hostIdentity,['providerId','credentialRef','modelIds']))fail('DG_REQUEST');
 if(typeof input.displayName!=='string'||!input.displayName.trim()||input.displayName.length>80||/[\u0000-\u001f\u007f]/.test(input.displayName)||typeof input.allowHttp!=='boolean'||!Array.isArray(input.models)||input.models.length>200||!Array.isArray(hostIdentity.modelIds)||hostIdentity.modelIds.length!==input.models.length)fail('DG_REQUEST');
 const registry=validateModelRegistry(current);
 if(registry.schemaVersion!==2||registry.suffix!=='_self')fail('DG_SCHEMA');
 const displayName=input.displayName.trim();
 if(registry.providers.some(p=>(p.displayName??p.id)===displayName))fail('DG_NAME_CONFLICT');
 if(registry.providers.some(p=>p.id===hostIdentity.providerId||p.credentialRef===hostIdentity.credentialRef))fail('DG_ID_CONFLICT');
 const names=input.models.map(name=>typeof name==='string'?name.trim():'');
 if(names.some(name=>!safeModelId(name)))fail('DG_MODEL');
 if(new Set(names).size!==names.length||!usesActiveGateway(registry)&&names.some(name=>registry.models.some(m=>m.selectionId===name+'_self')))fail('DG_MODEL_CONFLICT');
 const provider={id:hostIdentity.providerId,displayName,kind:'api-key',wireApi:'responses',responsesUrl:responsesEndpoint(input.baseUrl,input.allowHttp),credentialRef:hostIdentity.credentialRef,allowHttp:input.allowHttp};
 registry.providers.push(provider);registry.generation++;
 registry.models.push(...names.map((name,index)=>({modelId:hostIdentity.modelIds[index],providerId:provider.id,upstreamModel:name,selectionId:name+'_self',displayName:name+'_self',enabled:false,readiness:'pending',capabilities:structuredClone(input.capabilities)})));
 validateModelRegistry(registry);
 return {registry,plan:planModelRegistryUpdate(current,registry),applies:false,sendsRequest:false,loadsCredential:false};
}
