import test from 'node:test';
import assert from 'node:assert/strict';
import * as api from '../src/worker-mode.mjs';

test('missing mode yields the two choices with no implied default or creation',()=>{
  assert.equal(typeof api.workerModePlan,'function');
  const result=api.workerModePlan({title:'Worker-Test'});
  assert.equal(result.status,'needs_user_choice');
  assert.deepEqual(result.question.options.map(o=>o.value),['official','router']);
  assert.equal(result.createsThread,false);
  assert.equal(result.question.default,undefined);
});
test('explicit Router is not asked again and prefix is added once without mutating input',()=>{
  assert.equal(typeof api.workerModePlan,'function');
  const request={mode:'router',title:'Worker-Test',model:'gpt-6-sol_self'};
  const result=api.workerModePlan(request);
  assert.equal(result.status,'mode_selected');assert.equal(result.question,undefined);
  assert.equal(result.title,'Router-Worker-Test');assert.equal(result.mode,'router');
  assert.equal(api.workerModePlan({...request,title:result.title}).title,result.title);
  assert.equal(result.requiresTaskBinding,true);assert.equal(result.createsThread,false);
  assert.equal(request.title,'Worker-Test');
});
test('official uses native title, rejects self aliases and misleading Router prefix',()=>{
  assert.equal(typeof api.workerModePlan,'function');
  assert.equal(api.workerModePlan({mode:'official',title:'Worker-Test'}).title,'Worker-Test');
  for(const model of ['gpt-6-sol_self','gpt-5.6-terra-self'])
    assert.throws(()=>api.workerModePlan({mode:'official',title:'Worker-Test',model}),/WORKER_OFFICIAL_SELF_MODEL/);
  assert.throws(()=>api.workerModePlan({mode:'official',title:'Router-Test'}),/WORKER_TITLE_ROUTE_CONFLICT/);
});
test('invalid mode cannot silently fall back, error values are not reflected',()=>{
  assert.equal(typeof api.workerModePlan,'function');
  for(const mode of ['company','Bearer-private',null,{},1])
    assert.throws(()=>api.workerModePlan({mode,title:'Test'}),/^Error: WORKER_MODE_INVALID$/);
  assert.throws(()=>api.workerModePlan({mode:'router',title:'x'.repeat(200)}),/WORKER_TITLE_INVALID/);
});
