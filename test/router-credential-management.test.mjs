import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,writeFile,access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createCredentialReader } from '../src/router-credentials.mjs';
let api;try{api=await import('../src/router-credential-management.mjs');}catch(e){if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;}
test('credential lifecycle encrypts at rest, protects ACL, checks fingerprints and deletes only selected ref',{skip:process.platform!=='win32'},async()=>{
 assert.equal(typeof api?.manageCredential,'function');
 const dir=await mkdtemp(join(tmpdir(),'credential-management-')),filePath=join(dir,'one.dpapi'),other=join(dir,'two.dpapi');
 const config={schemaVersion:1,credentials:[{credentialRef:'one-key',filePath},{credentialRef:'two-key',filePath:other}]};
 const create=(ref,secret)=>api.manageCredential(config,{operation:'create',credentialRef:ref,secret});
 const one=create('one-key','fixture-one'),two=create('two-key','fixture-two');
 const powershell=join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
 const acl=JSON.parse(execFileSync(powershell,['-NoProfile','-NonInteractive','-Command',`Import-Module "$PSHOME\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1"; Import-Module "$PSHOME\\Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1"; $a=Get-Acl -LiteralPath ([Console]::In.ReadToEnd()); @{protected=$a.AreAccessRulesProtected; owner=$a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value; current=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; rules=@($a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]) | ForEach-Object { @{sid=$_.IdentityReference.Value; inherited=$_.IsInherited; type=$_.AccessControlType.ToString()} })} | ConvertTo-Json -Depth 5`],{input:filePath,encoding:'utf8',windowsHide:true,stdio:['pipe','pipe','pipe']}));
 assert.equal(acl.protected,true);assert.equal(acl.owner,acl.current);assert.equal(acl.rules.length,2);
 assert.deepEqual(acl.rules.map(r=>r.sid).sort(),[acl.current,'S-1-5-18'].sort());assert.equal(acl.rules.every(r=>!r.inherited&&r.type==='Allow'),true);
 assert.equal(one.status,'created');assert.equal(one.permissions,'current-user-and-system');assert.match(one.sha256,/^[a-f0-9]{64}$/);
 assert.doesNotMatch(await readFile(filePath,'utf8'),/fixture/);
 const reader=createCredentialReader(config);assert.equal(reader.read('one-key')==='fixture-one',true);
 assert.throws(()=>create('one-key','fixture-replacement'),{message:'RC_EXISTS'});
 assert.throws(()=>api.manageCredential(config,{operation:'replace',credentialRef:'one-key',secret:'fixture-next',expectedSha256:'0'.repeat(64)}),{message:'RC_CONFLICT'});
 const replaced=api.manageCredential(config,{operation:'replace',credentialRef:'one-key',secret:'fixture-next',expectedSha256:one.sha256});
 assert.equal(replaced.status,'replaced');assert.equal(reader.read('one-key')==='fixture-next',true);assert.equal(reader.read('two-key')==='fixture-two',true);
 await writeFile(filePath+'.credential.lock','existing');
 assert.throws(()=>api.manageCredential(config,{operation:'delete',credentialRef:'one-key',expectedSha256:replaced.sha256}),{message:'RC_LOCKED'});
 // Recover only the artificial test lock, not a production stale lock.
 const {unlink}=await import('node:fs/promises');await unlink(filePath+'.credential.lock');
 const deleted=api.manageCredential(config,{operation:'delete',credentialRef:'one-key',expectedSha256:replaced.sha256});assert.equal(deleted.status,'deleted');
 await assert.rejects(()=>access(filePath));assert.equal(reader.read('two-key')==='fixture-two',true);
 // A user-broadened ACL is rejected, not silently accepted or repaired.
 execFileSync(powershell,['-NoProfile','-NonInteractive','-Command',`$ErrorActionPreference='Stop'; $p=[Console]::In.ReadToEnd(); $a=[IO.File]::GetAccessControl($p,[Security.AccessControl.AccessControlSections]::Access); $sid=New-Object Security.Principal.SecurityIdentifier('S-1-1-0'); $r=New-Object Security.AccessControl.FileSystemAccessRule($sid,'Read','Allow'); $a.AddAccessRule($r); [IO.File]::SetAccessControl($p,$a)`],{input:other,encoding:'utf8',windowsHide:true,stdio:['pipe','pipe','pipe']});
 for(const operation of ['replace','delete'])assert.throws(()=>api.manageCredential(config,{operation,credentialRef:'two-key',expectedSha256:two.sha256,...(operation==='replace'?{secret:'fixture-refused'}:{})}),{message:'RC_PERMISSIONS'});
 assert.equal(reader.read('two-key')==='fixture-two',true);
 assert.doesNotMatch(JSON.stringify([one,two,replaced,deleted]),/fixture|dpapi|[A-Z]:/);
});
test('credential management rejects plaintext in wrong fields and unknown references before work',()=>{
 assert.equal(typeof api?.manageCredential,'function');
 const config={schemaVersion:1,credentials:[{credentialRef:'one-key',filePath:'C:\\not-created\\key.dpapi'}]};
 for(const request of [{operation:'create',credentialRef:'one-key',secret:'bad\nheader'},{operation:'delete',credentialRef:'one-key'},{operation:'create',credentialRef:'one-key',secret:'fixture',extra:'value'}])assert.throws(()=>api.manageCredential(config,request),{message:'RC_REQUEST'});
 assert.throws(()=>api.manageCredential(config,{operation:'create',credentialRef:'unknown',secret:'fixture'}),{message:'RC_REFERENCE'});
});
