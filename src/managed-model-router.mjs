import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { ProxyAgent } from 'undici';
import { createOfficialRouter } from './router-core/official-router.mjs';
import { createModelRegistryRuntime } from './model-registry-runtime.mjs';
import { createCredentialReader } from './router-credentials.mjs';

const fail=()=>{throw new Error('MANAGED_CONFIG_CHANGED');};
const fields=['schemaVersion','modelRegistryPath','credentialConfigPath','bindingsPath','ingressCredentialRef','officialModels','port','officialProxyUrl'];
function json(path){try{return JSON.parse(readFileSync(path,'utf8'));}catch{fail();}}
export function validateManagedOptions(options){
 if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).sort().join(',')!==[...fields].sort().join(',')||options.schemaVersion!==1)fail();
 if(['modelRegistryPath','credentialConfigPath','bindingsPath'].some(k=>typeof options[k]!=='string'||!isAbsolute(options[k]))||typeof options.ingressCredentialRef!=='string'||!options.ingressCredentialRef||!Number.isInteger(options.port)||options.port<0||options.port>65535)fail();
 if(!Array.isArray(options.officialModels)||options.officialModels.some(m=>typeof m!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(m)||m.endsWith('_self'))||new Set(options.officialModels).size!==options.officialModels.length)fail();
 if(options.officialProxyUrl!==null){
  let url;try{url=new URL(options.officialProxyUrl);}catch{fail();}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||url.pathname!=='/')fail();
 }
 return structuredClone(options);
}

// Production adapter: configuration builds the resolver, never a test callback.
// Imported by the existing managed service; importing alone has no side effects.
export async function createManagedRouter({grant,options,guardTransport,record=()=>{}}){
 const config=validateManagedOptions(options);
 if(typeof guardTransport!=='function')fail();
 const runtime=createModelRegistryRuntime(config.modelRegistryPath);
 let credentials,ingressToken;
 try{credentials=createCredentialReader(json(config.credentialConfigPath));ingressToken=credentials.read(config.ingressCredentialRef);}catch{throw new Error('MANAGED_CREDENTIAL_UNAVAILABLE');}
 let dispatcher;
 try{
  if(config.officialProxyUrl!==null)dispatcher=new ProxyAgent(config.officialProxyUrl);
  const transport=guardTransport(async({route,responsesUrl,headers,body,signal})=>{
   if(route!=='official'&&route!=='company')throw new Error('ROUTE_REJECTED');
   if(route==='company'&&typeof responsesUrl!=='string')throw new Error('ROUTE_REJECTED');
   return fetch(route==='official'?'https://chatgpt.com/backend-api/codex/responses':responsesUrl,{method:'POST',headers,body,signal,redirect:'error',...(route==='official'&&dispatcher?{dispatcher}:{})});
  });
  const router=createOfficialRouter({ingressToken,boundThreadId:grant.threadId,nativeCompanyThreadId:grant.threadId,routeMode:'self',lifecycle:'continuous',expiresAt:grant.expiresAt,maxRequests:grant.remaining,
   officialModels:config.officialModels,transport,onRecord:record,
   resolveCompanyRoute:({model,threadId,turnId,payload})=>{
    if(threadId!==grant.threadId||model!==payload.model)fail();
    const snapshot=runtime.captureNative({hostId:'local',threadId,turnId},payload,json(config.bindingsPath));
    // Read only after identity, readiness and capability checks succeeded.
    // New gateways can be saved while the service runs. Resolve the current
    // host-owned credential mapping for this request, then retain its token.
    const companyToken=createCredentialReader(json(config.credentialConfigPath)).read(snapshot.credentialRef);
    return {upstreamModel:snapshot.upstreamModel,responsesUrl:snapshot.responsesUrl,allowHttp:snapshot.allowHttp,companyToken};
   }
  });
  return {...router,port:config.port,close:async()=>{router.stop();await dispatcher?.destroy();}};
 }catch(error){await dispatcher?.destroy();throw new Error(error.message==='MANAGED_CONFIG_CHANGED'?error.message:'MANAGED_ROUTER_FAILED');}
}
