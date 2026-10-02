import {readFile,lstat,realpath,mkdtemp} from 'node:fs/promises';
import {join,dirname,basename,resolve,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {loadRouterConfig,routerStatus} from './router-service.mjs';
import {validateManagedOptions} from './managed-model-router.mjs';
import {validateModelRegistry,usesActiveGateway} from './model-registry.mjs';
import {validateModelBindings,planModelRegistryUpdate} from './model-registry-update.mjs';
import {createCredentialReader} from './router-credentials.mjs';
import {withFileLocks} from './registry-projection.mjs';
import {atomicWrite} from './store.mjs';
const fail=code=>{throw Error(code);};
const hash=b=>createHash('sha256').update(b).digest('hex');
async function regular(path){const s=await lstat(path);if(!s.isFile()||s.isSymbolicLink())fail('DU_FILE_INVALID');return readFile(path);}
async function optional(path){try{return await regular(path);}catch(e){if(e.code==='ENOENT')return null;throw e;}}
const equal=(a,b)=>a===null?b===null:b!==null&&a.equals(b);

// Integrity check, not a publisher signature. runtimeRoot is a trusted host path,
// never a renderer field. Existing user configuration/credentials are not bundled.
async function packageAdapter(runtimeRoot){
 try{
  if(!isAbsolute(runtimeRoot))fail('DU_PACKAGE_INVALID');
  const root=await realpath(runtimeRoot),manifest=JSON.parse(await regular(join(root,'runtime-manifest.json')));
  if(manifest.schemaVersion!==1||!manifest.files||Array.isArray(manifest.files))fail('DU_PACKAGE_INVALID');
  for(const name of ['node.exe','src/managed-model-router.mjs','src/desktop-stdio.mjs'])if(!manifest.files[name])fail('DU_PACKAGE_INVALID');
  for(const [name,expected] of Object.entries(manifest.files)){
   const parts=name.split('/');
   if(parts.some(p=>!p||p==='.'||p==='..'||!/^[a-zA-Z0-9_.@-]+$/.test(p))||!/^[a-f0-9]{64}$/.test(expected))fail('DU_PACKAGE_INVALID');
   let path=root;
   for(const part of parts){path=join(path,part);if((await lstat(path)).isSymbolicLink())fail('DU_PACKAGE_INVALID');}
   if(hash(await regular(path))!==expected)fail('DU_PACKAGE_INVALID');
  }
  return {adapterPath:join(root,'src/managed-model-router.mjs'),adapterSha256:manifest.files['src/managed-model-router.mjs']};
 }catch{fail('DU_PACKAGE_INVALID');}
}

// Only the desktop-owned data layout is eligible. No adapter code is executed.
export async function upgradeDesktopRuntime(configPath,runtimeRoot,{expectedConfigIdentity}={}){
 try{
  const target=await packageAdapter(runtimeRoot);
  const root=dirname(configPath),initial=loadRouterConfig(configPath),options=validateManagedOptions(initial.adapterOptions);
  if(basename(configPath)!=='config.json'||basename(initial.adapterPath)!=='managed-model-router.mjs'||
    initial.registryPath!==join(root,'workers.jsonl')||
    Object.entries({modelRegistryPath:'models.json',bindingsPath:'bindings.json',credentialConfigPath:'credentials.json'}).some(([k,n])=>options[k]!==join(root,n))||
    (await regular(join(root,'initialized.json'))).toString().trim()!=='{"schemaVersion":1}')fail('DU_CONFIG_UNSUPPORTED');
  const modelPath=options.modelRegistryPath,bindingPath=options.bindingsPath,credentialPath=options.credentialConfigPath;
  return await withFileLocks([configPath+'.desktop-control.lock',modelPath+'.model-update.lock',bindingPath+'.lock',credentialPath+'.lock',initial.registryPath+'.mutation.lock'],async()=>{
   const configBefore=await regular(configPath),config=loadRouterConfig(configPath);
   if(JSON.stringify(config)!==JSON.stringify(initial)||(expectedConfigIdentity!==undefined&&JSON.stringify(config)!==expectedConfigIdentity))fail('DU_CONFIG_CHANGED');
   const modelsBefore=await regular(modelPath),registry=validateModelRegistry(JSON.parse(modelsBefore));
   if(registry.schemaVersion!==2)fail('DU_CONFIG_UNSUPPORTED');
   const bindingsBefore=await regular(bindingPath),credentialsBefore=await regular(credentialPath);
   const bindings=JSON.parse(bindingsBefore);validateModelBindings(bindings,registry.models,usesActiveGateway(registry));createCredentialReader(JSON.parse(credentialsBefore));
   const configChanged=resolve(config.adapterPath)!==resolve(target.adapterPath)||config.adapterSha256!==target.adapterSha256;
   const migrate=!usesActiveGateway(registry);
   if(!configChanged&&!migrate)return {status:'current',activeProviderId:registry.activeProviderId,backupSaved:false};
   const status=routerStatus(configPath);
   if(!['stopped','not_started'].includes(status.state)||status.lockPresent||status.active||status.stopRequested)return {status:'pending-stop',backupSaved:false};
   const statusPath=initial.registryPath+'.status.json',statusBefore=await optional(statusPath);
   // A direct CLI start must also be excluded, not only GUI operations.
   return withFileLocks([initial.registryPath+'.service.lock'],async()=>{
    const candidate=structuredClone(registry);
    if(migrate){candidate.activeProviderId=candidate.providers.length===1?candidate.providers[0].id:null;candidate.generation++;}
    if(migrate&&planModelRegistryUpdate(registry,candidate,bindings).status!=='compatible')fail('DU_CONFIG_UNSUPPORTED');
    const nextConfig={...config,...target},configAfter=JSON.stringify(nextConfig,null,2)+'\n';
    const modelsAfter=migrate?JSON.stringify(candidate,null,2)+'\n':modelsBefore.toString('utf8');
    const unchanged=async()=>{
     for(const [path,before] of [[configPath,configBefore],[modelPath,modelsBefore],[bindingPath,bindingsBefore],[credentialPath,credentialsBefore],[statusPath,statusBefore]])if(!equal(before,await optional(path)))fail('DU_CONFIG_CHANGED');
    };
    await unchanged();
    const backup=await mkdtemp(join(root,'runtime-upgrade-backup-'));
    await atomicWrite(join(backup,'config.json'),configBefore.toString('utf8'),true);
    await atomicWrite(join(backup,'models.json'),modelsBefore.toString('utf8'),true);
    await atomicWrite(join(backup,'receipt.json'),JSON.stringify({schemaVersion:1,configSha256:hash(configBefore),modelsSha256:hash(modelsBefore),adapterSha256:target.adapterSha256,createdAt:new Date().toISOString()})+'\n',true);
    await unchanged();
    // New adapter supports legacy registry. If the process dies between files,
    // the next stopped startup safely completes migration; no model call occurs.
    if(configChanged)await atomicWrite(configPath,configAfter);
    try{if(migrate)await atomicWrite(modelPath,modelsAfter);}
    catch(e){if(configChanged&&(await regular(configPath)).toString('utf8')===configAfter)await atomicWrite(configPath,configBefore.toString('utf8'));throw e;}
    return {status:'updated',activeProviderId:candidate.activeProviderId,backupSaved:true,configIdentity:JSON.stringify(nextConfig)};
   });
  });
 }catch(e){throw Error(e.code==='EEXIST'?'DU_LOCKED':/^DU_[A-Z_]+$/.test(e.message)?e.message:'DU_UPGRADE_FAILED');}
}
