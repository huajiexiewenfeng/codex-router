import { openSync, closeSync, writeSync, fsyncSync, readFileSync, unlinkSync } from 'node:fs';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const fail = code => { throw new Error(code); };
function validExtension(a,g,at){
  return a&&Object.keys(a).sort().join(',')==='additionalRequests,expectedMaxRequests,expectedUsedRequests,expiresAt,operationId,threadId'&&
    typeof a.operationId==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(a.operationId)&&a.threadId===g.threadId&&
    a.expectedMaxRequests===g.maxRequests&&a.expectedUsedRequests===g.usedRequests&&
    Number.isSafeInteger(a.additionalRequests)&&a.additionalRequests>=0&&g.maxRequests+a.additionalRequests<=100&&
    Number.isSafeInteger(at)&&at>=0&&Number.isSafeInteger(a.expiresAt)&&a.expiresAt>at&&a.expiresAt>g.expiresAt&&a.expiresAt-at<=7_200_000;
}
function validGrant(g) {
  return g && Object.keys(g).sort().join(',') === 'expiresAt,maxRequests,threadId,usedRequests' &&
    UUID.test(g.threadId) && Number.isSafeInteger(g.usedRequests) && g.usedRequests >= 0 &&
    ((g.maxRequests===null&&g.expiresAt===null)||
      (Number.isSafeInteger(g.maxRequests)&&g.maxRequests>0&&g.maxRequests<=100&&g.usedRequests<=g.maxRequests&&
       Number.isSafeInteger(g.expiresAt)&&g.expiresAt>0));
}
const snapshotOf=g=>({...g,remaining:g.maxRequests===null?null:g.maxRequests-g.usedRequests});
const validMigration=(a,g)=>a&&Object.keys(a).sort().join(',')==='expectedUsedRequests,threadId'&&
  a.threadId===g.threadId&&a.expectedUsedRequests===g.usedRequests;
