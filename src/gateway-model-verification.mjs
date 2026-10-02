import {randomBytes,createHash} from 'node:crypto';
import {responsesEndpoint} from './desktop-gateway-draft.mjs';
import {safeModelId} from './model-registry.mjs';
const fail=code=>{throw Error(code);};

// Host-only primitive: no registry writes, retries, fallback or capability promotion.
export async function verifyGatewayModel(input,{timeoutMs=60000}={}){
 if(!input||Object.keys(input).sort().join(',')!=='allowHttp,baseUrl,model,secret'||
  typeof input.allowHttp!=='boolean'||!safeModelId(input.model)||typeof input.secret!=='string'||
  !/^[\x21-\x7e]{1,8192}$/.test(input.secret)||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000)fail('GV_INPUT');
 let url;try{url=responsesEndpoint(input.baseUrl,input.allowHttp);}catch{fail('GV_URL');}
 const marker='ROUTER_VERIFY_'+randomBytes(16).toString('hex');
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
 let reader;
 try{
  const response=await fetch(url,{method:'POST',redirect:'manual',signal:controller.signal,
   headers:{Authorization:`Bearer ${input.secret}`,'Content-Type':'application/json',Accept:'text/event-stream'},
   body:JSON.stringify({model:input.model,input:`Reply with exactly ${marker}.`,stream:true,store:false,max_output_tokens:128})});
  if(response.status>=300&&response.status<400)fail('GV_REDIRECT');
  if([401,403].includes(response.status))fail('GV_AUTH');
  if(response.status!==200)fail('GV_HTTP');
  if(response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='text/event-stream')fail('GV_CONTENT_TYPE');
  if(!response.body)fail('GV_INCOMPLETE');
  reader=response.body.getReader();const decoder=new TextDecoder('utf-8',{fatal:true}),hash=createHash('sha256');
  let buffer='',bytes=0,complete=false;
  function consume(){
   let match;
   while((match=/\r?\n\r?\n/.exec(buffer))){
    const frame=buffer.slice(0,match.index);buffer=buffer.slice(match.index+match[0].length);
    const data=frame.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>l.slice(5).replace(/^ /,'')).join('\n');
    if(!data)continue;
    if(data==='[DONE]'){if(!complete)fail('GV_INCOMPLETE');continue;}
    if(complete)fail('GV_FORMAT');
    let event;try{event=JSON.parse(data);}catch{fail('GV_FORMAT');}
    if(!event||typeof event.type!=='string')fail('GV_FORMAT');
    if(['error','response.failed','response.incomplete'].includes(event.type))fail('GV_FAILED');
    if(event.type==='response.completed'){
     if(event.response?.status!=='completed'||!Array.isArray(event.response.output))fail('GV_FAILED');
     const text=event.response.output.flatMap(x=>Array.isArray(x?.content)?x.content:[]).filter(x=>x?.type==='output_text').map(x=>x.text).join('');
     if(text.trim()!==marker)fail('GV_MARKER');complete=true;
    }
   }
  }
  while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>1048576)fail('GV_TOO_LARGE');hash.update(value);
   try{buffer+=decoder.decode(value,{stream:true});}catch{fail('GV_FORMAT');}consume();
  }
  try{buffer+=decoder.decode();}catch{fail('GV_FORMAT');}consume();
  if(buffer.trim()||!complete)fail('GV_INCOMPLETE');
  return {ok:true,scope:'responses-stream-text',httpStatus:200,completed:true,markerMatched:true,bytes,
   bodySha256:hash.digest('hex'),toolsVerified:false,contextLimitVerified:false,workerVerified:false};
 }catch(error){throw Error(/^GV_[A-Z_]+$/.test(error.message)?error.message:controller.signal.aborted?'GV_TIMEOUT':'GV_NETWORK');}
 finally{clearTimeout(timer);controller.abort();try{await reader?.cancel();}catch{/* no raw transport errors */}}
}
