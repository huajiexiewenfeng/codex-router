import {openSync,readSync,fstatSync,closeSync} from 'node:fs';
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const codes=new Set(['transport_failed_before_headers','transport_or_stream_error','first_byte_timeout','stream_idle_timeout','local_storage_failed','incomplete_stream','upstream_http_error','upstream_event','cancelled','stopped']);
const networks=new Set(['ECONNRESET','ECONNREFUSED','ETIMEDOUT','ENOTFOUND','EAI_AGAIN','EPIPE','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT','UND_ERR_SOCKET','UNKNOWN']);
// Current-run, bounded, allowlisted diagnostics only. Never return raw log entries.
export function requestDiagnostics(config,status){
 const result={available:false,scope:'current-run-tail',workers:[]};
 if(!config.registryPath||!uuid.test(status.runId??''))return result;
 let fd;
 try{
  fd=openSync(config.registryPath+'.'+status.runId+'.events.jsonl','r');
  const size=fstatSync(fd).size,start=Math.max(0,size-262144),buffer=Buffer.alloc(Math.min(size,262144));
  const n=readSync(fd,buffer,0,buffer.length,start);let raw=buffer.subarray(0,n).toString('utf8');
  if(start)raw=raw.slice(raw.indexOf('\n')+1);
  raw=raw.slice(0,raw.lastIndexOf('\n')+1);
  const live=status.state==='running'&&status.stopRequested!==true;
  const byId=new Map((status.bindings??[]).filter(b=>uuid.test(b.threadId)).map(b=>[b.threadId,{threadId:b.threadId,state:live?b.state:'unknown',active:live&&b.active===true,recovered:false}]));
  for(const line of raw.split('\n')){
   let e;try{e=JSON.parse(line);}catch{continue;}
   const row=byId.get(e.threadId);if(!row||!Number.isSafeInteger(e.timestamp)||e.timestamp<0)continue;
   if(typeof e.model==='string'&&/^[a-zA-Z0-9_.-]{1,80}$/.test(e.model))row.model=e.model;
   if(e.code==='outbound_reserved'){row.startedAt=e.timestamp;delete row.route;}
   if(['official','company'].includes(e.route))row.route=e.route;
   if(e.code==='response_completed'){row.completedAt=e.timestamp;row.recovered=!!row.failure&&e.timestamp>row.failure.timestamp;}
   if(e.stage==='failure'&&codes.has(e.code)||e.code==='upstream_http_error'){
    // The core's generic follow-up must not hide the transport's precise errno.
    if(e.code==='transport_or_stream_error'&&row.failure?.code==='transport_failed_before_headers'&&e.timestamp-row.failure.timestamp<1000)continue;
    const f={code:e.code,timestamp:e.timestamp};
    if(row.route)f.route=row.route;
    if(row.model)f.model=row.model;
    if(networks.has(e.networkCode))f.networkCode=e.networkCode;
    if(Number.isSafeInteger(e.elapsedMs)&&e.elapsedMs>=0)f.elapsedMs=e.elapsedMs;
    if(Number.isInteger(e.upstreamStatus)&&e.upstreamStatus>=400&&e.upstreamStatus<=599)f.upstreamStatus=e.upstreamStatus;
    row.failure=f;row.recovered=false;
   }
  }
  result.available=true;result.workers=[...byId.values()].filter(r=>r.failure||r.active).slice(0,32);
 }catch{/* Missing logs are not evidence of successful upstream calls. */}
 finally{if(fd!==undefined)closeSync(fd);}
 return result;
}
