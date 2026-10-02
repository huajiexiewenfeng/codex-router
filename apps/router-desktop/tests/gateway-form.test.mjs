import test from 'node:test';
import assert from 'node:assert/strict';
import * as api from '../src/gateway-form.mjs';
const recovery={ok:true,operationId:'01234567-0123-0123-0123-012345678901',planSha256:'a'.repeat(64)};
function saveFixture(status='prepared'){
 const calls=[],items=new Map();
 const storage={setItem:(k,v)=>items.set(k,v),getItem:k=>items.get(k)??null};
 const request=async arg=>{calls.push(arg.operation);if(arg.operation==='gateway-prepare')return recovery;if(arg.operation==='gateway-inspect')return {status};if(arg.operation==='gateway-create-key'){assert.ok(items.size);assert.equal(arg.secret,'test-key');return {status:'credential-ready'};}return {status:'applied'};};
 return {calls,items,storage,request,secret:'test-key',form:{...api.initialGatewayForm(),models:'example'}};
}
test('one save prepares, persists receipt, encrypts and applies without persisting key',async()=>{
 assert.equal(typeof api.saveGateway,'function');const f=saveFixture();
 assert.equal((await api.saveGateway(f)).status,'applied');
 assert.deepEqual(f.calls,['gateway-prepare','gateway-create-key','gateway-apply']);
 assert.ok(!JSON.stringify([...f.items]).includes('test-key'));
});
test('receipt storage failure prevents key creation and keeps recovery in UI',async()=>{
 assert.equal(typeof api.saveGateway,'function');const f=saveFixture();let held;
 await assert.rejects(api.saveGateway({...f,storage:{setItem(){throw Error('quota');}},onReceipt:r=>held=r}),/quota/);
 assert.deepEqual(held,recovery);assert.deepEqual(f.calls,['gateway-prepare']);
});
test('recovery inspects before writes and does not require another key when encrypted',async()=>{
 assert.equal(typeof api.saveGateway,'function');
 for(const status of ['credential-ready','credentials-registered','applied']){
 const f=saveFixture(status);await api.saveGateway({...f,receipt:recovery,secret:''});
 assert.deepEqual(f.calls,status==='applied'?['gateway-inspect']:['gateway-inspect','gateway-apply']);}
});
test('uncertain credential and transport failures never trigger automatic retries',async()=>{
 assert.equal(typeof api.saveGateway,'function');const f=saveFixture('credential-uncertain');
 await assert.rejects(api.saveGateway({...f,receipt:recovery}),/GE_KEY_UNCERTAIN/);assert.deepEqual(f.calls,['gateway-inspect']);
 const g=saveFixture();await assert.rejects(api.saveGateway({...g,request:async a=>{if(a.operation==='gateway-create-key'){g.calls.push(a.operation);throw Error('lost');}return g.request(a);}}),/lost/);
 assert.deepEqual(g.calls,['gateway-prepare','gateway-create-key']);
});
test('invalid key is rejected before preparing anything',async()=>{
 assert.equal(typeof api.saveGateway,'function');const f=saveFixture();await assert.rejects(api.saveGateway({...f,secret:''}),/API Key/);assert.deepEqual(f.calls,[]);
});
test('gateway defaults are checked and syncing preserves manual names',async()=>{
 const api=await import('../src/gateway-form.mjs');
 assert.equal(typeof api.initialGatewayForm,'function');
 assert.equal(api.initialGatewayForm().allowHttp,true);assert.equal(api.initialGatewayForm().tools,true);
 assert.equal(api.mergeGatewayModels('manual\ngpt-6-sol',['gpt-6-sol','gpt-6-luna']),'manual\ngpt-6-sol\ngpt-6-luna');
});
test('receipt persistence fails closed and archive preserves current on storage failure',async()=>{
 const api=await import('../src/gateway-form.mjs');assert.equal(typeof api.persistGatewayReceipt,'function');
 const receipt={ok:true,operationId:'01234567-0123-0123-0123-012345678901',planSha256:'a'.repeat(64)},items=new Map();
 const store={setItem:(k,v)=>items.set(k,v),getItem:k=>items.get(k)??null,removeItem:k=>items.delete(k)};
 api.persistGatewayReceipt(store,receipt);const before=store.getItem(api.receiptStorageKey);assert.ok(before);
 const broken={...store,setItem:()=>{throw Error('quota');}};
 assert.throws(()=>api.persistGatewayReceipt(broken,receipt));assert.throws(()=>api.retainGatewayReceipt(broken,receipt));assert.equal(store.getItem(api.receiptStorageKey),before);
 api.retainGatewayReceipt(store,receipt);assert.equal(store.getItem(api.receiptStorageKey),null);assert.deepEqual(JSON.parse(store.getItem(api.receiptStorageKey+'.retained')),[receipt]);
 assert.throws(()=>api.persistGatewayReceipt({...store,setItem:()=>{}},receipt));
});
test('gateway form builds explicit capabilities and never includes Key',async()=>{
 const api=await import('../src/gateway-form.mjs').catch(()=>({}));assert.equal(typeof api.gatewayInput,'function');
 const input=api.gatewayInput({displayName:'公司',baseUrl:'https://example.com/v1',models:'gpt-6-sol\ngpt-6-luna',contextWindow:'262144',reasoning:'low,high,max',tools:true,allowHttp:false,secret:'must-not-copy'});
 assert.deepEqual(input.models,['gpt-6-sol','gpt-6-luna']);assert.equal(input.capabilities.contextWindow,262144);assert.equal(input.secret,undefined);
 assert.throws(()=>api.gatewayInput({...input,models:'',reasoning:'high',contextWindow:'wrong'}));
});
test('recovery receipt accepts only identifiers, never a secret or path',async()=>{
 const api=await import('../src/gateway-form.mjs').catch(()=>({}));assert.equal(typeof api.parseGatewayReceipt,'function');
 const value={ok:true,operationId:'01234567-0123-0123-0123-012345678901',planSha256:'a'.repeat(64)};
 assert.deepEqual(api.parseGatewayReceipt(JSON.stringify(value)),value);
 assert.throws(()=>api.parseGatewayReceipt(JSON.stringify({...value,secret:'unsafe'})));
 assert.throws(()=>api.parseGatewayReceipt('{}'));
});
