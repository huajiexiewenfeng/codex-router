import {mkdir,lstat,readFile,realpath} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
import {discoverDesktopBackend} from './desktop-codex-discovery.mjs';
import {createDesktopWorkerJobs} from './desktop-worker-jobs.mjs';
import {connectAppServer} from './app-server-client.mjs';
import {loadRouterConfig,routerStatus} from './router-service.mjs';
import {validateManagedOptions} from './managed-model-router.mjs';
import {planDesktopProvider} from './desktop-provider-install.mjs';
import {createCredentialReader} from './router-credentials.mjs';

const fail=code=>{throw Error(code);};
async function readIngress(options){
 return createCredentialReader(JSON.parse(await readFile(options.credentialConfigPath,'utf8'))).read(options.ingressCredentialRef);
}
// Only the bundled host calls this factory. The renderer supplies no executable,
// home, environment or credentials. No service launch or native task at startup.
export async function createDesktopWorkerHost({routerConfigPath,jobRoot},deps={}){
 let native;
 try{
  if(!isAbsolute(routerConfigPath)||!isAbsolute(jobRoot))throw Error();
  native=await (deps.discover??discoverDesktopBackend)();
  if(!isAbsolute(native.codexHome)||!isAbsolute(native.codexExecutable))throw Error();
  await mkdir(jobRoot,{recursive:true});
  const info=await lstat(jobRoot);if(!info.isDirectory()||info.isSymbolicLink())throw Error();
  jobRoot=await realpath(jobRoot);
 }catch{fail('DW_HOST');}
 async function settings(){
  try{
   const config=loadRouterConfig(routerConfigPath),options=validateManagedOptions(config.adapterOptions);
   const status=(deps.readStatus??routerStatus)(routerConfigPath);
   if(status.kind!=='shared'||status.state!=='running'||status.registryHealthy!==true||status.stopRequested||
    !config.port||config.port!==options.port||config.port!==status.port)fail('DW_NOT_READY');
   const provider=await planDesktopProvider(join(native.codexHome,'config.toml'),config.port);
   if(provider.status!=='already-installed')fail('DW_NOT_READY');
   return {config,options};
  }catch{fail('DW_NOT_READY');}
 }
 const connect=async(executable,selection)=>{
  if(executable!==native.codexExecutable||selection?.codexHome!==native.codexHome)fail('DW_HOST');
  const {config,options}=await settings();
  let ingressToken;
  try{ingressToken=await (deps.readIngress??readIngress)(options);if(!/^[a-f0-9]{64}$/.test(ingressToken))throw Error();}
  catch{fail('DW_NOT_READY');}
  return (deps.connect??connectAppServer)(executable,{codexHome:native.codexHome,router:{port:config.port,ingressToken},timeoutMs:10000,turnTimeoutMs:180000});
 };
 return createDesktopWorkerJobs({jobRoot,makeRequest:async input=>{
  await settings();
  return {...input,hostId:'local',mode:'router',codexExecutable:native.codexExecutable,codexHome:native.codexHome,
   receiptDirectory:jobRoot,routerConfigPath,provider:'codex_router_desktop',initialization:{authorized:true}};
 }},{...(deps.plan?{plan:deps.plan}:{}),...(deps.create?{create:deps.create}:{}),workerDeps:{connect,...(deps.readStatus?{routerStatus:deps.readStatus}:{})}});
}
