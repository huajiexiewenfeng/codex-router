import {openSync,closeSync,writeSync,fsyncSync,readFileSync,unlinkSync,realpathSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {readBudget} from './router-budget.mjs';
const fail=code=>{throw new Error(code);};
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
function append(fd,value) {
  const bytes=Buffer.from(JSON.stringify(value)+'\n');let offset=0;
  while(offset<bytes.length){const n=writeSync(fd,bytes,offset,bytes.length-offset);if(n<=0)fail('ROUTER_REGISTRY_WRITE_FAILED');offset+=n;}
  fsyncSync(fd);
}
export function initializeRouterRegistry(path) {
  let fd;
  try{fd=openSync(path,'wx',0o600);append(fd,{schemaVersion:1});}
  catch(e){fail(e.code==='EEXIST'?'ROUTER_REGISTRY_EXISTS':'ROUTER_REGISTRY_WRITE_FAILED');}
  finally{if(fd!==undefined)closeSync(fd);}
}
export function readRouterRegistry(path) {
  try {
    const raw=readFileSync(path,'utf8');
    if(raw.length>1024*1024||!raw.endsWith('\n'))throw Error();
    const [header,...bindings]=raw.trimEnd().split('\n').map(JSON.parse);
    if(JSON.stringify(header)!=='{"schemaVersion":1}'||bindings.length>32)throw Error();
    const ids=new Set(),paths=new Set();
    for(const b of bindings){
      if(Object.keys(b).sort().join(',')!=='budgetPath,threadId'||typeof b.threadId!=='string'||!uuid.test(b.threadId)||
        typeof b.budgetPath!=='string'||!isAbsolute(b.budgetPath)||ids.has(b.threadId)||paths.has(b.budgetPath))throw Error();
      ids.add(b.threadId);paths.add(b.budgetPath);
    }
    return {schemaVersion:1,bindings};
  }catch{fail('ROUTER_REGISTRY_INVALID');}
}
export function registerRouterBudget(path,budgetPath) {
  // Local services must not retain SMB handles to their own machine's ledger.
  // Do not silently rewrite paths: the registering host may have a virtualized C:.
  if(process.platform==='win32'&&typeof budgetPath==='string'&&/^[\\/]{2}(?:localhost|127\.0\.0\.1)[\\/][a-z]\$[\\/]/i.test(budgetPath))fail('BUDGET_LOCAL_PATH_REQUIRED');
  let lock,fd;
  try{lock=openSync(path+'.mutation.lock','wx',0o600);}
  catch(e){fail(e.code==='EEXIST'?'ROUTER_REGISTRY_LOCKED':'ROUTER_REGISTRY_WRITE_FAILED');}
  try {
    const registry=readRouterRegistry(path);
    let canonical;try{if(!isAbsolute(budgetPath))throw Error();canonical=realpathSync(budgetPath);}catch{fail('BUDGET_UNAVAILABLE');}
    const grant=readBudget(canonical),prior=registry.bindings.find(b=>b.threadId===grant.threadId);
    if(prior){if(prior.budgetPath!==canonical)fail('ROUTER_BINDING_EXISTS');return registry;}
    if(registry.bindings.length>=32)fail('ROUTER_REGISTRY_FULL');
    if(grant.remaining===0)fail('BUDGET_EXHAUSTED');
    if(grant.expiresAt!==null&&Date.now()>=grant.expiresAt)fail('BUDGET_EXPIRED');
    const binding={threadId:grant.threadId,budgetPath:canonical};
    fd=openSync(path,'a');append(fd,binding);
    return {schemaVersion:1,bindings:[...registry.bindings,binding]};
  }finally{if(fd!==undefined)closeSync(fd);closeSync(lock);unlinkSync(path+'.mutation.lock');}
}
