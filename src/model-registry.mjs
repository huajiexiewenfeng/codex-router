export class ModelRoutingError extends Error {
 constructor(code){super(code);this.name='ModelRoutingError';}
}

export function fail(code){throw new ModelRoutingError(code);}

const rootFields=['schemaVersion','generation','suffix','providers','models','activeProviderId'];
const providerFields=['id','kind','wireApi','responsesUrl','credentialRef','allowHttp','displayName'];
const modelFields=['selectionId','upstreamModel','providerId','readiness','verificationRef','capabilities','catalogEntry'];
const modelFieldsV2=[...modelFields,'modelId','displayName','enabled'];
const capabilityFields=['contextWindow','inputModalities','tools','reasoningEfforts'];
const catalogRequired=['slug','display_name','description','visibility','context_window','input_modalities','supported_reasoning_levels','default_reasoning_level','supported_in_api'];
const reference=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const modelId=/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/;
const credentialLooking=/^(?:(?:sk|pk|rk)[_-]|(?:api[_-]?key|secret|token|bearer)(?:$|[_-]))/i;
const credentialPathSegment=/^(?:(?:sk|pk|rk)[_-]|(?:api[_-]?key|secret|token|authorization|cookie|password|bearer)(?:$|[_-]))/i;

function object(value){return value!==null&&typeof value==='object'&&!Array.isArray(value);}
function exactFields(value,fields,code){return object(value)&&Object.keys(value).every(key=>fields.includes(key));}
function safeReference(value){return typeof value==='string'&&reference.test(value)&&!credentialLooking.test(value);}
export function safeModelId(value){return typeof value==='string'&&modelId.test(value)&&!credentialLooking.test(value);}
export const usesActiveGateway=registry=>Object.hasOwn(registry,'activeProviderId');
export const currentGatewayModels=registry=>usesActiveGateway(registry)?registry.models.filter(m=>m.providerId===registry.activeProviderId):registry.models;
export function declaredCatalogEntry(model){
 const c=model.capabilities;
 return model.catalogEntry??{slug:model.selectionId,display_name:model.displayName??model.selectionId,description:'Gateway model; capabilities are user-declared, not verified.',visibility:'list',context_window:c.contextWindow,input_modalities:[...c.inputModalities],supported_reasoning_levels:c.reasoningEfforts.map(effort=>({effort,description:effort})),default_reasoning_level:c.reasoningEfforts.includes('high')?'high':c.reasoningEfforts[0],supported_in_api:true};
}
function sameStrings(left,right){return left.length===right.length&&left.every(value=>right.includes(value));}
function uniqueStrings(value,check){return Array.isArray(value)&&value.length>0&&value.every(check)&&new Set(value).size===value.length;}
function safeText(value,max=2000){return typeof value==='string'&&value.length>0&&value.length<=max;}
function secretField(key){
 // Preserve word boundaries before folding case: IDToken -> ID Token.
 const words=key.replace(/([A-Z]+)([A-Z][a-z])/g,'$1 $2').replace(/([a-z0-9])([A-Z])/g,'$1 $2').toLowerCase().split(/[^a-z0-9]+/);
 if(words.some(word=>/^(?:auth|authorization|authentication|credentials?|secrets?|tokens?|passwords?|cookies?|headers?|bearer)$/.test(word)))return true;
 // A bare key is valid metadata; these finite contexts identify credential keys.
 const keyContexts=['api','access','private','client','signing','encryption','session','shared'];
 if(words.some((word,index)=>/^keys?$/.test(word)&&keyContexts.includes(words[index-1])||keyContexts.some(context=>word===`${context}key`||word===`${context}keys`)))return true;
 // Recognize known compact spellings; arbitrary unseparated words are not scanned.
 return words.some(word=>/^(?:authtoken|requestheaders?|responseheaders?|sessioncookies?)$/.test(word))||/^xapikey$/i.test(key);
}

function rejectSecretFields(value){
 if(Array.isArray(value)){for(const item of value)rejectSecretFields(item);return;}
 if(!object(value))return;
 for(const [key,item] of Object.entries(value)){
  if(secretField(key))fail('MR_CATALOG_SECRET');
  rejectSecretFields(item);
 }
}

function validateCatalogContextLimits(value,contextWindow){
 if(Array.isArray(value)){for(const item of value)validateCatalogContextLimits(item,contextWindow);return;}
 if(!object(value))return;
 for(const [key,item] of Object.entries(value)){
  if(key==='max_context_window'&&(!Number.isSafeInteger(item)||item<=0||item>contextWindow))fail('MR_CATALOG_CAPABILITIES');
  validateCatalogContextLimits(item,contextWindow);
 }
}

function validateCapabilities(value){
 if(!exactFields(value,capabilityFields,'MR_CAPABILITIES'))fail('MR_CAPABILITIES');
 if(!Number.isSafeInteger(value.contextWindow)||value.contextWindow<=0)fail('MR_CAPABILITIES');
 if(!uniqueStrings(value.inputModalities,item=>safeReference(item)))fail('MR_CAPABILITIES');
 if(typeof value.tools!=='boolean')fail('MR_CAPABILITIES');
 if(!uniqueStrings(value.reasoningEfforts,item=>safeReference(item)))fail('MR_CAPABILITIES');
}

