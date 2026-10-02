import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initializeRouterRegistry,registerRouterBudget,readRouterRegistry} from '../src/router-registry.mjs';
test('registration rejects loopback administrative shares instead of persisting SMB paths',{skip:process.platform!=='win32'},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'router-local-path-')),registry=join(dir,'workers.jsonl');
 initializeRouterRegistry(registry);
 assert.throws(()=>registerRouterBudget(registry,'\\\\localhost\\C$\\ledger.jsonl'),/BUDGET_LOCAL_PATH_REQUIRED/);
 assert.deepEqual(readRouterRegistry(registry).bindings,[]);
});
