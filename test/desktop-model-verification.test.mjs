import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,mkdir,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {modelRegistry,binding} from './fixtures/router-model-registry.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'model-verify-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const paths={modelRegistryPath:join(dir,'models.json'),bindingsPath:join(dir,'bindings.json'),credentialConfigPath:join(dir,'credentials.json'),evidenceRoot:join(dir,'evidence'),checkConfig:async()=>{}};
 await mkdir(paths.evidenceRoot);const registry=modelRegistry();registry.models[0].readiness='pending';registry.models[0].enabled=false;delete registry.models[0].verificationRef;delete registry.models[0].catalogEntry;
 await writeFile(paths.modelRegistryPath,JSON.stringify(registry));await writeFile(paths.bindingsPath,JSON.stringify([binding]));
 const cipher=join(dir,'key.dpapi');await writeFile(cipher,'encrypted-fixture');await writeFile(paths.credentialConfigPath,JSON.stringify({schemaVersion:1,credentials:[{credentialRef:'one-key',filePath:cipher}]}));
 const request={modelId:'model-one',revision:hash(await readFile(paths.modelRegistryPath)),confirmed:true};
 const api=await import('../src/desktop-model-verification.mjs');
 const proof={ok:true,scope:'responses-stream-text',httpStatus:200,completed:true,markerMatched:true,bytes:200,bodySha256:'a'.repeat(64),toolsVerified:false,contextLimitVerified:false,workerVerified:false};
 return {dir,paths,request,proof,api};
}
test('host verification records text evidence only and preserves selection and bindings',async t=>{
 const f=await fixture(t),before=await readFile(f.paths.bindingsPath,'utf8');let calls=0;
 const result=await f.api.verifyDesktopModel(f.paths,f.request,{credentialReader:()=>({read:()=> 'fixture-key'}),verify:async input=>{calls++;assert.equal(input.secret,'fixture-key');assert.equal(input.model,'gpt-6-sol');return f.proof;}});
 assert.equal(calls,1);assert.equal(result.ok,true);
 const registry=JSON.parse(await readFile(f.paths.modelRegistryPath));assert.equal(registry.models[0].readiness,'verified');assert.equal(registry.models[0].enabled,false);
 assert.equal(await readFile(f.paths.bindingsPath,'utf8'),before);assert.equal(registry.generation,2);
 const evidence=await readFile(join(f.paths.evidenceRoot,registry.models[0].verificationRef+'.json'),'utf8');
 assert.equal(JSON.parse(evidence).proof.toolsVerified,false);assert.equal(evidence.includes('fixture-key'),false);
 assert.ok((await readdir(f.dir)).some(n=>n.includes('verification-backup')));
});
test('host refuses missing confirmation and stale revision without calling upstream',async t=>{
 const f=await fixture(t);let calls=0;const deps={verify:async()=>{calls++;return f.proof;}};
 await assert.rejects(f.api.verifyDesktopModel(f.paths,{...f.request,confirmed:false},deps),/GV_CONFIRM/);
 await assert.rejects(f.api.verifyDesktopModel(f.paths,{...f.request,revision:'b'.repeat(64)},deps),/DESKTOP_CONFIG_STALE/);
 assert.equal(calls,0);
});
test('failure and concurrent configuration changes never promote model',async t=>{
 const f=await fixture(t),before=await readFile(f.paths.modelRegistryPath,'utf8');
 const deps={credentialReader:()=>({read:()=> 'fixture-key'}),verify:async()=>{throw Error('GV_HTTP');}};
 await assert.rejects(f.api.verifyDesktopModel(f.paths,f.request,deps),/GV_HTTP/);assert.equal(await readFile(f.paths.modelRegistryPath,'utf8'),before);
 deps.verify=async()=>{await writeFile(f.paths.credentialConfigPath,'{}');return f.proof;};
 await assert.rejects(f.api.verifyDesktopModel(f.paths,f.request,deps),/DESKTOP_CONFIG_STALE/);assert.equal(await readFile(f.paths.modelRegistryPath,'utf8'),before);
});
