import test from 'node:test';
import assert from 'node:assert/strict';
const api=async()=>{const m=await import('../src/model-state.mjs').catch(()=>({}));assert.equal(typeof m.summarize,'function','model state module exists');return m;};
const models=()=>Array.from({length:6},(_,i)=>({id:`m${i}`,upstream:`model-${i}`,selectionId:`model-${i}_self`,enabled:i<5,readiness:i<3?'verified':'pending'}));
test('summary displays only three selected models and does not promote readiness',async()=>{
 const {summarize}=await api();const r=summarize(models());assert.equal(r.preview.length,3);assert.equal(r.enabled,5);assert.equal(r.total,6);assert.equal(r.ready,3);
});
test('search and selected filters compose without modifying records',async()=>{
 const {filterModels}=await api();const m=models();assert.deepEqual(filterModels(m,' MODEL-4 ','enabled').map(x=>x.id),['m4']);assert.equal(filterModels(m,'','disabled').length,1);assert.equal(m[4].readiness,'pending');
});
test('selection draft is isolated until commit; unknown models are rejected',async()=>{
 const {setEnabled}=await api();const original=models();const draft=setEnabled(original,'m5',true);assert.equal(original[5].enabled,false);assert.equal(draft[5].enabled,true);assert.equal(draft[5].readiness,'pending');assert.throws(()=>setEnabled(original,'missing',true));
});
test('gateway draft validates HTTPS, duplicates and empty fields; no secrets are returned',async()=>{
 const {gatewayFromDraft}=await api();const draft={name:' Test ',url:'https://gateway.example.com/v1',models:['gpt-6-sol'],key:'DO_NOT_STORE'};
 const g=gatewayFromDraft(draft,[]);assert.equal(g.name,'Test');assert.equal(g.models[0].selectionId,'gpt-6-sol_self');assert.equal(g.models[0].enabled,false);assert.doesNotMatch(JSON.stringify(g),/DO_NOT_STORE/);
 for(const change of [{name:''},{url:'http://gateway.example.com/v1'},{url:'https://user:pass@example.com/v1'},{url:'https://example.com/v1?key=abc'},{models:['sol','sol']},{models:['bad model']}])assert.throws(()=>gatewayFromDraft({...draft,...change},[]));
 assert.throws(()=>gatewayFromDraft(draft,[g]),/已存在/);
});
