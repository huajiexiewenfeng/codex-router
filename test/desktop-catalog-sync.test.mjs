import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,mkdir,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {modelRegistry} from './fixtures/router-model-registry.mjs';
test('official discovery is read-only and combines trusted cache and bundled visible IDs',async()=>{
 const {readDesktopOfficialCatalog}=await import('../src/desktop-catalog-sync.mjs');const f=await fixture();
 const before=await readFile(f.catalog),configBefore=await readFile(f.configPath),registryBefore=await readFile(f.registryPath);
 await writeFile(join(f.root,'models_cache.json'),JSON.stringify({fetched_at:new Date().toISOString(),models:[{slug:'cached',visibility:'list'}]}));
 const result=await readDesktopOfficialCatalog({configPath:f.configPath,loadBundledModels:async()=>[{slug:'gpt-6.1-sol',visibility:'list'}]});
 assert.deepEqual(result.summary.discoveredModelIds,['cached','gpt-6.1-sol']);
 assert.equal(result.models.length,2);assert.deepEqual(await readdir(f.stateRoot),[]);
 assert.deepEqual(await readFile(f.catalog),before);assert.deepEqual(await readFile(f.configPath),configBefore);assert.deepEqual(await readFile(f.registryPath),registryBefore);
});
test('bundled additions complement fresh cache, preserve existing metadata and expose only trusted visible IDs',async()=>{
 const {syncDesktopCatalog}=await import('../src/desktop-catalog-sync.mjs');const f=await fixture();
 const fresh={slug:'gpt-6.1-sol',visibility:'list',model_messages:{instructions_template:'bundled verbatim'}};
 await writeFile(join(f.root,'models_cache.json'),JSON.stringify({fetched_at:new Date().toISOString(),models:[{slug:'gpt-6-sol',visibility:'list',source:'cache'}]}));
 const result=await syncDesktopCatalog({...f,bundledModels:[{slug:'gpt-6-sol',visibility:'hidden',source:'bundled'},fresh,{slug:'hidden-new',visibility:'hidden'}]});
 const output=JSON.parse(await readFile(f.catalog));
 assert.deepEqual(output.models.find(m=>m.slug===fresh.slug),fresh);
 assert.deepEqual(output.models.find(m=>m.slug===f.official.slug),f.official);
 assert.deepEqual(result.officialCatalog.discoveredModelIds,['gpt-6-sol','gpt-6.1-sol']);
 assert.equal(result.officialCatalog.bundledStatus,'loaded');
});
test('bundled loader failure is explicit and never trusts existing custom catalog IDs',async()=>{
 const {syncDesktopCatalog}=await import('../src/desktop-catalog-sync.mjs');const f=await fixture();
 const result=await syncDesktopCatalog({...f,loadBundledModels:async()=>{throw Error('sensitive path');}});
 assert.equal(result.officialCatalog.bundledStatus,'unavailable');
 assert.equal(result.officialCatalog.cloudVerified,false);
 assert.deepEqual(result.officialCatalog.discoveredModelIds,[]);
});
test('fresh cache wins bundled duplicate metadata while stale cache falls back to bundled',async()=>{
 const {syncDesktopCatalog}=await import('../src/desktop-catalog-sync.mjs');
 const cached={slug:'gpt-6.1-sol',visibility:'list',base_instructions:'cache original'};
 const bundled={...cached,base_instructions:'bundled original'};
 for(const stale of [false,true]){
  const f=await fixture();await writeFile(join(f.root,'models_cache.json'),JSON.stringify({fetched_at:stale?'2000-01-01T00:00:00Z':new Date().toISOString(),models:[cached]}));
  const result=await syncDesktopCatalog({...f,loadBundledModels:async()=>[bundled]});
  assert.deepEqual(JSON.parse(await readFile(f.catalog)).models.find(m=>m.slug===cached.slug),stale?bundled:cached);
  assert.equal(result.officialCatalog.status,stale?'bundled-merged':'cache-bundled-merged');
 }
});
test('invalid bundled output cannot import or authorize any model from that source',async()=>{
 const {syncDesktopCatalog}=await import('../src/desktop-catalog-sync.mjs');
 for(const bundledModels of [[],[{slug:'new',visibility:'list'},{slug:'new',visibility:'list'}],[{slug:'new',visibility:'list'},{slug:'one_self',visibility:'list'}]]){
  const f=await fixture();const result=await syncDesktopCatalog({...f,bundledModels});
  assert.equal(result.officialCatalog.bundledStatus,'invalid');assert.deepEqual(result.officialCatalog.discoveredModelIds,[]);
  assert.equal(JSON.parse(await readFile(f.catalog)).models.some(m=>m.slug==='new'),false);
 }
});
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'catalog-sync-'));const catalog=join(root,'custom.json'),configPath=join(root,'config.toml'),registryPath=join(root,'models.json'),stateRoot=join(root,'state');await mkdir(stateRoot);
 const registry={...modelRegistry(),activeProviderId:'one'};
 const official={slug:'gpt-6-sol',context_window:1000000,extra:{preserve:true}};
 await writeFile(catalog,JSON.stringify({metadata:'keep',models:[official,{slug:'unrelated_self',custom:true}]}));
 await writeFile(configPath,'model = "gpt-6-sol"\nmodel_catalog_json = '+JSON.stringify(catalog.replaceAll('\\','/'))+'\n');
 await writeFile(registryPath,JSON.stringify(registry));return {root,catalog,configPath,registryPath,stateRoot,registry,official};
}
test('sync preserves official and unrelated entries, backs up and removes disabled managed aliases',async()=>{
 const {syncDesktopCatalog}=await import('../src/desktop-catalog-sync.mjs');const f=await fixture();
 const before=await readFile(f.catalog),config=await readFile(f.configPath);
 const r=await syncDesktopCatalog(f);assert.equal(r.status,'updated');assert.equal(r.startupReloadRequired,true);
 let output=JSON.parse(await readFile(f.catalog));assert.deepEqual(output.models[0],f.official);assert.equal(output.models[1].slug,'unrelated_self');assert.equal(output.models[2].slug,'one_self');assert.equal(output.metadata,'keep');
 assert.deepEqual(await readFile(f.configPath),config);
 const backups=(await readdir(f.stateRoot)).filter(n=>n.endsWith('.bak'));assert.equal(backups.length,1);assert.deepEqual(await readFile(join(f.stateRoot,backups[0])),before);
 assert.equal((await syncDesktopCatalog(f)).status,'unchanged');
 f.registry.models[0].enabled=false;await writeFile(f.registryPath,JSON.stringify(f.registry));await syncDesktopCatalog(f);
 output=JSON.parse(await readFile(f.catalog));assert.deepEqual(output.models.map(m=>m.slug),['gpt-6-sol','unrelated_self']);
});
test('switching gateway removes previously owned models while preserving new official entries',async()=>{
 const {syncDesktopCatalog}=await import('../src/desktop-catalog-sync.mjs');const f=await fixture();await syncDesktopCatalog(f);
 const output=JSON.parse(await readFile(f.catalog));output.models.push({slug:'new-official',future:true});await writeFile(f.catalog,JSON.stringify(output));
 f.registry.models=f.registry.models.filter(m=>m.providerId==='two');f.registry.activeProviderId='two';await writeFile(f.registryPath,JSON.stringify(f.registry));await syncDesktopCatalog(f);
 const slugs=JSON.parse(await readFile(f.catalog)).models.map(m=>m.slug);assert.deepEqual(slugs,['gpt-6-sol','unrelated_self','new-official','two_self']);
});
test('missing catalog configuration and official cache target are not overwritten',async()=>{
 const {syncDesktopCatalog}=await import('../src/desktop-catalog-sync.mjs');const f=await fixture();await writeFile(f.configPath,'model="gpt-6-sol"');
 await assert.rejects(()=>syncDesktopCatalog(f),/DCM_NOT_CONFIGURED/);
 await writeFile(f.configPath,'model_catalog_json='+JSON.stringify(join(f.root,'models_cache.json').replaceAll('\\','/')));
 await assert.rejects(()=>syncDesktopCatalog(f),/DCM_TARGET/);
});
test('held catalog lock and damaged ownership cannot overwrite the catalog',async()=>{
 const {syncDesktopCatalog}=await import('../src/desktop-catalog-sync.mjs');const f=await fixture();
 const before=await readFile(f.catalog);await writeFile(f.catalog+'.router-catalog.lock','held');
 await assert.rejects(()=>syncDesktopCatalog(f),/DCM_LOCKED/);assert.deepEqual(await readFile(f.catalog),before);
 // A separate fixture tests corrupted ownership without removing anyone else's lock.
 const g=await fixture();await syncDesktopCatalog(g);const updated=await readFile(g.catalog);
 const owner=(await readdir(g.stateRoot)).find(n=>n.endsWith('.json'));await writeFile(join(g.stateRoot,owner),JSON.stringify({schemaVersion:1,catalogPath:g.catalog,managedSlugs:['gpt-6-sol']}));
 await assert.rejects(()=>syncDesktopCatalog(g),/DCM_OWNERSHIP/);assert.deepEqual(await readFile(g.catalog),updated);
});

