import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
const api=await import('../src/gateway-model-sync.mjs').catch(()=>({}));
test('safe errors for authentication, malformed, oversized and paginated lists',async()=>{
 const cases=[[401,'private','GM_AUTH'],[404,'private','GM_UNSUPPORTED'],[500,'private','GM_HTTP'],[200,'not json','GM_FORMAT'],[200,JSON.stringify({data:[]}),'GM_EMPTY'],[200,JSON.stringify({has_more:true,data:[{id:'a'}]}),'GM_PAGINATION'],[200,'x'.repeat(1048577),'GM_TOO_LARGE']];
 for(const [status,body,code] of cases){
  const server=createServer((req,res)=>{res.writeHead(status);res.end(body);});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try{await assert.rejects(()=>api.syncGatewayModels({baseUrl:`http://127.0.0.1:${server.address().port}/v1/responses`,allowHttp:true,secret:''}),new RegExp('^Error: '+code+'$'));}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
 }
});
test('model sync reads authenticated list once, deduplicates and returns names only',async()=>{
 assert.equal(typeof api.syncGatewayModels,'function');
 let count=0;
 const server=createServer((req,res)=>{count++;assert.equal(req.url,'/v1/models');assert.equal(req.method,'GET');assert.equal(req.headers.authorization,'Bearer fixture-only');res.end(JSON.stringify({data:[{id:'gpt-6-sol',private:'omit'},{id:'gpt-6-sol'},{id:'gpt-6-luna'}]}));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{assert.deepEqual(await api.syncGatewayModels({baseUrl:`http://127.0.0.1:${server.address().port}/v1`,allowHttp:true,secret:'fixture-only'}),{ok:true,models:['gpt-6-sol','gpt-6-luna']});assert.equal(count,1);}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('refuses unconfirmed HTTP and never follows redirects or reflects errors',async()=>{
 assert.equal(typeof api.syncGatewayModels,'function');
 await assert.rejects(()=>api.syncGatewayModels({baseUrl:'http://127.0.0.1/v1',allowHttp:false,secret:''}),/DG_HTTP_CONFIRMATION/);
 let count=0;const server=createServer((req,res)=>{count++;res.writeHead(302,{Location:'/leak'});res.end('secret-content');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{await assert.rejects(()=>api.syncGatewayModels({baseUrl:`http://127.0.0.1:${server.address().port}/v1`,allowHttp:true,secret:'fixture-only'}),/^Error: GM_REDIRECT$/);assert.equal(count,1);}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
