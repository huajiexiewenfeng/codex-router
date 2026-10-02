import test from 'node:test';
import assert from 'node:assert/strict';
const diagnostics=await import('../src/transport-diagnostics.mjs').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});

test('network diagnostics expose only allowlisted codes, never messages or hosts',()=>{
  assert.equal(typeof diagnostics.safeTransportFailure,'function');
  const e=new Error('secret-key internal-host');e.cause={code:'UND_ERR_CONNECT_TIMEOUT',message:'private body',address:'private-host'};
  assert.deepEqual(diagnostics.safeTransportFailure(e),{networkCode:'UND_ERR_CONNECT_TIMEOUT'});
  assert.deepEqual(diagnostics.safeTransportFailure({code:'secret-key'}),{networkCode:'UNKNOWN'});
  assert.deepEqual(diagnostics.safeTransportFailure({cause:{code:'ECONNRESET'}}),{networkCode:'ECONNRESET'});
});

test('diagnostics tolerate cyclic causes and hostile accessors',()=>{
  const cyclic={};cyclic.cause=cyclic;
  assert.deepEqual(diagnostics.safeTransportFailure(cyclic),{networkCode:'UNKNOWN'});
  assert.deepEqual(diagnostics.safeTransportFailure({get code(){throw Error('secret');}}),{networkCode:'UNKNOWN'});
});
