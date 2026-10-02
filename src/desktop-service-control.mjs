import {lstat} from 'node:fs/promises';
import {loadRouterConfig,routerStatus,startRouter,stopRouter} from './router-service.mjs';
import {initializeRouterRegistry,readRouterRegistry} from './router-registry.mjs';
import {withFileLocks} from './registry-projection.mjs';
import {requestDiagnostics} from './router-request-diagnostics.mjs';
const fail=code=>{throw Error(code);};

export function desktopServiceSnapshot(configPath){
 const status=routerStatus(configPath);
 const unhealthy=status.state==='running'&&status.kind==='shared'&&status.registryHealthy!==true;
 return {ok:true,state:unhealthy?'unknown':status.state==='running'&&status.stopRequested?'stopping':status.state,
  canStop:status.kind==='shared'&&status.state==='running'&&!status.stopRequested,
  checkedAt:Date.now(),scope:'local-heartbeat-only',requests:requestDiagnostics(loadRouterConfig(configPath),status)};
}

// Host-only paths. The child alone acquires service ownership. Never recover a lock.
export async function controlDesktopService(configPath,operation,checkConfig){
 return withFileLocks([configPath+'.desktop-control.lock'],async()=>{
  await checkConfig();
  const config=loadRouterConfig(configPath);
  if(!config.registryPath)fail('DESKTOP_SERVICE_DISABLED');
  const status=routerStatus(configPath);
  if(operation==='router-stop'){
   if(status.state!=='running')fail('DESKTOP_SERVICE_NOT_RUNNING');
   if(!status.stopRequested)stopRouter(configPath);
   return {...desktopServiceSnapshot(configPath),action:'stop-requested'};
  }
  if(status.state==='running'&&status.registryHealthy===true&&!status.stopRequested){
   readRouterRegistry(config.registryPath);
   return {...desktopServiceSnapshot(configPath),action:'reused'};
  }
  if(!['not_started','stopped'].includes(status.state)||status.lockPresent||status.active||status.stopRequested)fail('DESKTOP_SERVICE_NOT_STARTABLE');
  await withFileLocks([config.registryPath+'.mutation.lock'],async()=>{
   let missing=false;
   try{const s=await lstat(config.registryPath);if(!s.isFile()||s.isSymbolicLink())fail('ROUTER_REGISTRY_INVALID');}
   catch(e){if(e.code==='ENOENT')missing=true;else throw e;}
   if(missing)initializeRouterRegistry(config.registryPath);
   readRouterRegistry(config.registryPath);
   await checkConfig();
   await startRouter(configPath);
  });
  return {...desktopServiceSnapshot(configPath),action:'started'};
 });
}
