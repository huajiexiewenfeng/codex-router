import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {validateModelRegistry} from '../src/model-registry.mjs';
import {buildModelCatalog} from '../src/model-catalog.mjs';
import {planNativeModelRoute} from '../src/native-model-route.mjs';
import {planModelRegistryUpdate} from '../src/model-registry-update.mjs';
import {inspectWorkerModels} from '../src/worker-model-binding.mjs';
import {planModelRoute} from '../src/model-route-plan.mjs';
import {saveModelDraft,applyModelDraft} from '../src/model-registry-store.mjs';
import {readFile} from 'node:fs/promises';
import {modelRegistry,binding,threadId,turnId} from './fixtures/router-model-registry.mjs';

test('v2 enabled is optional for legacy records, but strictly boolean when provided',()=>{
 const r=modelRegistry();assert.equal(validateModelRegistry(r).models.length,2);
 r.models[0].enabled=false;assert.equal(validateModelRegistry(r).models[0].enabled,false);
 for(const value of [null,'false',0,{}]){r.models[0].enabled=value;assert.throws(()=>validateModelRegistry(r),/MR_MODEL_ENABLED/);}
});
test('catalog preserves official entries and excludes disabled verified and enabled pending models',()=>{
 const r=modelRegistry();r.models[0].enabled=false;r.models[1].enabled=true;r.models[1].readiness='pending';delete r.models[1].catalogEntry;delete r.models[1].verificationRef;
 const base={models:[{slug:'official'}]};assert.deepEqual(buildModelCatalog(r,base),base);assert.equal(r.models[0].readiness,'verified');
});
test('native routing rejects disabled model even if a historical Worker binding allows it',()=>{
 const r=modelRegistry();r.models[0].enabled=false;
 assert.throws(()=>planNativeModelRoute(r,{hostId:'local',threadId,turnId},{model:'one_self',stream:true,input:[]},[binding]),/MR_ROUTE_DISABLED/);
 r.models[0].enabled=true;assert.equal(planNativeModelRoute(r,{hostId:'local',threadId,turnId},{model:'one_self',stream:true,input:[]},[binding]).providerId,'one');
});
test('disabling an existing selection requires Worker impact review; re-enabling is compatible',()=>{
 const before=modelRegistry(),after=structuredClone(before);after.generation++;after.models[0].enabled=false;
 const plan=planModelRegistryUpdate(before,after);assert.equal(plan.status,'blocked');assert.ok(plan.issues.some(i=>i.code==='MR_UPDATE_DISABLE_REQUIRES_REVIEW'&&i.modelId==='model-one'));
 const next=structuredClone(after);next.generation++;next.models[0].enabled=true;assert.equal(planModelRegistryUpdate(after,next).status,'compatible');
});
test('new Worker bindings omit disabled models and reject choosing one',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'router-enabled-'));
 try{
  const r=modelRegistry();r.models[0].enabled=false;
  const modelRegistryPath=join(dir,'models.json'),bindingsPath=join(dir,'bindings.json');
  await writeFile(modelRegistryPath,JSON.stringify(r));await writeFile(bindingsPath,JSON.stringify([binding]));
  const options={modelRegistryPath,bindingsPath,officialModels:['official']};
  assert.deepEqual((await inspectWorkerModels(options,'official')).allowedModels,['two_self']);
  await assert.rejects(inspectWorkerModels(options,'one_self'),/WORKER_MODEL_UNAVAILABLE/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('portable route rejects disabled models and enabled pending models remain unavailable',()=>{
 const r=modelRegistry();const request={hostId:'local',threadId,turnId,selectionId:'one_self',historyMode:'explicit-portable',inputModalities:['text'],usesTools:false,reasoningEffort:'high',estimatedInputTokens:1,maxOutputTokens:8};
 r.models[0].enabled=false;assert.throws(()=>planModelRoute(r,request,[binding]),/MR_ROUTE_DISABLED/);
 r.models[0].enabled=true;r.models[0].readiness='pending';delete r.models[0].catalogEntry;delete r.models[0].verificationRef;
 assert.throws(()=>planModelRoute(r,request,[binding]),/MR_ROUTE_PENDING/);
});
test('disabled draft is saved but cannot silently replace active configuration',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'router-enabled-store-'));
 try{
  const current=modelRegistry(),candidate=structuredClone(current);candidate.generation++;candidate.models[0].enabled=false;
  const paths=['current','candidate','draft'].map(n=>join(dir,n+'.json'));
  await writeFile(paths[0],JSON.stringify(current));await writeFile(paths[1],JSON.stringify(candidate));
  const before=await readFile(paths[0],'utf8');const result=await saveModelDraft(...paths);
  assert.equal(result.status,'saved');assert.equal(result.plan.status,'blocked');
  await assert.rejects(applyModelDraft(paths[0],paths[2],result.draftSha256),/MR_STORE_BLOCKED/);
  assert.equal(await readFile(paths[0],'utf8'),before);
 }finally{await rm(dir,{recursive:true,force:true});}
});
