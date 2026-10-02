import test from 'node:test';
import assert from 'node:assert/strict';
test('creation view never treats persistence as desktop acceptance or offers replay',async()=>{
 const {workerCreationView}=await import('../src/worker-creation-view.mjs');
 assert.equal(workerCreationView({status:'prepared'}).canStart,true);
 for(const status of ['starting','creation-in-progress','created','initialization-requested','needs-reconciliation','initialized-awaiting-desktop-confirmation']){
  const v=workerCreationView({status});assert.equal(v.canStart,false);assert.equal(v.canRefresh,true);
 }
 assert.match(workerCreationView({status:'needs-reconciliation'}).message,/不.*重复/);
 assert.match(workerCreationView({status:'initialized-awaiting-desktop-confirmation'}).message,/原生/);
});
