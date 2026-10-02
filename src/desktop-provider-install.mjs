import {readFile,lstat,realpath} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {parse,stringify} from 'smol-toml';
import {atomicWrite} from './store.mjs';
import {withFileLocks} from './registry-projection.mjs';
const id='codex_router_desktop';
const fail=code=>{throw Error(code);};
const hash=value=>createHash('sha256').update(value).digest('hex');
const safe=e=>Error(/^DPI_[A-Z_]+$/.test(e.message)?e.message:e.code==='EEXIST'?'DPI_LOCKED':'DPI_UNAVAILABLE');
async function regular(path){
 const s=await lstat(path);if(!s.isFile()||s.isSymbolicLink()||s.size>1048576)fail('DPI_CONFIG_INVALID');
 const bytes=await readFile(path);
 try{return {bytes,text:new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes)};}catch{fail('DPI_CONFIG_INVALID');}
}
function draft(text,port){
 if(!Number.isInteger(port)||port<1||port>65535)fail('DPI_INPUT');
 let original;try{original=structuredClone(parse(text));}catch{fail('DPI_CONFIG_INVALID');}
 const provider={name:'Codex Router Desktop',base_url:`http://127.0.0.1:${port}/v1`,wire_api:'responses',
  requires_openai_auth:true,supports_websockets:false,request_max_retries:0,stream_max_retries:0,
  env_http_headers:{'X-Worker-Router-Token':'CODEX_ROUTER_DESKTOP_INGRESS'}};
 const providers=original.model_providers;
 if(providers!==undefined&&(!providers||typeof providers!=='object'||Array.isArray(providers)))fail('DPI_CONFLICT');
 if(providers&&Object.hasOwn(providers,id)){
  if(!isDeepStrictEqual(providers[id],provider))fail('DPI_CONFLICT');
  return {text,status:'already-installed'};
 }
 const next=text+'\n# Codex Router Desktop provider\n'+stringify({model_providers:{[id]:provider}});
 // Reparse the whole document: inline-table sealing and multiline syntax cannot
 // silently absorb the appended section or alter unrelated configuration.
 let parsed;try{parsed=structuredClone(parse(next));}catch{fail('DPI_CONFLICT');}
 if(!isDeepStrictEqual(parsed,{...original,model_providers:{...providers,[id]:provider}}))fail('DPI_CONFLICT');
 return {text:next,status:'ready'};
}
async function inspect(path,port){
 if(typeof path!=='string'||!isAbsolute(path))fail('DPI_INPUT');
 const source=await regular(path),result=draft(source.text,port);
 return {...source,next:result.text,plan:{schemaVersion:1,port,status:result.status,beforeSha256:hash(source.bytes),afterSha256:hash(result.text)}};
}
// Trusted installation API only. No renderer-supplied paths or credential fields.
export async function planDesktopProvider(path,port){try{return (await inspect(path,port)).plan;}catch(e){throw safe(e);}}
export async function applyDesktopProvider(path,plan){
 try{
  if(typeof path!=='string'||!isAbsolute(path)||!plan||typeof plan!=='object')fail('DPI_INPUT');
  await regular(path);const canonical=await realpath(path);
  return await withFileLocks([canonical+'.router-provider.lock'],async()=>{
   const current=await inspect(canonical,plan.port);
   if(!isDeepStrictEqual(current.plan,plan))fail('DPI_STALE');
   if(plan.status==='already-installed')return {status:'already-installed'};
   const backupPath=canonical+'.codex-router.'+plan.beforeSha256+'.bak';
   try{await atomicWrite(backupPath,current.text,true);}catch(e){
    if(e.code!=='EEXIST')throw e;
    if(!(await regular(backupPath)).bytes.equals(current.bytes))fail('DPI_BACKUP_CONFLICT');
   }
   if(!(await regular(canonical)).bytes.equals(current.bytes))fail('DPI_STALE');
   await atomicWrite(canonical,current.next);
   return {status:'installed',backupPath,beforeSha256:plan.beforeSha256,afterSha256:plan.afterSha256};
  });
 }catch(e){throw safe(e);}
}