test('sync does not silently rewrite or inherit instruction metadata',async()=>{
 const {syncDesktopCatalog}=await import('../src/desktop-catalog-sync.mjs');const f=await fixture();
 const legacy="You are Codex, a coding assistant. Follow the user's authorized task and applicable project instructions. Use available tools when needed, subject to sandbox and approval policies. Never claim tool actions or results that did not occur. A request to avoid tools for a connectivity test applies only to that test, not to later tasks.";
 f.registry.models[0].catalogEntry.base_instructions=legacy;
 await writeFile(f.registryPath,JSON.stringify(f.registry));
 const base=JSON.parse(await readFile(f.catalog));base.models[0].model_messages={instructions_template:'Complete native workflow and commentary instructions'};
 base.models.push({...f.registry.models[0].catalogEntry});await writeFile(f.catalog,JSON.stringify(base));
 const before=await readFile(f.catalog),config=await readFile(f.configPath);
 assert.equal((await syncDesktopCatalog(f)).status,'unchanged');const out=JSON.parse(await readFile(f.catalog));
 assert.deepEqual(out.models[0],base.models[0]);assert.equal(out.models[2].base_instructions,legacy);
 assert.equal(Object.hasOwn(out.models[2],'model_messages'),false);
 assert.deepEqual(await readFile(f.configPath),config);
 assert.deepEqual(await readFile(f.catalog),before);
 assert.equal((await syncDesktopCatalog(f)).status,'unchanged');
});

