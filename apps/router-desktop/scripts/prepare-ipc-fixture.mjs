// Creates NEW isolated test data only. No real credentials or online config.
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {modelRegistry,binding} from '../../../test/fixtures/router-model-registry.mjs';
import {validateModelRegistry} from '../../../src/model-registry.mjs';
const dir=await mkdtemp(join(tmpdir(),'router-desktop-ipc-'));
const models=join(dir,'models.json'),bindings=join(dir,'bindings.json'),config=join(dir,'config.json'),drafts=join(dir,'drafts');
await mkdir(drafts);
await writeFile(join(dir,'unused'),JSON.stringify({schemaVersion:1,credentials:[]}));
const registry=modelRegistry();
const acceptance=process.argv.includes('--acceptance');
if(acceptance){
 const template=registry.models[0];
 registry.models=Array.from({length:25},(_,index)=>{
  const number=String(index+1).padStart(2,'0'),name=`model-${number}`;
  return {...structuredClone(template),modelId:name,selectionId:name+'_self',upstreamModel:name,displayName:name,enabled:index<5,catalogEntry:{...structuredClone(template.catalogEntry),slug:name+'_self',display_name:name}};
 });
}
validateModelRegistry(registry);
await writeFile(models,JSON.stringify(registry));
await writeFile(bindings,JSON.stringify(acceptance?[{...binding,allowedModels:['model-01_self']},{...binding,threadId:'00000000-0000-4000-8000-000000000003',allowedModels:['model-01_self']}]:[]));
await writeFile(config,JSON.stringify({adapterPath:join(dir,'adapter.mjs'),adapterSha256:'a'.repeat(64),registryPath:join(dir,'registry'),port:0,adapterOptions:{schemaVersion:1,modelRegistryPath:models,bindingsPath:bindings,credentialConfigPath:join(dir,'unused'),ingressCredentialRef:'ingress',officialModels:['gpt-6-sol'],port:0,officialProxyUrl:null}}));
const host=join(dir,'host.json');
await writeFile(host,JSON.stringify({nodePath:process.execPath,scriptPath:fileURLToPath(new URL('../../../src/desktop-stdio.mjs',import.meta.url)),routerConfigPath:config,draftRoot:drafts}));
console.log(host);
