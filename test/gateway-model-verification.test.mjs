import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
const api=await import('../src/gateway-model-verification.mjs').catch(()=>({}));
async function fixture(run,check){
 const server=createServer(async(req,res)=>{let text='';for await(const b of req)text+=b;await run(req,res,JSON.parse(text));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{await check({baseUrl:`http://127.0.0.1:${server.address().port}/v1`,allowHttp:true,secret:'fixture-key',model:'example'});}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
}
const completed=marker=>({type:'response.completed',response:{status:'completed',output:[{type:'message',content:[{type:'output_text',text:marker}]}]}});
const frame=e=>'data: '+JSON.stringify(e)+'\r\n\r\n';
test('one streaming request validates split SSE without returning secrets or response body',async()=>{
 assert.equal(typeof api.verifyGatewayModel,'function');let count=0;
 await fixture(async(req,res,body)=>{count++;assert.equal(req.url,'/v1/responses');assert.equal(body.stream,true);assert.equal(body.store,false);assert.equal(req.headers.authorization,'Bearer fixture-key');const marker=body.input.match(/ROUTER_VERIFY_[a-f0-9]+/)[0];res.setHeader('Content-Type','text/event-stream');const data=frame(completed(marker));res.write(data.slice(0,12));res.end(data.slice(12));},async input=>{const result=await api.verifyGatewayModel(input);assert.equal(result.ok,true);assert.equal(result.scope,'responses-stream-text');assert.equal(result.toolsVerified,false);assert.ok(!JSON.stringify(result).includes('fixture-key'));});assert.equal(count,1);
});
for(const [name,content,code] of [
 ['missing completion',()=>frame({type:'response.created'}),'GV_INCOMPLETE'],
 ['wrong marker',()=>frame(completed('wrong')),'GV_MARKER'],
 ['malformed data',()=> 'data: invalid\n\n','GV_FORMAT'],
 ['failed event',()=>frame({type:'response.failed'}),'GV_FAILED'],
 ['unfinished frame',()=>frame(completed('wrong')).trimEnd(),'GV_INCOMPLETE'],
 ['oversized',()=>':'+ 'a'.repeat(1048577),'GV_TOO_LARGE']]){
 test(name,async()=>{assert.equal(typeof api.verifyGatewayModel,'function');await fixture(async(req,res)=>{res.setHeader('Content-Type','text/event-stream');res.end(content());},async input=>assert.rejects(api.verifyGatewayModel(input),new RegExp(code)));});
}
test('redirect is not followed and upstream error content stays private',async()=>{
 assert.equal(typeof api.verifyGatewayModel,'function');for(const status of [302,401,500]){let count=0;await fixture(async(req,res)=>{count++;res.writeHead(status,{Location:'/another'});res.end('fixture-key sensitive upstream');},async input=>assert.rejects(api.verifyGatewayModel(input),e=>/^GV_(REDIRECT|AUTH|HTTP)$/.test(e.message)));assert.equal(count,1);}
});
test('rejects JSON success response instead of treating HTTP 200 as verified',async()=>{
 assert.equal(typeof api.verifyGatewayModel,'function');await fixture(async(req,res)=>{res.setHeader('Content-Type','application/json');res.end('{}');},async input=>assert.rejects(api.verifyGatewayModel(input),/GV_CONTENT_TYPE/));
});
test('timeout aborts a stalled stream without retrying',async()=>{
 let count=0;await fixture(async(req,res)=>{count++;res.setHeader('Content-Type','text/event-stream');res.write(':waiting\n\n');},async input=>assert.rejects(api.verifyGatewayModel(input,{timeoutMs:50}),/GV_TIMEOUT/));assert.equal(count,1);
});
test('invalid inputs fail before network access',async()=>{
 for(const input of [null,{}, {baseUrl:'http://127.0.0.1:1/v1',allowHttp:true,secret:'with space',model:'example'}, {baseUrl:'http://127.0.0.1:1/v1',allowHttp:true,secret:'valid',model:'example',extra:true}])await assert.rejects(api.verifyGatewayModel(input),/GV_INPUT/);
 await assert.rejects(api.verifyGatewayModel({baseUrl:'http://127.0.0.1:1/v1',allowHttp:false,secret:'valid',model:'example'}),/GV_URL/);
});
test('terminal failure after completed event is not accepted',async()=>{
 await fixture(async(req,res,body)=>{res.setHeader('Content-Type','text/event-stream');res.end(frame(completed(body.input.match(/ROUTER_VERIFY_[a-f0-9]+/)[0]))+frame({type:'response.failed'}));},async input=>assert.rejects(api.verifyGatewayModel(input),/GV_FORMAT/));
});
