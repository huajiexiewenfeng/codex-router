import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {modelRegistry,binding,threadId,turnId} from './fixtures/router-model-registry.mjs';
import {validateModelRegistry} from '../src/model-registry.mjs';
import {planNativeModelRoute} from '../src/native-model-route.mjs';
import {planModelRegistryUpdate} from '../src/model-registry-update.mjs';
import {createModelRegistryRuntime} from '../src/model-registry-runtime.mjs';
import {buildModelCatalog} from '../src/model-catalog.mjs';
import {prepareGatewayDraft} from '../src/desktop-gateway-draft.mjs';
import {inspectWorkerModels,bindWorkerModels} from '../src/worker-model-binding.mjs';
const identity={hostId:'local',threadId,turnId};
const body={model:'shared_self',stream:true,input:[{role:'user',content:'hello'}]};
function registry(){const r=modelRegistry();r.activeProviderId='one';for(const m of r.models){m.selectionId='shared_self';m.displayName='shared_self';m.readiness='pending';delete m.catalogEntry;delete m.verificationRef;}return r;}
const workers=[{...binding,allowedModels:['legacy_self']}];
test('current gateway disambiguates identical names without model binding or mandatory verification',()=>{
 const r=registry();assert.doesNotThrow(()=>validateModelRegistry(r));
 assert.equal(planNativeModelRoute(r,identity,body,workers).providerId,'one');
 r.activeProviderId='two';assert.equal(planNativeModelRoute(r,identity,body,workers).credentialRef,'two-key');
 assert.throws(()=>planNativeModelRoute(r,identity,body,[]),/MR_ROUTE_BINDING/);
 r.models[1].enabled=false;assert.throws(()=>planNativeModelRoute(r,identity,body,workers),/MR_ROUTE_DISABLED/);
 r.models[1].selectionId='other_self';assert.throws(()=>planNativeModelRoute(r,identity,body,workers),/MR_ROUTE_MODEL/);
 r.activeProviderId=null;assert.throws(()=>planNativeModelRoute(r,identity,body,workers),/MR_ACTIVE_PROVIDER_REQUIRED/);
});
test('catalog contains only current enabled models including unverified declarations and leaves official entries intact',()=>{
 const r=registry(),base={models:[{slug:'official'}]};
 const catalog=buildModelCatalog(r,base);assert.deepEqual(catalog.models.map(m=>m.slug),['official','shared_self']);assert.deepEqual(base,{models:[{slug:'official'}]});
 r.activeProviderId=null;assert.deepEqual(buildModelCatalog(r,base),base);
});
test('active provider is valid and duplicate names only allowed across providers',()=>{
 const r=registry();r.activeProviderId='missing';assert.throws(()=>validateModelRegistry(r),/MR_ACTIVE_PROVIDER/);
 r.activeProviderId='one';r.models[1].providerId='one';assert.throws(()=>validateModelRegistry(r),/MR_MODEL_DUPLICATE/);
});
test('switching and disabling is compatible and prior request snapshot retains old route',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'active-gateway-'));t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,'models.json'),r=registry();await writeFile(path,JSON.stringify(r));
 const runtime=createModelRegistryRuntime(path),old=runtime.captureNative(identity,body,workers);
 r.generation++;r.activeProviderId='two';await writeFile(path,JSON.stringify(r));assert.equal(runtime.captureNative(identity,body,workers).providerId,'two');assert.equal(old.providerId,'one');
 const next=structuredClone(r);next.generation++;next.models[1].enabled=false;assert.equal(planModelRegistryUpdate(r,next,workers).status,'compatible');
 await writeFile(path,JSON.stringify(next));assert.throws(()=>runtime.captureNative(identity,body,workers),/MR_ROUTE_DISABLED/);
});
test('adding a second gateway with the same model does not switch the current gateway',()=>{
 const r=registry();r.providers.pop();r.models.pop();
 const draft=prepareGatewayDraft(r,{displayName:'second',baseUrl:'https://two.example/v1',allowHttp:false,models:['shared'],capabilities:r.models[0].capabilities},{providerId:'two',credentialRef:'two-key',modelIds:['new-model']});
 assert.equal(draft.registry.activeProviderId,'one');assert.equal(draft.registry.models.length,2);
});
test('worker creation accepts current unverified models and stores identity without a model allowlist',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'global-worker-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const options={modelRegistryPath:join(dir,'models.json'),bindingsPath:join(dir,'bindings.json'),officialModels:['official']};
 await writeFile(options.modelRegistryPath,JSON.stringify(registry()));await writeFile(options.bindingsPath,'[]');
 await bindWorkerModels(options,'shared_self',threadId);
 const inspected=await inspectWorkerModels(options,'shared_self');assert.deepEqual(inspected.bindings,[{hostId:'local',threadId,allowedModels:[]}]);
 const r=registry();r.activeProviderId=null;await writeFile(options.modelRegistryPath,JSON.stringify(r));
 await assert.rejects(inspectWorkerModels(options,'shared_self'),/WORKER_MODEL_UNAVAILABLE/);
 assert.ok(await inspectWorkerModels(options,'official'));
});
