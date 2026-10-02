import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {modelRegistry} from './fixtures/router-model-registry.mjs';
const input={displayName:'隔离测试网关',baseUrl:'https://new.example/v1',allowHttp:false,models:['gpt-6-luna'],capabilities:{contextWindow:262144,inputModalities:['text'],tools:true,reasoningEfforts:['high']}};
async function fixture(){
 const api=await import('../src/gateway-enrollment.mjs').catch(()=>({}));assert.equal(typeof api.createGatewayEnrollment,'function');
 const dir=await mkdtemp(join(tmpdir(),'gateway-enrollment-')),options={modelRegistryPath:join(dir,'models.json'),credentialConfigPath:join(dir,'credentials.json'),bindingsPath:join(dir,'bindings.json'),operationRoot:join(dir,'operations')};
 await mkdir(options.operationRoot);await writeFile(options.modelRegistryPath,JSON.stringify(modelRegistry()));await writeFile(options.credentialConfigPath,JSON.stringify({schemaVersion:1,credentials:[]}));await writeFile(options.bindingsPath,'[]');
 return {dir,options,api,host:await api.createGatewayEnrollment(options)};
}
test('persistent preparation contains no Key and applies only after DPAPI creation',{skip:process.platform!=='win32'},async()=>{
 const f=await fixture(),receipt=await f.host.prepare(input);assert.equal(receipt.ok,true);
 assert.equal((await f.host.inspect(receipt)).status,'prepared');assert.equal((await f.host.apply(receipt)).code,'GE_KEY_REQUIRED');
 const created=await f.host.createKey(receipt,'fixture-enrollment-only');assert.equal(created.status,'credential-ready');
 assert.equal((await f.host.createKey(receipt,'must-not-replace')).status,'credential-ready');
 const recovered=await f.api.createGatewayEnrollment(f.options);assert.equal((await recovered.apply(receipt)).status,'applied');assert.equal((await recovered.apply(receipt)).status,'applied');
 const registry=JSON.parse(await readFile(f.options.modelRegistryPath));assert.equal(registry.generation,2);assert.equal(registry.models.at(-1).enabled,false);
 const mapping=JSON.parse(await readFile(f.options.credentialConfigPath));assert.equal(mapping.credentials.length,1);
 const cipher=await readFile(mapping.credentials[0].filePath,'utf8');assert.doesNotMatch(cipher,/fixture|must-not/);
 const plan=await readFile(join(f.options.operationRoot,receipt.operationId,'plan.json'),'utf8');assert.doesNotMatch(plan,/fixture-enrollment-only|must-not-replace/);
});
test('recovery finishes registry after credential mapping was committed',{skip:process.platform!=='win32'},async()=>{
 const f=await fixture(),r=await f.host.prepare(input);await f.host.createKey(r,'fixture-prefix');
 const plan=JSON.parse(await readFile(join(f.options.operationRoot,r.operationId,'plan.json')));
 await writeFile(f.options.credentialConfigPath,plan.targetCredentials);
 const recovered=await f.api.createGatewayEnrollment(f.options);assert.equal((await recovered.inspect(r)).status,'credentials-registered');assert.equal((await recovered.apply(r)).status,'applied');
});
test('unknown ciphertext is not overwritten and malformed receipt never selects a path',async()=>{
 const f=await fixture(),r=await f.host.prepare(input),directory=join(f.options.operationRoot,r.operationId);
 await writeFile(join(directory,'secret.dpapi'),'unknown-cipher');
 assert.equal((await f.host.createKey(r,'fixture-refused')).code,'GE_KEY_UNCERTAIN');assert.equal(await readFile(join(directory,'secret.dpapi'),'utf8'),'unknown-cipher');
 assert.equal((await f.host.inspect({...r,operationId:'../elsewhere'})).ok,false);
 assert.equal((await f.host.inspect({...r,path:'elsewhere'})).ok,false);
});
test('configuration conflicts and held locks refuse writes',{skip:process.platform!=='win32'},async()=>{
 for(const key of ['modelRegistryPath','credentialConfigPath']){
  const f=await fixture(),r=await f.host.prepare(input);await f.host.createKey(r,'fixture-conflict');
  const changed=(await readFile(f.options[key],'utf8'))+' ';await writeFile(f.options[key],changed);
  assert.equal((await f.host.apply(r)).code,'GE_CONFLICT');assert.equal(await readFile(f.options[key],'utf8'),changed);
 }
 const f=await fixture(),r=await f.host.prepare(input);await writeFile(f.options.modelRegistryPath+'.model-update.lock','test-lock');
 assert.equal((await f.host.apply(r)).code,'GE_LOCKED');
});
test('tampered plan is rejected before any credential creation',async()=>{
 const f=await fixture(),r=await f.host.prepare(input),path=join(f.options.operationRoot,r.operationId,'plan.json');
 await writeFile(path,(await readFile(path,'utf8'))+' ');
 assert.equal((await f.host.createKey(r,'fixture-never-written')).code,'GE_PLAN_CHANGED');
});
test('lost or changed ciphertext cannot be silently recreated',{skip:process.platform!=='win32'},async()=>{
 const f=await fixture(),r=await f.host.prepare(input),cipher=join(f.options.operationRoot,r.operationId,'secret.dpapi');
 await f.host.createKey(r,'fixture-original');await unlink(cipher);
 assert.equal((await f.host.createKey(r,'fixture-replacement')).code,'GE_KEY_CHANGED');
 await writeFile(cipher,'modified');assert.equal((await f.host.apply(r)).code,'GE_KEY_CHANGED');
});
test('apply respects credential writer lock',{skip:process.platform!=='win32'},async()=>{
 const f=await fixture(),r=await f.host.prepare(input);await f.host.createKey(r,'fixture-lock');
 await writeFile(join(f.options.operationRoot,r.operationId,'secret.dpapi.credential.lock'),'test-owner');
 assert.equal((await f.host.apply(r)).code,'GE_LOCKED');
 assert.equal(JSON.parse(await readFile(f.options.modelRegistryPath)).generation,1);
});
test('bad host path produces stable error without exposing filesystem path',async()=>{
 const f=await fixture();
 await assert.rejects(()=>f.api.createGatewayEnrollment({...f.options,modelRegistryPath:join(f.dir,'missing-private-path')}),{message:'GE_HOST_CONFIG'});
});
