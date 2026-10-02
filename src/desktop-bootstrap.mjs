import {mkdir,lstat,realpath,readFile} from 'node:fs/promises';
import {isAbsolute,join,dirname,resolve,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {atomicWrite} from './store.mjs';
import {validateModelRegistry,usesActiveGateway} from './model-registry.mjs';
import {createCredentialReader} from './router-credentials.mjs';
import {loadRouterConfig} from './router-service.mjs';
import {validateManagedOptions} from './managed-model-router.mjs';
import {validateModelBindings} from './model-registry-update.mjs';
const fail=code=>{throw Error(code);};
async function regular(path){const s=await lstat(path);if(!s.isFile()||s.isSymbolicLink())fail('DB_INVALID');return readFile(path,'utf8');}
// Trusted startup API only: never accepts renderer-selected filesystem paths.
export async function initializeDesktopData(dataRoot){
 if(typeof dataRoot!=='string'||!isAbsolute(dataRoot))fail('DB_PATH');
 let root,created=false;
 try{
  const parent=await realpath(dirname(resolve(dataRoot)));root=join(parent,basename(resolve(dataRoot)));
  try{await mkdir(root);created=true;}catch(e){if(e.code!=='EEXIST')throw e;}
  const info=await lstat(root);if(!info.isDirectory()||info.isSymbolicLink())fail('DB_PATH');
  const routerConfigPath=join(root,'config.json'),draftRoot=join(root,'drafts');
  const paths={modelRegistryPath:join(root,'models.json'),credentialConfigPath:join(root,'credentials.json'),bindingsPath:join(root,'bindings.json')};
  if(created){
   const adapterPath=fileURLToPath(new URL('./managed-model-router.mjs',import.meta.url));
   const config={adapterPath,adapterSha256:createHash('sha256').update(await readFile(adapterPath)).digest('hex'),registryPath:join(root,'workers.jsonl'),port:0,adapterOptions:{schemaVersion:1,...paths,ingressCredentialRef:'desktop-unconfigured',officialModels:[],port:0,officialProxyUrl:null}};
   await mkdir(draftRoot);
   for(const [path,value] of [[paths.modelRegistryPath,{schemaVersion:2,generation:1,suffix:'_self',activeProviderId:null,providers:[],models:[]}],[paths.credentialConfigPath,{schemaVersion:1,credentials:[]}],[paths.bindingsPath,[]],[routerConfigPath,config]])await atomicWrite(path,JSON.stringify(value,null,2)+'\n',true);
   await atomicWrite(join(root,'initialized.json'),'{"schemaVersion":1}\n',true);
  }
  let marker;try{marker=JSON.parse(await regular(join(root,'initialized.json')));}catch(e){if(e.code==='ENOENT')fail('DB_INCOMPLETE');throw e;}
  if(JSON.stringify(marker)!=='{"schemaVersion":1}')fail('DB_INVALID');
  await regular(routerConfigPath);
  const config=loadRouterConfig(routerConfigPath),options=validateManagedOptions(config.adapterOptions);
  if(Object.entries(paths).some(([key,value])=>options[key]!==value))fail('DB_INVALID');
  const registry=validateModelRegistry(JSON.parse(await regular(paths.modelRegistryPath)));
  createCredentialReader(JSON.parse(await regular(paths.credentialConfigPath)));
  const bindings=JSON.parse(await regular(paths.bindingsPath));if(!Array.isArray(bindings))fail('DB_INVALID');
  validateModelBindings(bindings,registry.models,usesActiveGateway(registry));
  const draftInfo=await lstat(draftRoot);if(!draftInfo.isDirectory()||draftInfo.isSymbolicLink())fail('DB_INVALID');
  return {created,host:{routerConfigPath,draftRoot}};
 }catch(e){throw Error(/^DB_[A-Z_]+$/.test(e.message)?e.message:'DB_INVALID');}
}
