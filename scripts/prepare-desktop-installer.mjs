import {mkdir,writeFile} from 'node:fs/promises';
import {join,isAbsolute,resolve,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {prepareDesktopRuntime} from './prepare-desktop-runtime.mjs';

// Explicit local developer packaging. Does not install, launch, or publish.
export async function prepareDesktopInstaller({destination,nodePath,nodeSha256}){
 if(process.platform!=='win32'||!isAbsolute(destination))throw Error('DI_INPUT');
 const tauriRoot=fileURLToPath(new URL('../apps/router-desktop/src-tauri/',import.meta.url));
 const runtime=join(destination,'runtime'),resource=relative(tauriRoot,runtime);
 // tauri-utils 2.9.3 strips Windows drive prefixes; use same-volume relative paths.
 if(isAbsolute(resource))throw Error('DI_RESOURCE_VOLUME');
 try{await mkdir(destination);}catch(e){if(e.code==='EEXIST')throw Error('DI_DESTINATION_EXISTS');throw e;}
 await prepareDesktopRuntime({destination:runtime,nodePath,nodeSha256});
 const config={bundle:{active:true,targets:['nsis'],resources:{[resource.replaceAll('\\','/')+'/']:'runtime/'},windows:{nsis:{installMode:'currentUser',languages:['English'],customLanguageFiles:{English:'installer/English.nsh'}},webviewInstallMode:{type:'downloadBootstrapper',silent:true}}}};
 const configPath=join(destination,'tauri.installer.json');
 await writeFile(configPath,JSON.stringify(config,null,2)+'\n',{flag:'wx'});
 return {configPath,distributable:false};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  if(process.argv.length!==5)throw Error('DI_USAGE');
  console.log(JSON.stringify(await prepareDesktopInstaller({destination:process.argv[2],nodePath:process.argv[3],nodeSha256:process.argv[4]})));
 }catch(e){console.error(/^(DI|DR)_[A-Z_]+$/.test(e.message)?e.message:'DI_BUILD_FAILED');process.exitCode=1;}
}
