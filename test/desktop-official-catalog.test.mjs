import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
test('bundled discovery uses verified absolute executable and bounded hidden offline command',async()=>{
 const {readBundledOfficialModels}=await import('../src/desktop-official-catalog.mjs');
 const root=await mkdtemp(join(tmpdir(),'official-models-')),exe=join(root,'codex.exe');await writeFile(exe,'fixture');
 const models=[{slug:'gpt-6.1-sol',visibility:'list',base_instructions:'native'}];
 const result=await readBundledOfficialModels({codexExecutable:exe,execFileImpl:async(file,args,options)=>{
  assert.equal(file,exe);assert.deepEqual(args,['debug','models','--bundled']);
  assert.equal(options.windowsHide,true);assert.equal(options.shell,false);assert.ok(options.timeout>0);assert.ok(options.maxBuffer<=16*1024*1024);
  return {stdout:JSON.stringify({models})};
 }});assert.deepEqual(result,models);
 await assert.rejects(()=>readBundledOfficialModels({codexExecutable:'codex.exe',execFileImpl:()=>assert.fail('must not execute')}),/DOC_EXECUTABLE/);
 await assert.rejects(()=>readBundledOfficialModels({codexExecutable:join(root,'missing.exe'),execFileImpl:()=>assert.fail('must not execute')}),/DOC_EXECUTABLE/);
 await assert.rejects(()=>readBundledOfficialModels({codexExecutable:exe,execFileImpl:async()=>({stdout:JSON.stringify({models:[{slug:'injected_self'}]})})}),/DOC_MODELS/);
 await assert.rejects(()=>readBundledOfficialModels({codexExecutable:exe,execFileImpl:async()=>{throw Error('private installation path');}}),/^Error: DOC_UNAVAILABLE$/);
 await assert.rejects(()=>readBundledOfficialModels({codexExecutable:exe,execFileImpl:async()=>({stdout:'not JSON'})}),/DOC_MODELS/);
});
