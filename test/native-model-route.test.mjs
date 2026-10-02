import test from 'node:test';
import assert from 'node:assert/strict';
import { modelRegistry,threadId,turnId,binding } from './fixtures/router-model-registry.mjs';
let api;try{api=await import('../src/native-model-route.mjs');}catch(e){if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;}
const payload=()=>({model:'one_self',stream:true,input:[{role:'user',content:[{type:'input_text',text:'hello'}]}]});
function plan(body,registry=modelRegistry(),bindings=[binding]){assert.equal(typeof api?.planNativeModelRoute,'function');return api.planNativeModelRoute(registry,{hostId:'local',threadId,turnId},body,bindings);}
test('native route derives capabilities without manufacturing token estimates',()=>{
 const p=payload();p.reasoning={effort:'max'};p.tools=[{type:'function',name:'read_file'}];p.input[0].content.push({type:'input_image',image_url:'data:image/png;base64,fixture'});
 const before=structuredClone(p),r=plan(p);
 assert.equal(r.reasoningEffort,'max');assert.equal(r.usesTools,true);assert.deepEqual(r.inputModalities,['text','image']);
 assert.equal(r.estimatedInputTokens,null);assert.equal(r.maxOutputTokens,null);assert.equal(r.tokenBudgetValidation,'upstream-required');assert.equal(r.allowHttp,false);
 assert.equal(r.credentialRef,'one-key');assert.deepEqual(p,before);
});
test('missing effort remains upstream default; explicit effort and output ceiling are checked',()=>{
 assert.equal(plan(payload()).reasoningEffort,null);
 assert.equal(plan(payload()).reasoningEffortSource,'upstream-default');
 assert.equal(plan({...payload(),reasoning:{effort:'max'}}).reasoningEffortSource,'request');
 assert.throws(()=>plan({...payload(),reasoning:{effort:'unknown'}}),{message:'MR_ROUTE_CAPABILITIES'});
 assert.throws(()=>plan({...payload(),max_output_tokens:300000}),{message:'MR_ROUTE_BUDGET'});
 assert.throws(()=>plan({...payload(),max_output_tokens:0}),{message:'MR_NATIVE_REQUEST'});
 assert.equal(plan({...payload(),max_output_tokens:1000}).maxOutputTokens,1000);
});
test('native tools in declarations and replay cannot bypass model tool capabilities',()=>{
 const r=modelRegistry();r.models[0].capabilities.tools=false;
 for(const input of [[{type:'additional_tools',role:'developer',tools:[{type:'function',name:'tool'}]}],[{type:'function_call_output',call_id:'call',output:'ok'}],[{type:'custom_tool_call',call_id:'call',input:'x'}]]){
  assert.throws(()=>plan({...payload(),input},r),{message:'MR_ROUTE_CAPABILITIES'});
 }
});
test('unrecognized or malformed native inputs fail closed and bindings remain enforced',()=>{
 for(const p of [ {...payload(),input:[{type:'future_unknown'}]}, {...payload(),input:[{role:'user',content:[{type:'input_audio',input_audio:{}}]}]}, {...payload(),tools:{}}, {...payload(),reasoning:{effort:1}}, {...payload(),input:[{role:'user',content:{}}]} ])assert.throws(()=>plan(p),{message:'MR_NATIVE_REQUEST'});
 assert.throws(()=>plan(payload(),modelRegistry(),[]),{message:'MR_ROUTE_BINDING'});
 assert.throws(()=>plan({...payload(),model:'unknown_self'}),{message:'MR_ROUTE_MODEL'});
});
test('known opaque history stays intact but server-side references are rejected for cross-provider routing',()=>{
 const p={...payload(),input:[{type:'reasoning',encrypted_content:'opaque',summary:[]},{type:'compaction',encrypted_content:'opaque'}]};
 const before=structuredClone(p);plan(p);assert.deepEqual(p,before);
 assert.throws(()=>plan({...p,previous_response_id:'response-id'}),{message:'MR_NATIVE_HISTORY_REFERENCE'});
});
