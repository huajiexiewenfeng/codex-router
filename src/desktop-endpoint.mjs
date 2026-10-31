import {readFile,lstat,realpath} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {createServer} from 'node:net';
import {loadRouterConfig,routerStatus} from './router-service.mjs';
import {validateManagedOptions} from './managed-model-router.mjs';
import {readRouterRegistry} from './router-registry.mjs';
import {withFileLocks} from './registry-projection.mjs';
import {atomicWrite} from './store.mjs';
const fail=code=>{throw Error(code);};
async function regular(path){const s=await lstat(path);if(!s.isFile()||s.isSymbolicLink())fail('DE_CONFIG_INVALID');return readFile(path,'utf8');}
function requireStopped(path){const s=routerStatus(path);if(!['not_started','stopped'].includes(s.state)||s.lockPresent||s.active||s.stopRequested)fail('DE_SERVICE_ACTIVE');}
async function selectPort(){
 // Choose once below the default Windows ephemeral range (49152-65535).
 // A saved endpoint is never silently changed: existing Workers depend on it.
 for(let port=29080;port<=29179;port++){
  const server=createServer();
  try{
   await new Promise((yes,no)=>{server.once('error',no);server.listen({port,host:'127.0.0.1',exclusive:true},yes);});
   return port;
  }catch(e){if(!['EADDRINUSE','EACCES'].includes(e.code))throw e;}
  finally{if(server.listening)await new Promise((yes,no)=>server.close(e=>e?no(e):yes()));}
 }
 fail('DE_PORT_UNAVAILABLE');
}

// Trusted host API only. Does not start a service, register Workers, or edit Codex.
// Caller must refresh its identity after changed=true; adopt only the expected port edit.
export async function prepareDesktopEndpoint(configPath,{expectedConfigIdentity}={}){
 try{
  if(typeof configPath!=='string'||!isAbsolute(configPath))fail('DE_CONFIG_INVALID');
  await regular(configPath);const path=await realpath(configPath);
  return await withFileLocks([path+'.desktop-control.lock'],async()=>{
   const before=await regular(path),config=loadRouterConfig(path);
   if(expectedConfigIdentity!==undefined&&JSON.stringify(config)!==expectedConfigIdentity)fail('DE_CONFIG_CHANGED');
   const options=validateManagedOptions(config.adapterOptions);
   if(!config.registryPath||config.port!==options.port)fail('DE_CONFIG_INVALID');
   requireStopped(path);
   const result=(port,changed)=>({port,baseUrl:`http://127.0.0.1:${port}/v1`,changed});
   if(config.port!==0)return result(config.port,false);
   return withFileLocks([config.registryPath+'.mutation.lock',options.bindingsPath+'.lock'],async()=>{
    let registryExists=true;
    try{await regular(config.registryPath);}catch(e){if(e.code==='ENOENT')registryExists=false;else fail('DE_REGISTRY_INVALID');}
    if(registryExists){
     let registry;try{registry=readRouterRegistry(config.registryPath);}catch{fail('DE_REGISTRY_INVALID');}
     if(registry.bindings.length)fail('DE_BINDINGS_PRESENT');
    }
    const bindings=JSON.parse(await regular(options.bindingsPath));
    if(!Array.isArray(bindings))fail('DE_CONFIG_INVALID');
    if(bindings.length)fail('DE_BINDINGS_PRESENT');
    const port=await selectPort();
    requireStopped(path);
    if(await regular(path)!==before)fail('DE_CONFIG_CHANGED');
    const next={...config,port,adapterOptions:{...config.adapterOptions,port}};
    await atomicWrite(path,JSON.stringify(next,null,2)+'\n');
    return result(port,true);
   });
  });
 }catch(e){throw Error(/^DE_[A-Z_]+$/.test(e.message)?e.message:e.code==='EEXIST'?'DE_LOCKED':'DE_PREPARE_FAILED');}
}
