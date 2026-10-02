import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { saveModelDraft, applyModelDraft } from '../src/model-registry-store.mjs';

const threadId='00000000-0000-4000-8000-000000000001',turnId='00000000-0000-4000-8000-000000000002';
const request={hostId:'local',threadId,turnId,selectionId:'sol_self',historyMode:'explicit-portable',inputModalities:['text'],usesTools:true,reasoningEffort:'high',estimatedInputTokens:10,maxOutputTokens:10};
const bindings=[{hostId:'local',threadId,allowedModels:['sol_self','personal-sol_self']}];
function registry(){return {schemaVersion:2,generation:1,suffix:'_self',
 providers:['company','personal'].map(id=>({id,kind:'api-key',wireApi:'responses',responsesUrl:`https://${id}.example/v1/responses`,credentialRef:id+'-key',allowHttp:false})),
 models:['company','personal'].map((id,i)=>{const selectionId=i?'personal-sol_self':'sol_self';return {modelId:'model-'+id,selectionId,displayName:id,upstreamModel:'gpt-6-sol',providerId:id,readiness:'verified',verificationRef:'fixture-proof',capabilities:{contextWindow:262144,inputModalities:['text'],tools:true,reasoningEfforts:['high']},catalogEntry:{slug:selectionId,display_name:id,description:'fixture',visibility:'list',context_window:262144,input_modalities:['text'],supported_reasoning_levels:[{effort:'high',description:'fixture'}],default_reasoning_level:'high',supported_in_api:true}};})};}
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'model-runtime-')),path=join(dir,'registry.json'),value=registry();await writeFile(path,JSON.stringify(value));
 // Dynamic lookup gives a focused assertion for the missing feature in RED.
 let api;try{api=await import('../src/model-registry-runtime.mjs');}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;}
 assert.equal(typeof api?.createModelRegistryRuntime,'function','runtime snapshot consumer must exist');
 return {dir,path,value,runtime:api.createModelRegistryRuntime(path)};
}
test('capture resolves exact gateway identity and returns immutable metadata, not credentials',async()=>{
 const f=await fixture(),a=f.runtime.capture(request,bindings),b=f.runtime.capture({...request,selectionId:'personal-sol_self'},bindings);
 assert.equal(a.responsesUrl,'https://company.example/v1/responses');assert.equal(b.responsesUrl,'https://personal.example/v1/responses');
 assert.equal(a.credentialRef,'company-key');assert.equal(b.credentialRef,'personal-key');assert.equal(a.upstreamModel,b.upstreamModel);
 assert.equal(a.loadsCredential,false);assert.equal(a.sendsRequest,false);assert.ok(Object.isFrozen(a));
 assert.throws(()=>a.providerId='other',TypeError);
 assert.doesNotMatch(JSON.stringify(f.runtime.status()),/company|personal|https:|key/);
});
test('apply affects the next capture and leaves a previously captured request unchanged',async()=>{
 const f=await fixture(),old=f.runtime.capture(request,bindings),next=structuredClone(f.value);next.generation=2;
 next.models[0].displayName='renamed';next.models[0].catalogEntry.display_name='renamed';
 const candidate=join(f.dir,'candidate.json'),draft=join(f.dir,'draft.json');await writeFile(candidate,JSON.stringify(next));
 const saved=await saveModelDraft(f.path,candidate,draft);await applyModelDraft(f.path,draft,saved.draftSha256);
 assert.equal(f.runtime.capture(request,bindings).generation,2);assert.equal(old.generation,1);assert.equal(old.providerId,'company');
 assert.equal(f.runtime.status().generation,2);
});
test('broken files fail closed and can recover without changing already captured requests',async()=>{
 const f=await fixture(),old=f.runtime.capture(request,bindings);await writeFile(f.path,'private malformed payload');
 assert.throws(()=>f.runtime.capture(request,bindings),{message:'MR_RUNTIME_INPUT'});
 assert.equal(f.runtime.status().healthy,false);assert.equal(old.generation,1);
 await writeFile(f.path,JSON.stringify(f.value));assert.equal(f.runtime.capture(request,bindings).generation,1);
 assert.equal(f.runtime.status().healthy,true);
});
test('rollback, same-generation edits and retargets are rejected even without the apply CLI',async()=>{
 const f=await fixture();f.runtime.capture(request,bindings);
 const same=structuredClone(f.value);same.models[0].displayName='changed';same.models[0].catalogEntry.display_name='changed';
 await writeFile(f.path,JSON.stringify(same));assert.throws(()=>f.runtime.capture(request,bindings),{message:'MR_RUNTIME_GENERATION'});
 same.generation=2;await writeFile(f.path,JSON.stringify(same));f.runtime.capture(request,bindings);
 await writeFile(f.path,JSON.stringify(f.value));assert.throws(()=>f.runtime.capture(request,bindings),{message:'MR_RUNTIME_GENERATION'});
 same.generation=3;same.providers[0].credentialRef='replacement';await writeFile(f.path,JSON.stringify(same));
 assert.throws(()=>f.runtime.capture(request,bindings),{message:'MR_RUNTIME_UPDATE_BLOCKED'});
});
test('runtime preserves binding and capability gates',async()=>{
 const f=await fixture();
 assert.throws(()=>f.runtime.capture(request,[]),{message:'MR_ROUTE_BINDING'});
 assert.throws(()=>f.runtime.capture({...request,reasoningEffort:'unknown'},bindings),{message:'MR_ROUTE_CAPABILITIES'});
 assert.equal(f.runtime.capture(request,bindings).generation,1);
});

test('missing files and unsupported schemas cannot fall back to a previously accepted registry',async()=>{
 const f=await fixture();f.runtime.capture(request,bindings);
 await rename(f.path,join(f.dir,'saved.json'));
 assert.throws(()=>f.runtime.capture(request,bindings),{message:'MR_RUNTIME_READ'});
 assert.deepEqual(f.runtime.status(),{healthy:false,generation:1,lastError:'MR_RUNTIME_READ',observation:'last-capture-only'});
 await writeFile(f.path,JSON.stringify({schemaVersion:1,generation:2,suffix:'_self',providers:[],models:[]}));
 assert.throws(()=>f.runtime.capture(request,bindings),{message:'MR_RUNTIME_SCHEMA'});
});
