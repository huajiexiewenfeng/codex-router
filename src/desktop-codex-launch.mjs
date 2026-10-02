import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,lstat,realpath} from 'node:fs/promises';
import {join,dirname,isAbsolute} from 'node:path';
import {loadRouterConfig,routerStatus} from './router-service.mjs';
import {validateManagedOptions} from './managed-model-router.mjs';
import {createCredentialReader} from './router-credentials.mjs';
import {planDesktopProvider} from './desktop-provider-install.mjs';
import {withFileLocks} from './registry-projection.mjs';
const execute=promisify(execFile),fail=code=>{throw Error(code);};
async function regular(path){const s=await lstat(path);if(!s.isFile()||s.isSymbolicLink())fail('DCL_INPUT');return readFile(path,'utf8');}
async function isCodexRunning(){
 if(process.platform!=='win32'||!isAbsolute(process.env.SystemRoot??''))fail('DCL_PROCESS_CHECK_FAILED');
 const {stdout}=await execute(join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),
  ['-NoProfile','-NonInteractive','-Command',"$ErrorActionPreference='Stop'; [Console]::Write(@(Get-Process | Where-Object { $_.ProcessName -ieq 'codex' -or $_.ProcessName -ieq 'ChatGPT' }).Count)"],
  {windowsHide:true,timeout:10000,maxBuffer:1024});
 if(!/^\d+$/.test(stdout.trim()))fail('DCL_PROCESS_CHECK_FAILED');return Number(stdout.trim())>0;
}
async function noCodex(check){
 let active;try{active=await check();}catch{fail('DCL_PROCESS_CHECK_FAILED');}
 if(active===true)fail('DCL_CODEX_RUNNING');if(active!==false)fail('DCL_PROCESS_CHECK_FAILED');
}
function running(path,port){const s=routerStatus(path);
 if(s.kind!=='shared'||s.state!=='running'||s.registryHealthy!==true||s.stopRequested||s.port!==port||!port)fail('DCL_ROUTER_UNAVAILABLE');return s.runId;
}
// Trusted host API. Paths must come from installation discovery, never renderer
// requests. A spawned process is not proof of a new window or accepted environment.
export async function launchDesktopCodex(input,{isCodexRunning:checkRunning=isCodexRunning,spawnProcess=spawn}={}){
 try{
  if(!input||Object.keys(input).sort().join(',')!=='codexHome,desktopExecutable,routerConfigPath'||
   Object.values(input).some(v=>typeof v!=='string'||!isAbsolute(v)))fail('DCL_INPUT');
  const {routerConfigPath,codexHome,desktopExecutable}=input;
  const homeInfo=await lstat(codexHome),exeInfo=await lstat(desktopExecutable);
  if(!homeInfo.isDirectory()||homeInfo.isSymbolicLink()||!exeInfo.isFile()||exeInfo.isSymbolicLink()||!desktopExecutable.toLowerCase().endsWith('.exe'))fail('DCL_INPUT');
  const home=await realpath(codexHome),configPath=join(home,'config.toml');
  return await withFileLocks([join(home,'.router-codex-launch.lock')],async()=>{
   const routerBytes=await regular(routerConfigPath),config=loadRouterConfig(routerConfigPath),options=validateManagedOptions(config.adapterOptions);
   if(options.ingressCredentialRef!=='desktop-unconfigured'||options.port!==config.port)fail('DCL_ROUTER_UNAVAILABLE');
   const runId=running(routerConfigPath,config.port);
   let provider;try{provider=await planDesktopProvider(configPath,config.port);}catch{fail('DCL_PROVIDER_REQUIRED');}
   if(provider.status!=='already-installed')fail('DCL_PROVIDER_REQUIRED');
   await noCodex(checkRunning);
   let token,mappingBytes;
   try{
    mappingBytes=await regular(options.credentialConfigPath);
    token=createCredentialReader(JSON.parse(mappingBytes)).read(options.ingressCredentialRef);
    if(!/^[a-f0-9]{64}$/.test(token))throw Error();
   }catch{fail('DCL_CREDENTIAL_UNAVAILABLE');}
   await noCodex(checkRunning);
   if(await regular(routerConfigPath)!==routerBytes||await regular(options.credentialConfigPath)!==mappingBytes||
    running(routerConfigPath,config.port)!==runId)fail('DCL_CONFIG_CHANGED');
   if((await planDesktopProvider(configPath,config.port)).beforeSha256!==provider.beforeSha256)fail('DCL_CONFIG_CHANGED');
   const env={...process.env};
   for(const key of Object.keys(env))if(['CODEX_HOME','CODEX_ROUTER_DESKTOP_INGRESS'].includes(key.toUpperCase()))delete env[key];
   env.CODEX_HOME=home;env.CODEX_ROUTER_DESKTOP_INGRESS=token;
   await new Promise((resolve,reject)=>{
    try{
     const child=spawnProcess(desktopExecutable,[],{cwd:dirname(desktopExecutable),env,shell:false,windowsHide:true,detached:true,stdio:'ignore'});
     child.once('error',()=>reject(Error('DCL_SPAWN_FAILED')));
     child.once('spawn',()=>{child.unref();resolve();});
    }catch{reject(Error('DCL_SPAWN_FAILED'));}
   });
   return {status:'spawned',nativeVerified:false};
  });
 }catch(e){throw Error(/^DCL_[A-Z_]+$/.test(e.message)?e.message:e.code==='EEXIST'?'DCL_LOCKED':'DCL_UNAVAILABLE');}
}
