import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {lstat,realpath} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {safeModelId} from './model-registry.mjs';
const execute=promisify(execFile),fail=code=>{throw Error(code);};
export function validateOfficialModels(models){
 if(!Array.isArray(models)||!models.length)fail('DOC_MODELS');
 const ids=new Set();
 for(const model of models){
  if(!model||typeof model!=='object'||Array.isArray(model)||!safeModelId(model.slug)||model.slug.endsWith('_self')||ids.has(model.slug))fail('DOC_MODELS');
  ids.add(model.slug);
 }
 return structuredClone(models);
}
// Host-only API: executable must come from successful trusted installation discovery,
// never from renderer input, PATH search, shell commands or a custom model catalog.
export async function readBundledOfficialModels({codexExecutable,execFileImpl=execute}){
 let executable;
 try{
  if(typeof codexExecutable!=='string'||!isAbsolute(codexExecutable))fail('DOC_EXECUTABLE');
  const stat=await lstat(codexExecutable);
  if(!stat.isFile()||stat.isSymbolicLink())fail('DOC_EXECUTABLE');
  executable=await realpath(codexExecutable);
 }catch{fail('DOC_EXECUTABLE');}
 let stdout;
 try{
  ({stdout}=await execFileImpl(executable,['debug','models','--bundled'],{windowsHide:true,shell:false,timeout:15_000,maxBuffer:16*1024*1024,encoding:'utf8'}));
 }catch{fail('DOC_UNAVAILABLE');}
 try{
  const parsed=JSON.parse(stdout);
  return validateOfficialModels(Array.isArray(parsed)?parsed:parsed.models);
 }catch{fail('DOC_MODELS');}
}
