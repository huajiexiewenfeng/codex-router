import { execFileSync } from 'node:child_process';
import { win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCredentialReader } from './router-credentials.mjs';
const fail=code=>{throw new Error(code);};
const script=fileURLToPath(new URL('../scripts/manage-router-credential.ps1',import.meta.url));
const safe=new Set(['RC_EXISTS','RC_CONFLICT','RC_LOCKED','RC_PERMISSIONS','RC_UNAVAILABLE']);
export function manageCredential(config,request){
 createCredentialReader(config); // validate without reading/decrypting
 if(!request||typeof request!=='object'||Array.isArray(request)||!['create','replace','delete'].includes(request.operation))fail('RC_REQUEST');
 const keys=['operation','credentialRef',...(request.operation==='delete'?[]:['secret']),...(request.operation==='create'?[]:['expectedSha256'])];
 if(Object.keys(request).sort().join(',')!==keys.sort().join(',')||typeof request.credentialRef!=='string'||(request.operation!=='delete'&&(typeof request.secret!=='string'||!/^[\x21-\x7e]{1,8192}$/.test(request.secret)))||(request.operation!=='create'&&!/^[a-f0-9]{64}$/.test(request.expectedSha256??'')))fail('RC_REQUEST');
 const entry=config.credentials.find(c=>c.credentialRef===request.credentialRef);if(!entry)fail('RC_REFERENCE');
 if(process.platform!=='win32')fail('RC_PLATFORM');
 try{
  const result=execFileSync(win32.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-File',script],{input:JSON.stringify({...request,filePath:win32.normalize(entry.filePath)}),encoding:'utf8',windowsHide:true,timeout:10000,maxBuffer:4096,stdio:['pipe','pipe','pipe']});
  const value=JSON.parse(result);
  if(!['created','replaced','deleted'].includes(value.status))throw Error();
  return value;
 }catch(error){const code=typeof error.stderr==='string'?error.stderr.trim():'';fail(safe.has(code)?code:'RC_UNAVAILABLE');}
}
