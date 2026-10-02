import test from 'node:test';
import assert from 'node:assert/strict';
import {modelRegistry} from './fixtures/router-model-registry.mjs';
import {validateModelRegistry} from '../src/model-registry.mjs';
const input=()=>({displayName:'公司测试网关',baseUrl:'https://gateway.example/v1',allowHttp:false,models:['gpt-6-sol'],capabilities:{contextWindow:262144,inputModalities:['text'],tools:true,reasoningEfforts:['low','high']}});
const host={providerId:'gateway-new',credentialRef:'gateway-new-key',modelIds:['model-new']};
async function api(){const m=await import('../src/desktop-gateway-draft.mjs').catch(()=>({}));assert.equal(typeof m.prepareGatewayDraft,'function');return m.prepareGatewayDraft;}
test('draft adds pending disabled model with explicit capabilities without mutation',async()=>{
 const prepare=await api(),before=modelRegistry(),copy=structuredClone(before),result=prepare(before,input(),host);
 assert.deepEqual(before,copy);assert.equal(result.registry.generation,2);assert.equal(result.applies,false);assert.equal(result.sendsRequest,false);
 const p=result.registry.providers.at(-1),m=result.registry.models.at(-1);
 assert.equal(p.displayName,'公司测试网关');assert.equal(p.responsesUrl,'https://gateway.example/v1/responses');
 assert.equal(m.selectionId,'gpt-6-sol_self');assert.equal(m.enabled,false);assert.equal(m.readiness,'pending');assert.equal(m.catalogEntry,undefined);
 assert.equal(result.plan.status,'compatible');validateModelRegistry(result.registry);
});
test('normalizes versioned base and full responses endpoint without guessing root or protocol',async()=>{
 const prepare=await api();
 for(const baseUrl of ['https://gateway.example/v1/','https://gateway.example/v1/responses'])assert.equal(prepare(modelRegistry(),{...input(),baseUrl},host).registry.providers.at(-1).responsesUrl,'https://gateway.example/v1/responses');
 for(const baseUrl of ['https://gateway.example','https://gateway.example/v1/chat/completions','https://name:password@gateway.example/v1','https://gateway.example/v1?key=value','https://gateway.example/v1#fragment','https://gateway.example/v1/../v1','https://gateway.example/v1\\responses'])assert.throws(()=>prepare(modelRegistry(),{...input(),baseUrl},host));
});
test('HTTP requires explicit opt in and rejected requests never echo values',async()=>{
 const prepare=await api(),baseUrl='http://gateway.example/v1';
 assert.throws(()=>prepare(modelRegistry(),{...input(),baseUrl},host),{message:'DG_HTTP_CONFIRMATION'});
 assert.equal(prepare(modelRegistry(),{...input(),baseUrl,allowHttp:true},host).registry.providers.at(-1).allowHttp,true);
 for(const extra of [{secret:'fixture-only'},{filePath:'C:/fixture'},{apiKey:'fixture-only'}])assert.throws(()=>prepare(modelRegistry(),{...input(),...extra},host),{message:'DG_REQUEST'});
});
test('rejects duplicate display names and aliases without silently renaming',async()=>{
 const prepare=await api(),before=modelRegistry();
 assert.throws(()=>prepare(before,{...input(),displayName:'one'},host),{message:'DG_NAME_CONFLICT'});
 assert.throws(()=>prepare(before,{...input(),models:['one']},host),{message:'DG_MODEL_CONFLICT'});
 assert.throws(()=>prepare(before,{...input(),models:['same','same']},{...host,modelIds:['new1','new2']}),{message:'DG_MODEL_CONFLICT'});
});
test('provider label is optional, rejects controls, and survives registry validation',()=>{
 const r=modelRegistry();validateModelRegistry(r);r.providers[0].displayName='公司网关';assert.equal(validateModelRegistry(r).providers[0].displayName,'公司网关');
 for(const displayName of ['',' x ','bad\nname',123]){r.providers[0].displayName=displayName;assert.throws(()=>validateModelRegistry(r));}
});
test('invalid host identities and capabilities cannot enter a candidate',async()=>{
 const prepare=await api();
 for(const identity of [{...host,providerId:'one'},{...host,credentialRef:'one-key'},{...host,modelIds:['model-one']},{...host,modelIds:[]},{...host,filePath:'C:/fixture'}])assert.throws(()=>prepare(modelRegistry(),input(),identity));
 for(const capabilities of [{...input().capabilities,contextWindow:0},{...input().capabilities,secret:'fixture'},null])assert.throws(()=>prepare(modelRegistry(),{...input(),capabilities},host));
 const original=input(),r=prepare(modelRegistry(),original,host);r.registry.models.at(-1).capabilities.inputModalities.push('audio');assert.deepEqual(original.capabilities.inputModalities,['text']);
});
