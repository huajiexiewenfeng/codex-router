import {readFile,lstat,realpath} from 'node:fs/promises';
import {dirname,join,isAbsolute} from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {loadRouterConfig,routerStatus} from './router-service.mjs';
import {validateManagedOptions} from './managed-model-router.mjs';
import {readRouterRegistry} from './router-registry.mjs';
import {createCredentialReader} from './router-credentials.mjs';
import {manageCredential} from './router-credential-management.mjs';
import {atomicWrite} from './store.mjs';
import {withFileLocks} from './registry-projection.mjs';
const fail=code=>{throw Error(code);};
const hash=value=>createHash('sha256').update(value).digest('hex');
const json=value=>JSON.stringify(value,null,2)+'\n';
async function regular(path){const s=await lstat(path);if(!s.isFile()||s.isSymbolicLink()||s.size>1048576)fail('DI_FILE_INVALID');return readFile(path,'utf8');}
async function optional(path){try{return await regular(path);}catch(e){if(e.code==='ENOENT')return null;throw e;}}
function stopped(path){const s=routerStatus(path);if(!['stopped','not_started'].includes(s.state)||s.lockPresent||s.active||s.stopRequested)fail('DI_SERVICE_ACTIVE');}

// Trusted host-only bootstrap. Never exposes plaintext or rotates existing credentials.
export async function prepareDesktopIngress(configPath,{expectedConfigIdentity}={}){
 try{
  if(typeof configPath!=='string'||!isAbsolute(configPath))fail('DI_CONFIG_INVALID');
  await regular(configPath);const path=await realpath(configPath);
  return await withFileLocks([path+'.desktop-control.lock'],async()=>{
   const configBytes=await regular(path),config=loadRouterConfig(path),options=validateManagedOptions(config.adapterOptions);
   if(expectedConfigIdentity!==undefined&&JSON.stringify(config)!==expectedConfigIdentity)fail('DI_CONFIG_CHANGED');
   if(!config.registryPath||options.ingressCredentialRef!=='desktop-unconfigured')fail('DI_CONFIG_INVALID');
   stopped(path);
   const mappingPath=await realpath(options.credentialConfigPath),bindingsPath=await realpath(options.bindingsPath);
   const cipherPath=join(dirname(mappingPath),'desktop-ingress.dpapi'),planPath=cipherPath+'.plan.json',receiptPath=cipherPath+'.receipt.json';
   const entry={credentialRef:options.ingressCredentialRef,filePath:cipherPath};
   return withFileLocks([mappingPath+'.lock',config.registryPath+'.mutation.lock',bindingsPath+'.lock'],async()=>{
    const mappingBytes=await regular(mappingPath),mapping=JSON.parse(mappingBytes);createCredentialReader(mapping);
    const prior=mapping.credentials.find(c=>c.credentialRef===entry.credentialRef);
    if(prior&&JSON.stringify(prior)!==JSON.stringify(entry))fail('DI_REFERENCE_CONFLICT');
    if(!prior){
     const registryBytes=await optional(config.registryPath);
     if(registryBytes!==null&&readRouterRegistry(config.registryPath).bindings.length)fail('DI_BINDINGS_PRESENT');
     const bindings=JSON.parse(await regular(bindingsPath));if(!Array.isArray(bindings))fail('DI_CONFIG_INVALID');
     if(bindings.length)fail('DI_BINDINGS_PRESENT');
    }
    let planBytes=await optional(planPath),plan;
    if(planBytes===null){
     if(prior||await optional(cipherPath)!==null||await optional(receiptPath)!==null)fail('DI_CREDENTIAL_CHANGED');
     plan={schemaVersion:1,configPath:path,credentialRef:entry.credentialRef,filePath:cipherPath,baseMappingSha256:hash(mappingBytes)};
     await atomicWrite(planPath,json(plan),true);
    }else{
     plan=JSON.parse(planBytes);
     if(Object.keys(plan).sort().join(',')!=='baseMappingSha256,configPath,credentialRef,filePath,schemaVersion'||plan.schemaVersion!==1||plan.configPath!==path||plan.credentialRef!==entry.credentialRef||plan.filePath!==cipherPath||!/^[a-f0-9]{64}$/.test(plan.baseMappingSha256))fail('DI_PLAN_CHANGED');
    }
    if(!prior&&hash(mappingBytes)!==plan.baseMappingSha256)fail('DI_MAPPING_CONFLICT');
    const target=prior?mapping:{...mapping,credentials:[...mapping.credentials,entry]};createCredentialReader(target);
    let cipher=await optional(cipherPath),receipt=await optional(receiptPath),created=false;
    if(cipher===null){
     if(receipt!==null||prior)fail('DI_CREDENTIAL_CHANGED');
     const result=manageCredential(target,{operation:'create',credentialRef:entry.credentialRef,secret:randomBytes(32).toString('hex')});
     await atomicWrite(receiptPath,json({sha256:result.sha256}),true);created=true;
    }else if(receipt===null)fail('DI_CREDENTIAL_UNCERTAIN');
    return withFileLocks([cipherPath+'.credential.lock'],async()=>{
     cipher=await regular(cipherPath);receipt=JSON.parse(await regular(receiptPath));
     if(Object.keys(receipt).join(',')!=='sha256'||receipt.sha256!==hash(cipher))fail('DI_CREDENTIAL_CHANGED');
     let secret;try{secret=createCredentialReader(target).read(entry.credentialRef);if(!/^[a-f0-9]{64}$/.test(secret))fail('DI_CREDENTIAL_CHANGED');}catch{fail('DI_CREDENTIAL_CHANGED');}finally{secret=undefined;}
     stopped(path);
     if(await regular(path)!==configBytes||await regular(mappingPath)!==mappingBytes)fail('DI_MAPPING_CONFLICT');
     if(!prior)await atomicWrite(mappingPath,json(target));
     return {ok:true,status:'ready',created};
    });
   });
  });
 }catch(e){throw Error(/^DI_[A-Z_]+$/.test(e.message)?e.message:e.code==='EEXIST'?'DI_LOCKED':'DI_UNAVAILABLE');}
}
