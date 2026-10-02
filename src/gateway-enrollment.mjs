import {readFile,mkdir,realpath,lstat} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {prepareGatewayDraft} from './desktop-gateway-draft.mjs';
import {validateModelRegistry} from './model-registry.mjs';
import {planModelRegistryUpdate} from './model-registry-update.mjs';
import {createCredentialReader} from './router-credentials.mjs';
import {manageCredential} from './router-credential-management.mjs';
import {atomicWrite} from './store.mjs';
import {withFileLocks} from './registry-projection.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const fail=code=>{throw new Error(code);};
const exact=(v,keys)=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const json=value=>JSON.stringify(value,null,2)+'\n';
async function safe(fn){try{return await fn();}catch(e){return {ok:false,code:e.code==='EEXIST'?'GE_LOCKED':/^(GE|DG|MR|RC)_[A-Z_]+$/.test(e.message)?e.message:'GE_UNAVAILABLE'};}}
async function regular(path){const s=await lstat(path);if(!s.isFile()||s.isSymbolicLink()||s.size>131072)fail('GE_KEY_CHANGED');return readFile(path);}

// Trusted host-only service. No HTTP, IPC registration, key readback or logging.
// Recovery checks file identities instead of assuming a multi-file transaction.
export async function createGatewayEnrollment(options){
 if(!exact(options,['modelRegistryPath','credentialConfigPath','bindingsPath','operationRoot'])||Object.values(options).some(p=>typeof p!=='string'||!isAbsolute(p)))fail('GE_HOST_CONFIG');
 options={...options};
 let canonical;
 try{
  canonical=Object.fromEntries(await Promise.all(Object.entries(options).map(async([k,v])=>[k,await realpath(v)])));
  if(new Set(Object.values(canonical)).size!==4||!(await lstat(canonical.operationRoot)).isDirectory())fail('GE_HOST_CONFIG');
 }catch{fail('GE_HOST_CONFIG');}
 const {modelRegistryPath:models,credentialConfigPath:credentials,bindingsPath:bindings,operationRoot:root}=canonical;
 const hostIdentity=hash(json(canonical));
 const configLocks=[models+'.model-update.lock',credentials+'.lock',bindings+'.lock'];
 async function checkHost(){for(const [k,v] of Object.entries(options))if(await realpath(v)!==canonical[k])fail('GE_HOST_CHANGED');}
 async function readPlan(receipt){
  await checkHost();
  if(!exact(receipt,['ok','operationId','planSha256'])||receipt.ok!==true||typeof receipt.operationId!=='string'||! /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(receipt.operationId)||!digest(receipt.planSha256))fail('GE_RECEIPT');
  const directory=join(root,receipt.operationId);
  if((await lstat(directory)).isSymbolicLink()||await realpath(directory)!==directory)fail('GE_RECEIPT');
  const bytes=await readFile(join(directory,'plan.json'));if(hash(bytes)!==receipt.planSha256)fail('GE_PLAN_CHANGED');
  const plan=JSON.parse(bytes);
  if(!exact(plan,['schemaVersion','hostIdentity','baseModels','baseCredentials','targetModels','targetCredentials','credentialRef'])||plan.schemaVersion!==1||plan.hostIdentity!==hostIdentity||!digest(plan.baseModels)||!digest(plan.baseCredentials)||typeof plan.targetModels!=='string'||typeof plan.targetCredentials!=='string')fail('GE_PLAN_CHANGED');
  validateModelRegistry(JSON.parse(plan.targetModels));createCredentialReader(JSON.parse(plan.targetCredentials));
  const entry=JSON.parse(plan.targetCredentials).credentials.find(c=>c.credentialRef===plan.credentialRef);
  if(!entry||entry.filePath!==join(directory,'secret.dpapi'))fail('GE_PLAN_CHANGED');
  return {plan,directory};
 }
 async function keyState(directory){
  let cipher;try{cipher=await regular(join(directory,'secret.dpapi'));}catch(e){
   if(e.code!=='ENOENT')throw e;
   try{await lstat(join(directory,'credential-receipt.json'));}catch(error){if(error.code==='ENOENT')return 'prepared';throw error;}
   fail('GE_KEY_CHANGED');
  }
  let receipt;try{receipt=JSON.parse(await readFile(join(directory,'credential-receipt.json'),'utf8'));}catch(e){if(e.code==='ENOENT')return 'credential-uncertain';fail('GE_KEY_CHANGED');}
  if(!exact(receipt,['sha256'])||!digest(receipt.sha256)||receipt.sha256!==hash(cipher))fail('GE_KEY_CHANGED');
  return 'credential-ready';
 }
 async function state(plan,directory){
  const m=hash(await readFile(models)),c=hash(await readFile(credentials));
  const targetM=hash(plan.targetModels),targetC=hash(plan.targetCredentials);
  if(![plan.baseModels,targetM].includes(m)||![plan.baseCredentials,targetC].includes(c)||m===targetM&&c!==targetC)fail('GE_CONFLICT');
  const key=await keyState(directory);
  if(key!=='credential-ready'){
   if(m===targetM||c===targetC)fail('GE_KEY_CHANGED');
   return key;
  }
  return m===targetM?'applied':c===targetC?'credentials-registered':'credential-ready';
 }
 async function locked(receipt,fn,lockKey=false){
  const loaded=await readPlan(receipt);
  return withFileLocks([join(loaded.directory,'operation.lock'),...configLocks,...(lockKey?[join(loaded.directory,'secret.dpapi.credential.lock')]:[])],async()=>{
   const current=await readPlan(receipt);return fn(current.plan,current.directory);
  });
 }
 return Object.freeze({
  prepare:input=>safe(async()=>{
   await checkHost();
   return withFileLocks(configLocks,async()=>{
    await checkHost();
    const beforeM=await readFile(models),beforeC=await readFile(credentials),mapping=JSON.parse(beforeC);createCredentialReader(mapping);
    const operationId=randomUUID(),directory=join(root,operationId),credentialRef='gateway-'+operationId;
    const identity={providerId:'gateway-'+operationId,credentialRef,modelIds:Array.isArray(input?.models)?input.models.map(()=>randomUUID()):[]};
    const result=prepareGatewayDraft(JSON.parse(beforeM),input,identity);
    const planCheck=planModelRegistryUpdate(JSON.parse(beforeM),result.registry,JSON.parse(await readFile(bindings)));if(planCheck.status!=='compatible')fail('GE_BLOCKED');
    mapping.credentials.push({credentialRef,filePath:join(directory,'secret.dpapi')});createCredentialReader(mapping);
    const content=json({schemaVersion:1,hostIdentity,baseModels:hash(beforeM),baseCredentials:hash(beforeC),targetModels:json(result.registry),targetCredentials:json(mapping),credentialRef});
    await mkdir(directory);await atomicWrite(join(directory,'plan.json'),content,true);
    return {ok:true,operationId,planSha256:hash(content)};
   });
  }),
  inspect:receipt=>safe(()=>locked(receipt,async(plan,directory)=>({ok:true,status:await state(plan,directory),runtimeActivated:false}),true)),
  createKey:(receipt,secret)=>safe(()=>locked(receipt,async(plan,directory)=>{
   if(typeof secret!=='string'||!/^[\x21-\x7e]{1,8192}$/.test(secret))fail('GE_KEY_INPUT');
   const current=await state(plan,directory);if(current==='credential-uncertain')fail('GE_KEY_UNCERTAIN');
   if(current!=='prepared')return {ok:true,status:current,keyCreated:false};
   const result=manageCredential(JSON.parse(plan.targetCredentials),{operation:'create',credentialRef:plan.credentialRef,secret});
   await atomicWrite(join(directory,'credential-receipt.json'),json({sha256:result.sha256}),true);
   return {ok:true,status:'credential-ready',keyCreated:true};
  })),
  apply:receipt=>safe(()=>locked(receipt,async(plan,directory)=>{
   const current=await state(plan,directory);
   if(current==='prepared')fail('GE_KEY_REQUIRED');if(current==='credential-uncertain')fail('GE_KEY_UNCERTAIN');
   if(current!=='applied'){
    const candidate=JSON.parse(plan.targetModels),check=planModelRegistryUpdate(JSON.parse(await readFile(models)),candidate,JSON.parse(await readFile(bindings)));
    if(check.status!=='compatible')fail('GE_BLOCKED');
    if(current==='credential-ready')await atomicWrite(credentials,plan.targetCredentials);
    await atomicWrite(models,plan.targetModels);
   }
   return {ok:true,status:'applied',runtimeActivated:false,sendsRequest:false};
  },true))
 });
}
