import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {initializeDesktopData} from '../src/desktop-bootstrap.mjs';
import {createCredentialReader} from '../src/router-credentials.mjs';
async function api(){const m=await import('../src/desktop-ingress.mjs').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});assert.equal(typeof m.prepareDesktopIngress,'function');return m.prepareDesktopIngress;}
async function fixture(t){const dir=await mkdtemp(join(tmpdir(),'desktop-ingress-'));t.after(()=>rm(dir,{recursive:true,force:true}));const {host}=await initializeDesktopData(join(dir,'data'));const config=JSON.parse(await readFile(host.routerConfigPath));return {path:host.routerConfigPath,config,mapping:config.adapterOptions.credentialConfigPath,root:join(dir,'data')};}
const windows={skip:process.platform!=='win32'};
test('ingress generates encrypted random credential once without returning plaintext',windows,async t=>{
 const prepare=await api(),f=await fixture(t),before=await readFile(f.path,'utf8');
 assert.deepEqual(await prepare(f.path),{ok:true,status:'ready',created:true});
 const mapping=JSON.parse(await readFile(f.mapping));const secret=createCredentialReader(mapping).read(f.config.adapterOptions.ingressCredentialRef);
 assert.match(secret,/^[a-f0-9]{64}$/);const cipher=await readFile(mapping.credentials[0].filePath,'utf8');assert.ok(!cipher.includes(secret));
 assert.deepEqual(await prepare(f.path),{ok:true,status:'ready',created:false});assert.equal(await readFile(mapping.credentials[0].filePath,'utf8'),cipher);
 assert.equal(await readFile(f.path,'utf8'),before);
});
test('confirmed ciphertext can finish registration after mapping write interruption',windows,async t=>{
 const prepare=await api(),f=await fixture(t),empty=await readFile(f.mapping,'utf8');await prepare(f.path);
 const mapping=JSON.parse(await readFile(f.mapping)),cipher=await readFile(mapping.credentials[0].filePath,'utf8');
 await writeFile(f.mapping,empty);assert.equal((await prepare(f.path)).status,'ready');
 assert.equal(await readFile(mapping.credentials[0].filePath,'utf8'),cipher);
});
test('missing ciphertext or unknown ciphertext is never regenerated',windows,async t=>{
 const prepare=await api(),f=await fixture(t);await prepare(f.path);const mapping=JSON.parse(await readFile(f.mapping)),path=mapping.credentials[0].filePath;
 await rm(path);await assert.rejects(prepare(f.path),/DI_CREDENTIAL_CHANGED/);
 await writeFile(path,'unknown');await assert.rejects(prepare(f.path),/DI_CREDENTIAL_CHANGED/);assert.equal(await readFile(path,'utf8'),'unknown');
});
test('service lock and existing model binding refuse new credentials',windows,async t=>{
 const prepare=await api(),f=await fixture(t),empty=await readFile(f.mapping,'utf8'),lock=f.config.registryPath+'.service.lock';
 await writeFile(lock,'stale');await assert.rejects(prepare(f.path),/DI_SERVICE_ACTIVE/);await rm(lock);
 await writeFile(f.config.adapterOptions.bindingsPath,'[{}]');await assert.rejects(prepare(f.path),/DI_BINDINGS_PRESENT/);
 assert.equal(await readFile(f.mapping,'utf8'),empty);
});
test('recovery rechecks bindings and mapping conflicts before applying',windows,async t=>{
 const prepare=await api(),f=await fixture(t),empty=await readFile(f.mapping,'utf8');await prepare(f.path);await writeFile(f.mapping,empty);
 await writeFile(f.config.adapterOptions.bindingsPath,'[{}]');await assert.rejects(prepare(f.path),/DI_BINDINGS_PRESENT/);
 await writeFile(f.config.adapterOptions.bindingsPath,'[]');await writeFile(f.mapping,JSON.stringify({schemaVersion:1,credentials:[{credentialRef:'other',filePath:join(f.root,'other.dpapi')}]}));
 await assert.rejects(prepare(f.path),/DI_MAPPING_CONFLICT/);
});
test('ciphertext without a confirmation receipt is not adopted or overwritten',windows,async t=>{
 const prepare=await api(),f=await fixture(t),empty=await readFile(f.mapping,'utf8');await prepare(f.path);
 const mapping=JSON.parse(await readFile(f.mapping)),path=mapping.credentials[0].filePath,cipher=await readFile(path,'utf8');
 await writeFile(f.mapping,empty);await rm(path+'.receipt.json');
 await assert.rejects(prepare(f.path),/DI_CREDENTIAL_UNCERTAIN/);assert.equal(await readFile(path,'utf8'),cipher);assert.equal(await readFile(f.mapping,'utf8'),empty);
});
test('managed adapter consumes prepared ingress without opening upstream transport',windows,async t=>{
 const prepare=await api(),f=await fixture(t);await prepare(f.path);
 const {createManagedRouter}=await import('../src/managed-model-router.mjs');let calls=0;
 const router=await createManagedRouter({grant:{threadId:'11111111-1111-4111-8111-111111111111',expiresAt:null,remaining:null},options:f.config.adapterOptions,guardTransport:()=>async()=>{calls++;throw Error('NETWORK_FORBIDDEN');}});
 try{assert.equal(router.port,0);assert.equal(typeof router.handle,'function');assert.equal(calls,0);}finally{await router.close();}
});
test('stale startup identity refuses credential creation before writes',windows,async t=>{
 const prepare=await api(),f=await fixture(t),before=await readFile(f.mapping,'utf8');
 await assert.rejects(prepare(f.path,{expectedConfigIdentity:'stale'}),/DI_CONFIG_CHANGED/);assert.equal(await readFile(f.mapping,'utf8'),before);
});
