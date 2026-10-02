import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

async function api(){let module;try{module=await import('../src/router-credentials.mjs');}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;}assert.equal(typeof module?.createCredentialReader,'function','credential reader must exist');return module;}
const config=(entries)=>({schemaVersion:1,credentials:entries});
test('configuration is strict, unique and local; constructing never reads credentials',async()=>{
 const {createCredentialReader}=await api();
 const entry={credentialRef:'company-key',filePath:'C:\\private\\missing.dpapi'};
 const reader=createCredentialReader(config([entry]));assert.equal(typeof reader.read,'function');
 for(const bad of [
  {...config([]),extra:true},config([{...entry,key:'fixture-secret'}]),config([entry,entry]),
  config([{...entry,filePath:'relative.dpapi'}]),config([{...entry,filePath:'\\\\server\\share\\key.dpapi'}]),
  config([{...entry,filePath:'C:\\key.dpapi:stream'}]),config([{...entry,credentialRef:'sk-fixture'}]),
  config([entry,{credentialRef:'second-key',filePath:'c:/private/MISSING.dpapi'}]),
  {schemaVersion:2,credentials:[]}
 ])assert.throws(()=>createCredentialReader(bad),{message:'RC_CONFIG'});
 assert.throws(()=>reader.read('not-configured'),{message:'RC_REFERENCE'});
 entry.credentialRef='changed';assert.throws(()=>reader.read('changed'),{message:'RC_REFERENCE'});
});

test('Windows DPAPI roundtrip reads exactly the selected fake credential without printing it',{skip:process.platform!=='win32'},async()=>{
 const {createCredentialReader}=await api(),dir=await mkdtemp(join(tmpdir(),'router-keys-'));
 const paths=['one','two'].map(n=>join(dir,n+'.dpapi'));
 const encrypt=token=>execFileSync(join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-Command',"$ErrorActionPreference='Stop'; Import-Module \"$PSHOME\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1\" -ErrorAction Stop; $value=[Console]::In.ReadToEnd(); $secure=ConvertTo-SecureString -String $value -AsPlainText -Force; [Console]::Out.Write((ConvertFrom-SecureString $secure))"],{input:token,encoding:'utf8',windowsHide:true,timeout:10000,stdio:['pipe','pipe','pipe']});
 const values=['fixture-one-only','fixture-two-only'];
 for(let i=0;i<2;i++)await writeFile(paths[i],encrypt(values[i]));
 const reader=createCredentialReader(config(paths.map((filePath,i)=>({credentialRef:'key-'+i,filePath}))));
 assert.equal(reader.read('key-0')===values[0],true);assert.equal(reader.read('key-1')===values[1],true);
 await writeFile(paths[0],encrypt('fixture-rotated'));assert.equal(reader.read('key-0')==='fixture-rotated',true);
 assert.equal(reader.read('key-1')===values[1],true);
 await writeFile(paths[0],'fixture-plaintext-must-not-appear');
 assert.throws(()=>reader.read('key-0'),{message:'RC_UNAVAILABLE'});
 await writeFile(paths[0],'01000000d08c9ddf0115d1118c7a00c04fc297eb'+'00'.repeat(40));
 assert.throws(()=>reader.read('key-0'),{message:'RC_UNAVAILABLE'});
 await writeFile(paths[0],encrypt('invalid\r\nheader'));assert.throws(()=>reader.read('key-0'),{message:'RC_UNAVAILABLE'});
 assert.doesNotMatch(JSON.stringify(reader),/fixture|private/);
});
