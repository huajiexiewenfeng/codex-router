import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const api=await import('../src/desktop-codex-discovery.mjs').catch(()=>({}));
test('discovery selects the manifest desktop entry rather than backend CLI',async t=>{
 assert.equal(typeof api.discoverDesktopCodex,'function');
 const root=await mkdtemp(join(tmpdir(),'codex-discovery-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const home=join(root,'home'),app=join(root,'package','app');await mkdir(home);await mkdir(app,{recursive:true});
 await writeFile(join(app,'ChatGPT.exe'),'fixture, never executed');
 const record={installLocation:join(root,'package'),executable:'app/ChatGPT.exe'};
 const result=await api.discoverDesktopCodex({codexHome:home,queryPackages:async()=>[record]});
 assert.equal(result.codexHome,home);assert.equal(result.desktopExecutable,join(app,'ChatGPT.exe'));
 for(const records of [[],[record,record],[{...record,executable:'../outside.exe'}],[{...record,executable:join(app,'ChatGPT.exe')}],[{...record,executable:'app/missing.exe'}]]){
  await assert.rejects(api.discoverDesktopCodex({codexHome:home,queryPackages:async()=>records}),/^Error: DCD_[A-Z_]+$/);
 }
 await assert.rejects(api.discoverDesktopCodex({codexHome:home,queryPackages:async()=>{throw Error('sensitive detail');}}),/^Error: DCD_UNAVAILABLE$/);
});
test('running guard includes the Store desktop process name',async()=>{
 const {readFile}=await import('node:fs/promises');
 const source=await readFile(new URL('../src/desktop-codex-launch.mjs',import.meta.url),'utf8');
 assert.match(source,/ProcessName -ieq 'ChatGPT'/);
});

test('backend discovery requires the registered package resource, never a PATH fallback',async t=>{
 assert.equal(typeof api.discoverDesktopBackend,'function');
 const root=await mkdtemp(join(tmpdir(),'codex-backend-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const home=join(root,'home'),app=join(root,'package','app');await mkdir(home);await mkdir(join(app,'resources'),{recursive:true});
 await writeFile(join(app,'ChatGPT.exe'),'fixture');
 const options={codexHome:home,queryPackages:async()=>[{installLocation:join(root,'package'),executable:'app/ChatGPT.exe'}]};
 await assert.rejects(api.discoverDesktopBackend(options),/^Error: DCD_BACKEND_UNAVAILABLE$/);
 await writeFile(join(app,'resources','codex.exe'),'fixture, never executed');
 const result=await api.discoverDesktopBackend(options);
 assert.equal(result.codexExecutable,join(app,'resources','codex.exe'));assert.equal(result.codexHome,home);
});
