import {responsesEndpoint} from './desktop-gateway-draft.mjs';
import {safeModelId} from './model-registry.mjs';
const fail=code=>{throw Error(code);};
export async function syncGatewayModels(input){
 if(!input||Object.keys(input).sort().join(',')!=='allowHttp,baseUrl,secret'||typeof input.allowHttp!=='boolean'||typeof input.secret!=='string'||input.secret.length>8192||/[\r\n\x00]/.test(input.secret))fail('GM_INPUT');
 const url=new URL(responsesEndpoint(input.baseUrl,input.allowHttp));
 url.pathname=url.pathname.replace(/\/responses$/,'/models');
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
 let response;
 try{
  response=await fetch(url,{method:'GET',redirect:'manual',signal:controller.signal,headers:{Accept:'application/json',...(input.secret?{Authorization:`Bearer ${input.secret}`}:{})}});
  if(response.status>=300&&response.status<400)fail('GM_REDIRECT');
  if([401,403].includes(response.status))fail('GM_AUTH');
  if(response.status===404||response.status===405)fail('GM_UNSUPPORTED');
  if(!response.ok)fail('GM_HTTP');
  let size=0;const chunks=[];
  for await(const chunk of response.body){size+=chunk.length;if(size>1048576)fail('GM_TOO_LARGE');chunks.push(chunk);}
  let data;try{data=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail('GM_FORMAT');}
  if(data?.has_more===true)fail('GM_PAGINATION');
  if(!Array.isArray(data?.data)||data.data.length>2000)fail('GM_FORMAT');
  if(data.data.some(m=>!m||!safeModelId(m.id)))fail('GM_FORMAT');
  const models=[...new Set(data.data.map(m=>m.id))];
  if(!models.length)fail('GM_EMPTY');
  return {ok:true,models};
 }catch(e){throw Error(/^GM_[A-Z_]+$/.test(e.message)?e.message:controller.signal.aborted?'GM_TIMEOUT':'GM_NETWORK');}
 finally{clearTimeout(timer);controller.abort();}
}