function validateCatalogEntry(entry,model){
 if(!object(entry)){fail('MR_MODEL_VERIFICATION');}
 rejectSecretFields(entry);
 validateCatalogContextLimits(entry,model.capabilities.contextWindow);
 if(!catalogRequired.every(field=>Object.hasOwn(entry,field)))fail('MR_CATALOG_ENTRY');
 if(!safeModelId(entry.slug)||!safeText(entry.display_name)||!safeText(entry.description)||!safeReference(entry.visibility))fail('MR_CATALOG_ENTRY');
 if(!Number.isSafeInteger(entry.context_window)||entry.context_window<=0||!uniqueStrings(entry.input_modalities,item=>safeReference(item)))fail('MR_CATALOG_ENTRY');
 if(!Array.isArray(entry.supported_reasoning_levels)||entry.supported_reasoning_levels.length===0)fail('MR_CATALOG_ENTRY');
 const efforts=[];
 for(const level of entry.supported_reasoning_levels){
  if(!object(level)||!safeReference(level.effort)||!safeText(level.description)||efforts.includes(level.effort))fail('MR_CATALOG_ENTRY');
  rejectSecretFields(level);efforts.push(level.effort);
 }
 if(entry.slug!==model.selectionId||entry.display_name!==(model.displayName??model.selectionId)||entry.context_window!==model.capabilities.contextWindow||!sameStrings(entry.input_modalities,model.capabilities.inputModalities)||!sameStrings(efforts,model.capabilities.reasoningEfforts)||!model.capabilities.reasoningEfforts.includes(entry.default_reasoning_level)||typeof entry.supported_in_api!=='boolean'||entry.supported_in_api!==true)fail('MR_CATALOG_CAPABILITIES');
}

function validateProvider(provider){
 if(!exactFields(provider,providerFields,'MR_PROVIDER_FIELD'))fail('MR_PROVIDER_FIELD');
 if(Object.hasOwn(provider,'displayName')&&(!safeText(provider.displayName,80)||provider.displayName.trim()!==provider.displayName||/[\u0000-\u001f\u007f]/.test(provider.displayName)))fail('MR_PROVIDER_NAME');
 if(!safeReference(provider.id)||!safeReference(provider.credentialRef))fail('MR_PROVIDER_ID');
 if(provider.kind!=='api-key'||provider.wireApi!=='responses'||typeof provider.allowHttp!=='boolean')fail('MR_PROVIDER_KIND');
 let url;try{url=new URL(provider.responsesUrl);}catch{fail('MR_PROVIDER_URL');}
 if(provider.responsesUrl!==url.href||url.protocol!=='https:'&&!(url.protocol==='http:'&&provider.allowHttp===true))fail('MR_PROVIDER_URL');
 let segments;try{segments=url.pathname.split('/').filter(Boolean).map(segment=>decodeURIComponent(segment));}catch{fail('MR_PROVIDER_URL');}
 if(url.username||url.password||url.search||url.hash||!url.pathname.endsWith('/responses')||url.pathname.includes('//')||url.pathname.includes('%')||segments.some(segment=>/[\\/\u0000-\u001f\u007f]/.test(segment)||credentialPathSegment.test(segment)))fail('MR_PROVIDER_URL');
}

export function validateModelRegistry(registry){
 if(!exactFields(registry,rootFields,'MR_REGISTRY_FIELD'))fail('MR_REGISTRY_FIELD');
 if(![1,2].includes(registry.schemaVersion)||!Number.isSafeInteger(registry.generation)||registry.generation<=0||!['_self','-self'].includes(registry.suffix)||!Array.isArray(registry.providers)||!Array.isArray(registry.models))fail('MR_REGISTRY');
 const providerIds=new Set();
 for(const provider of registry.providers){validateProvider(provider);if(providerIds.has(provider.id))fail('MR_PROVIDER_DUPLICATE');providerIds.add(provider.id);}
 if(usesActiveGateway(registry)&&(registry.schemaVersion!==2||registry.activeProviderId!==null&&!providerIds.has(registry.activeProviderId)))fail('MR_ACTIVE_PROVIDER');
 const modelIds=new Set(),stableIds=new Set();
 for(const model of registry.models){
  const v2=registry.schemaVersion===2;
  if(!exactFields(model,v2?modelFieldsV2:modelFields,'MR_MODEL_FIELD'))fail('MR_MODEL_FIELD');
  if(v2&&Object.hasOwn(model,'enabled')&&typeof model.enabled!=='boolean')fail('MR_MODEL_ENABLED');
  if(!safeModelId(model.selectionId)||!safeModelId(model.upstreamModel)||!safeReference(model.providerId))fail('MR_MODEL_ID');
  if(v2){
   if(!safeReference(model.modelId)||!safeText(model.displayName,200)||model.displayName.trim()!==model.displayName||!model.displayName.trim()||/[\u0000-\u001f\u007f]/.test(model.displayName)||!model.selectionId.endsWith(registry.suffix)||model.selectionId.length<=registry.suffix.length)fail('MR_MODEL_ID');
   if(stableIds.has(model.modelId))fail('MR_MODEL_DUPLICATE');stableIds.add(model.modelId);
  }else if(model.selectionId!==`${model.upstreamModel}${registry.suffix}`)fail('MR_MODEL_ID');
  const alias=usesActiveGateway(registry)?JSON.stringify([model.providerId,model.selectionId]):model.selectionId;
  if(modelIds.has(alias))fail('MR_MODEL_DUPLICATE');modelIds.add(alias);
  if(!providerIds.has(model.providerId))fail('MR_MODEL_PROVIDER');
  if(model.readiness!=='pending'&&model.readiness!=='verified')fail('MR_MODEL_READINESS');
  validateCapabilities(model.capabilities);
  if(model.readiness==='verified'){
   if(!safeReference(model.verificationRef)||!Object.hasOwn(model,'catalogEntry'))fail('MR_MODEL_VERIFICATION');
   validateCatalogEntry(model.catalogEntry,model);
  }else if(Object.hasOwn(model,'verificationRef')||Object.hasOwn(model,'catalogEntry'))fail('MR_MODEL_PENDING');
 }
 return structuredClone(registry);
}
