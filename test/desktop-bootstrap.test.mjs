import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
async function api(){const m=await import('../src/desktop-bootstrap.mjs').catch(()=>({}));assert.equal(typeof m.initializeDesktopData,'function');return m.initializeDesktopData;}
test('first start creates empty configuration, reopening preserves edits',async()=>{
 const init=await api(),root=join(await mkdtemp(join(tmpdir(),'desktop-init-')),'data');
 const first=await init(root);assert.equal(first.created,true);
 const {createDesktopConfigBridge}=await import('../src/desktop-config-bridge.mjs');
 const bridge=await createDesktopConfigBridge(first.host);assert.equal((await bridge.dispatch({operation:'read'})).models.length,0);
 const path=join(root,'models.json'),registry=JSON.parse(await readFile(path));registry.generation=9;const bytes=JSON.stringify(registry);await writeFile(path,bytes);
 assert.equal((await init(root)).created,false);assert.equal(await readFile(path,'utf8'),bytes);
 const config=JSON.parse(await readFile(first.host.routerConfigPath));assert.deepEqual(config.adapterOptions.officialModels,[]);
 assert.deepEqual(JSON.parse(await readFile(join(root,'credentials.json'))),{schemaVersion:1,credentials:[]});
});
test('incomplete and corrupt data are rejected without overwriting',async()=>{
 const init=await api(),root=join(await mkdtemp(join(tmpdir(),'desktop-init-')),'data');await mkdir(root);await writeFile(join(root,'models.json'),'keep');
 await assert.rejects(init(root),/DB_INCOMPLETE/);assert.equal(await readFile(join(root,'models.json'),'utf8'),'keep');
 const ready=join(await mkdtemp(join(tmpdir(),'desktop-init-')),'data');await init(ready);await writeFile(join(ready,'credentials.json'),'broken');
 await assert.rejects(init(ready),/DB_INVALID/);assert.equal(await readFile(join(ready,'credentials.json'),'utf8'),'broken');
 await assert.rejects(init('relative'),/DB_PATH/);
});
test('concurrent initialization never overwrites another creator',async()=>{
 const init=await api(),root=join(await mkdtemp(join(tmpdir(),'desktop-init-')),'data');
 const results=await Promise.allSettled([init(root),init(root)]);
 assert.equal(results.filter(r=>r.status==='fulfilled'&&r.value.created).length,1);
 assert.equal((await init(root)).created,false);
});
test('corrupt binding entries are rejected without altering their bytes',async()=>{
 const init=await api(),root=join(await mkdtemp(join(tmpdir(),'desktop-init-')),'data');await init(root);
 for(const bytes of ['[null]','[{}]']){
  await writeFile(join(root,'bindings.json'),bytes);await assert.rejects(init(root),/DB_INVALID/);assert.equal(await readFile(join(root,'bindings.json'),'utf8'),bytes);
 }
});
