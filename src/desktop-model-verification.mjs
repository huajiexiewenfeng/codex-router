import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createCredentialReader} from './router-credentials.mjs';
import {verifyGatewayModel} from './gateway-model-verification.mjs';
import {validateModelRegistry} from './model-registry.mjs';
import {planModelRegistryUpdate} from './model-registry-update.mjs';
import {withFileLocks} from './registry-projection.mjs';
import {atomicWrite} from './store.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
const fail=code=>{throw Error(code);};

// Paths and dependencies are supplied by the trusted host, never the renderer.
export async function verifyDesktopModel({modelRegistryPath:models,bindingsPath:bindings,credentialConfigPath:credentials,evidenceRoot,checkConfig},request,{credentialReader=createCredentialReader,verify=verifyGatewayModel}={}){
 if(!request||Object.keys(request).sort().join(',')!=='confirmed,modelId,revision'||request.confirmed!==true)fail('GV_CONFIRM');
 return withFileLocks([models+'.model-update.lock',bindings+'.lock',credentials+'.lock'],async()=>{
  await checkConfig();const before=await readFile(models),registry=validateModelRegistry(JSON.parse(before));
  if(registry.schemaVersion!==2||hash(before)!==request.revision)fail('DESKTOP_CONFIG_STALE');
  const model=registry.models.find(m=>m.modelId===request.modelId);if(!model)fail('GV_MODEL_MISSING');
  const provider=registry.providers.find(p=>p.id===model.providerId),credentialBytes=await readFile(credentials),mapping=JSON.parse(credentialBytes);
  const reader=credentialReader(mapping),entry=mapping.credentials.find(c=>c.credentialRef===provider.credentialRef);if(!entry)fail('RC_REFERENCE');
  return withFileLocks([entry.filePath+'.credential.lock'],async()=>{
   const cipher=await readFile(entry.filePath),bindingBytes=await readFile(bindings);
   const proof=await verify({baseUrl:provider.responsesUrl,allowHttp:provider.allowHttp,model:model.upstreamModel,secret:reader.read(provider.credentialRef)});
   if(proof?.ok!==true||proof.scope!=='responses-stream-text'||proof.completed!==true||proof.markerMatched!==true||proof.httpStatus!==200||!/^[a-f0-9]{64}$/.test(proof.bodySha256)||!Number.isInteger(proof.bytes)||proof.bytes<=0)fail('GV_FAILED');
   const verificationRef='text-'+randomUUID(),candidate=structuredClone(registry),target=candidate.models.find(m=>m.modelId===model.modelId);
   target.readiness='verified';target.verificationRef=verificationRef;candidate.generation++;
   const caps=target.capabilities;
   target.catalogEntry??={slug:target.selectionId,display_name:target.displayName,description:'Gateway text stream verified; tools and context limits are user-declared, not verified.',visibility:'list',context_window:caps.contextWindow,input_modalities:caps.inputModalities,supported_reasoning_levels:caps.reasoningEfforts.map(effort=>({effort,description:effort})),default_reasoning_level:caps.reasoningEfforts.includes('high')?'high':caps.reasoningEfforts[0],supported_in_api:true};
   if(planModelRegistryUpdate(registry,candidate,JSON.parse(bindingBytes)).status!=='compatible')fail('MR_STORE_BLOCKED');
   async function unchanged(){
    await checkConfig();
    if(!before.equals(await readFile(models))||!credentialBytes.equals(await readFile(credentials))||!cipher.equals(await readFile(entry.filePath))||!bindingBytes.equals(await readFile(bindings)))fail('DESKTOP_CONFIG_STALE');
   }
   await unchanged();
   const evidence={schemaVersion:1,modelId:target.modelId,providerId:provider.id,upstreamModel:target.upstreamModel,verifiedAt:new Date().toISOString(),configurationSha256:hash(before),proof:{ok:true,scope:'responses-stream-text',httpStatus:200,completed:true,markerMatched:true,bytes:proof.bytes,bodySha256:proof.bodySha256,toolsVerified:false,contextLimitVerified:false,workerVerified:false}};
   await atomicWrite(join(evidenceRoot,verificationRef+'.json'),JSON.stringify(evidence,null,2)+'\n',true);
   await atomicWrite(models+'.verification-backup-'+randomUUID()+'.json',before.toString('utf8'),true);
   await unchanged();await atomicWrite(models,JSON.stringify(candidate,null,2)+'\n');
   return {ok:true,status:'verified',scope:'responses-stream-text',verificationRef,backupSaved:true,workerVerified:false};
  });
 });
}