function append(fd, value) {
  const bytes = Buffer.from(JSON.stringify(value) + '\n');
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    if (written <= 0) fail('BUDGET_WRITE_FAILED');
    offset += written;
  }
  fsyncSync(fd);
}
export function initializeBudget(path, grant, { now = Date.now } = {}) {
  if(grant&&Object.keys(grant).sort().join(',')==='threadId,usedRequests')grant={...grant,maxRequests:null,expiresAt:null};
  if (!validGrant(grant) || grant.expiresAt!==null&&(grant.expiresAt <= now() || grant.expiresAt - now() > 7_200_000))
    fail('BUDGET_GRANT_INVALID');
  let fd;
  try { fd = openSync(path, 'wx', 0o600); append(fd, { type: 'grant', version: grant.maxRequests===null?2:1, ...grant }); }
  catch (e) { fail(e.code === 'EEXIST' ? 'BUDGET_EXISTS' : 'BUDGET_WRITE_FAILED'); }
  finally { if (fd !== undefined) closeSync(fd); }
}
export function readBudget(path) {
  let raw;
  try { raw = readFileSync(path, 'utf8'); } catch { fail('BUDGET_UNAVAILABLE'); }
  try {
    if (!raw.endsWith('\n')) fail('BUDGET_CORRUPT');
    const [header, ...records] = raw.trimEnd().split('\n').map(line => JSON.parse(line));
    const { type, version, ...grant } = header;
    if (type !== 'grant' || !validGrant(grant) || version!==(grant.maxRequests===null?2:1)) fail('BUDGET_CORRUPT');
    let usedRequests = grant.usedRequests;const extensions=new Set();
    for (const record of records) {
      if(record.type==='unlimited'){
        const {type,at,...approval}=record;
        if(grant.maxRequests===null||!Number.isSafeInteger(at)||at<0||!validMigration(approval,{...grant,usedRequests}))fail('BUDGET_CORRUPT');
        grant.maxRequests=null;grant.expiresAt=null;continue;
      }
      if(record.type==='extension'){
        const {type,at,...approval}=record;
        if(grant.maxRequests===null||!validExtension(approval,{...grant,usedRequests},at)||extensions.has(approval.operationId))fail('BUDGET_CORRUPT');
        extensions.add(approval.operationId);grant.maxRequests+=approval.additionalRequests;grant.expiresAt=approval.expiresAt;
        continue;
      }
      if (Object.keys(record).sort().join(',') !== 'at,type,usedRequests' ||
          record.type !== 'reserve' || record.usedRequests !== usedRequests + 1 ||
          !Number.isSafeInteger(record.usedRequests)||!Number.isSafeInteger(record.at) || grant.expiresAt!==null&&record.at >= grant.expiresAt || record.at < 0)
        fail('BUDGET_CORRUPT');
      usedRequests = record.usedRequests;
      if(grant.maxRequests!==null&&usedRequests>grant.maxRequests)fail('BUDGET_CORRUPT');
    }
    if (grant.maxRequests!==null&&usedRequests > grant.maxRequests) fail('BUDGET_CORRUPT');
    return snapshotOf({...grant,usedRequests});
  } catch { fail('BUDGET_CORRUPT'); }
}
export function removeBudgetLimits(path,approval,{now=Date.now}={}){
  const owner=openBudget(path);let fd;
  try{
    const current=owner.snapshot(),at=now();
    if(!validMigration(approval,current)||!Number.isSafeInteger(at)||at<0)fail('BUDGET_MIGRATION_INVALID');
    if(current.maxRequests===null)return current;
    fd=openSync(path,'a');
    try{append(fd,{type:'unlimited',at,...approval});}catch{fail('BUDGET_WRITE_FAILED');}
    return readBudget(path);
  }finally{if(fd!==undefined)closeSync(fd);owner.close();}
}
export function extendBudget(path,approval,{now=Date.now}={}){
  // The same ledger lock excludes service reservations during a manual extension.
  const owner=openBudget(path);let fd;
  try{
    const prior=readFileSync(path,'utf8').trimEnd().split('\n').map(JSON.parse);
    if(prior.some(r=>r.type==='extension'&&r.operationId===approval?.operationId))fail('BUDGET_EXTENSION_EXISTS');
    const at=now();if(owner.snapshot().maxRequests===null||!validExtension(approval,owner.snapshot(),at))fail('BUDGET_EXTENSION_INVALID');
    fd=openSync(path,'a');
    try{append(fd,{type:'extension',at,...approval});}catch{fail('BUDGET_WRITE_FAILED');}
    return readBudget(path);
  }finally{if(fd!==undefined)closeSync(fd);owner.close();}
}
export function openBudget(path, { now = Date.now } = {}) {
  const lockPath = path + '.lock';
  let lock, fd;
  try { lock = openSync(lockPath, 'wx', 0o600); }
  catch (e) { fail(e.code === 'EEXIST' ? 'BUDGET_LOCKED' : 'BUDGET_UNAVAILABLE'); }
  try {
    append(lock, { pid: process.pid });
    const initial = readBudget(path);
    fd = openSync(path, 'a');
    let state = initial, closed = false, poisoned = false;
    return {
      snapshot: () => ({ ...state }),
      reserve() {
        if (closed || poisoned) fail('BUDGET_UNAVAILABLE');
        const at = now();
        if (state.expiresAt!==null&&at >= state.expiresAt) fail('BUDGET_EXPIRED');
        if (state.remaining===0) fail('BUDGET_EXHAUSTED');
        if(!Number.isSafeInteger(at)||at<0||!Number.isSafeInteger(state.usedRequests+1))fail('BUDGET_WRITE_FAILED');
        try { append(fd, { type: 'reserve', usedRequests: state.usedRequests + 1, at }); }
        catch (error) {
          poisoned = true;
          const failure=new Error('BUDGET_WRITE_FAILED');
          failure.storageCode=['EIO','EBADF','EACCES','EPERM','ENOSPC','ENOENT','ESTALE','ENOTCONN','ETIMEDOUT','UNKNOWN'].includes(error?.code)?error.code:'UNKNOWN';
          throw failure;
        }
        state = snapshotOf({...state,usedRequests:state.usedRequests+1});
        return { ...state };
      },
      close() {
        if (closed) return;
        closed = true;
        closeSync(fd); closeSync(lock); unlinkSync(lockPath);
      },
    };
  } catch (e) {
    if (fd !== undefined) closeSync(fd);
    closeSync(lock); unlinkSync(lockPath);
    throw e;
  }
}
