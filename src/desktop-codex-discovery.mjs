import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {lstat,realpath} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute,sep,dirname} from 'node:path';
const execute=promisify(execFile),fail=code=>{throw Error(code);};
async function queryPackages(){
 if(process.platform!=='win32'||!isAbsolute(process.env.SystemRoot??''))fail('DCD_UNAVAILABLE');
 const script=`$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $items=@(Get-AppxPackage -Name OpenAI.Codex | ForEach-Object { $pkg=$_; [xml]$m=Get-Content -LiteralPath (Join-Path $pkg.InstallLocation 'AppxManifest.xml') -Raw; $m.Package.Applications.Application | Where-Object { $_.Id -eq 'App' } | ForEach-Object { [pscustomobject]@{installLocation=$pkg.InstallLocation;executable=[string]$_.Executable} } }); [Console]::Write((ConvertTo-Json -InputObject $items -Compress))`;
 const {stdout}=await execute(join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:10000,maxBuffer:65536,encoding:'utf8'});
 return JSON.parse(stdout);
}
function contained(root,path){const r=relative(root,path);return r!==''&&!isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+sep);}
// Host-only, read-only. Supports the registered Store installation; other layouts
// need explicit installation support, never PATH-based guesses at a backend CLI.
export async function discoverDesktopCodex({codexHome=process.env.CODEX_HOME??(process.env.USERPROFILE?join(process.env.USERPROFILE,'.codex'):undefined),queryPackages:query=queryPackages}={}){
 try{
  if(typeof codexHome!=='string'||!isAbsolute(codexHome))fail('DCD_HOME_UNAVAILABLE');
  const homeInfo=await lstat(codexHome);if(!homeInfo.isDirectory()||homeInfo.isSymbolicLink())fail('DCD_HOME_UNAVAILABLE');
  const records=await query();if(!Array.isArray(records)||records.length!==1)fail('DCD_INSTALLATION_AMBIGUOUS');
  const record=records[0];
  if(!record||typeof record.installLocation!=='string'||!isAbsolute(record.installLocation)||typeof record.executable!=='string'||
   isAbsolute(record.executable)||/[:\x00-\x1f]/.test(record.executable)||!record.executable.toLowerCase().endsWith('.exe'))fail('DCD_INSTALLATION_INVALID');
  const root=resolve(record.installLocation),exe=resolve(root,record.executable);
  if(!contained(root,exe))fail('DCD_INSTALLATION_INVALID');
  const rootInfo=await lstat(root),exeInfo=await lstat(exe);
  if(!rootInfo.isDirectory()||rootInfo.isSymbolicLink()||!exeInfo.isFile()||exeInfo.isSymbolicLink())fail('DCD_INSTALLATION_INVALID');
  const canonicalRoot=await realpath(root),canonicalExe=await realpath(exe);
  if(!contained(canonicalRoot,canonicalExe))fail('DCD_INSTALLATION_INVALID');
  return {codexHome:await realpath(codexHome),desktopExecutable:canonicalExe};
 }catch(e){throw Error(/^DCD_[A-Z_]+$/.test(e.message)?e.message:'DCD_UNAVAILABLE');}
}

// Separate from the GUI executable: only the CLI shipped by the registered
// desktop package is eligible. Missing layouts never fall back to PATH.
export async function discoverDesktopBackend(options={}){
 const desktop=await discoverDesktopCodex(options);
 try{
  const app=dirname(desktop.desktopExecutable),resources=join(app,'resources'),exe=join(resources,'codex.exe');
  const resourceInfo=await lstat(resources),info=await lstat(exe);
  if(!resourceInfo.isDirectory()||resourceInfo.isSymbolicLink()||!info.isFile()||info.isSymbolicLink())throw Error();
  const canonical=await realpath(exe);
  if(!contained(app,canonical))throw Error();
  return {...desktop,codexExecutable:canonical};
 }catch{throw Error('DCD_BACKEND_UNAVAILABLE');}
}
