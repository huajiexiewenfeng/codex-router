import { openSync, closeSync, fstatSync, readSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

const fail=code=>{throw new Error(code);};
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v,keys)=>object(v)&&Object.keys(v).length===keys.length&&Object.keys(v).every(k=>keys.includes(k));
const reference=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v)&&!/^(?:(?:sk|pk|rk)[_-]|(?:api[_-]?key|secret|token|bearer)(?:$|[_-]))/i.test(v);
const localPath=v=>typeof v==='string'&&/^[A-Za-z]:[\\/]/.test(v)&&!/[\u0000-\u001f\u007f]/.test(v)&&!v.slice(2).includes(':');
const script=fileURLToPath(new URL('../scripts/read-router-credential.ps1',import.meta.url));

// Local trusted configuration only. Never enumerate files or fall back to a
// default credential. Construction validates references without decrypting.
export function createCredentialReader(config){
 if(!exact(config,['schemaVersion','credentials'])||config.schemaVersion!==1||!Array.isArray(config.credentials))fail('RC_CONFIG');
 const entries=new Map(),paths=new Set();
 for(const entry of config.credentials){
  if(!exact(entry,['credentialRef','filePath'])||!reference(entry.credentialRef)||!localPath(entry.filePath)||entries.has(entry.credentialRef))fail('RC_CONFIG');
  const normalized=win32.normalize(entry.filePath),identity=normalized.toLowerCase();
  if(paths.has(identity))fail('RC_CONFIG');paths.add(identity);
  entries.set(entry.credentialRef,normalized);
 }
 return Object.freeze({read(credentialRef){
  if(!entries.has(credentialRef))fail('RC_REFERENCE');
  if(process.platform!=='win32')fail('RC_PLATFORM');
  let fd;
  try{
   fd=openSync(entries.get(credentialRef),'r');
   const stat=fstatSync(fd);if(!stat.isFile()||stat.size>131072)throw Error();
   const buffer=Buffer.alloc(131073);let size=0,read;
   while(size<buffer.length&&(read=readSync(fd,buffer,size,buffer.length-size,null))>0)size+=read;
   if(size>131072)throw Error();
   const ciphertext=buffer.subarray(0,size).toString('utf8').trim();
   if(!/^01000000d08c9ddf0115d1118c7a00c04fc297eb[0-9a-f]+$/i.test(ciphertext)||ciphertext.length%2!==0)throw Error();
   const systemRoot=process.env.SystemRoot;
   if(!localPath(systemRoot))throw Error();
   const token=execFileSync(win32.join(systemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),
    ['-NoProfile','-NonInteractive','-File',script],
    {input:ciphertext,encoding:'utf8',windowsHide:true,timeout:10000,maxBuffer:16384,stdio:['pipe','pipe','pipe']});
   if(!/^[\x21-\x7e]{1,8192}$/.test(token))throw Error();
   return token;
  }catch{fail('RC_UNAVAILABLE');}
  finally{if(fd!==undefined)try{closeSync(fd);}catch{/* no filesystem detail exposure */}}
 }});
}