test('sync adds newly discovered official models verbatim without rewriting existing models or cache',async()=>{
 const {syncDesktopCatalog}=await import('../src/desktop-catalog-sync.mjs');const f=await fixture();
 const fresh={slug:'gpt-6.1-sol',display_name:'GPT-6.1 Sol',visibility:'list',context_window:1050000,model_messages:{instructions_template:'native fixture'},future_field:{keep:true}};
 const cache=join(f.root,'models_cache.json');
 await writeFile(cache,JSON.stringify({fetched_at:new Date().toISOString(),models:[{...f.official,context_window:42},fresh]}));
 const cacheBytes=await readFile(cache),registryBytes=await readFile(f.registryPath),configBytes=await readFile(f.configPath);
 const result=await syncDesktopCatalog(f),out=JSON.parse(await readFile(f.catalog));
 assert.deepEqual(out.models.find(m=>m.slug===fresh.slug),fresh);
 assert.deepEqual(out.models.find(m=>m.slug===f.official.slug),f.official);
 assert.equal(result.officialCatalog.status,'cache-merged');assert.equal(result.officialCatalog.addedCount,1);
 assert.equal(result.officialCatalog.cloudVerified,false);
 assert.deepEqual(await readFile(cache),cacheBytes);assert.deepEqual(await readFile(f.registryPath),registryBytes);assert.deepEqual(await readFile(f.configPath),configBytes);
 const again=await syncDesktopCatalog(f);assert.equal(again.status,'unchanged');assert.equal(again.officialCatalog.addedCount,0);
});

test('missing, old and malformed official caches do not prevent company sync or claim official freshness',async()=>{
 const {syncDesktopCatalog}=await import('../src/desktop-catalog-sync.mjs');
 const cases=[['missing',null],['invalid','not json'],['stale',JSON.stringify({fetched_at:'2000-01-01T00:00:00Z',models:[{slug:'old-official'}]})],['invalid',JSON.stringify({models:[{slug:'new-official'}]})],['invalid',JSON.stringify({fetched_at:new Date().toISOString(),models:[]})]];
 for(const [status,contents] of cases){
  const f=await fixture();if(contents!==null)await writeFile(join(f.root,'models_cache.json'),contents);
  const result=await syncDesktopCatalog(f);
  assert.equal(result.officialCatalog.status,status);assert.equal(result.officialCatalog.cloudVerified,false);
  assert.deepEqual(JSON.parse(await readFile(f.catalog)).models.map(m=>m.slug),['gpt-6-sol','unrelated_self','one_self']);
 }
});

test('ambiguous or company-contaminated official caches are not imported',async()=>{
 const {syncDesktopCatalog}=await import('../src/desktop-catalog-sync.mjs');
 for(const models of [[{slug:'duplicate'},{slug:'duplicate'}],[{slug:'new-official'},{slug:'one_self'}],[{slug:'new-official'},{slug:'alien_self'}]]){
  const f=await fixture();await writeFile(join(f.root,'models_cache.json'),JSON.stringify({fetched_at:new Date().toISOString(),models}));
  const result=await syncDesktopCatalog(f);assert.equal(result.officialCatalog.status,'invalid');
  assert.deepEqual(JSON.parse(await readFile(f.catalog)).models.map(m=>m.slug),['gpt-6-sol','unrelated_self','one_self']);
 }
});
