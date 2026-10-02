import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parse} from 'smol-toml';
const api=await import('../src/desktop-provider-install.mjs').catch(()=>({}));
async function fixture(t,text){const root=await mkdtemp(join(tmpdir(),'provider-install-'));t.after(()=>rm(root,{recursive:true,force:true}));const path=join(root,'config.toml');await writeFile(path,text);return {root,path};}
test('provider install preserves original bytes, backs up and is idempotent',async t=>{
 assert.equal(typeof api.planDesktopProvider,'function');
 const original='# 用户配置\r\nmodel = "gpt-6-sol"\r\n[features]\r\nmulti_agent = true\r\n';
 const f=await fixture(t,original),plan=await api.planDesktopProvider(f.path,59508);
 assert.equal(plan.status,'ready');assert.equal(await readFile(f.path,'utf8'),original);
 const result=await api.applyDesktopProvider(f.path,plan);
 assert.equal(result.status,'installed');const text=await readFile(f.path,'utf8');assert.ok(text.startsWith(original));
 const parsed=parse(text);assert.equal(parsed.model,'gpt-6-sol');assert.equal(parsed.features.multi_agent,true);
 assert.equal(parsed.model_providers.codex_router_desktop.base_url,'http://127.0.0.1:59508/v1');
 assert.equal(await readFile(result.backupPath,'utf8'),original);
 const again=await api.planDesktopProvider(f.path,59508);assert.equal(again.status,'already-installed');
 const files=await readdir(f.root);assert.equal((await api.applyDesktopProvider(f.path,again)).status,'already-installed');
 assert.deepEqual(await readdir(f.root),files);assert.equal(await readFile(f.path,'utf8'),text);
 await assert.rejects(api.planDesktopProvider(f.path,59509),/DPI_CONFLICT/);
});
test('invalid TOML and existing quoted/inline provider conflicts never write',async t=>{
 assert.equal(typeof api.planDesktopProvider,'function');
 for(const original of ['x="unterminated','model_providers={codex_router_desktop={name="other"}}',
  '[model_providers."codex_router_desktop"]\nname="other"']){
  const f=await fixture(t,original);await assert.rejects(api.planDesktopProvider(f.path,59508),/DPI_(CONFIG_INVALID|CONFLICT)/);
  assert.equal(await readFile(f.path,'utf8'),original);assert.deepEqual(await readdir(f.root),['config.toml']);
 }
});
test('stale plans and concurrent install locks reject without overwriting',async t=>{
 assert.equal(typeof api.planDesktopProvider,'function');
 const f=await fixture(t,'model="gpt-6-sol"'),plan=await api.planDesktopProvider(f.path,59508);
 await writeFile(f.path,'model="gpt-6-astra"');
 await assert.rejects(api.applyDesktopProvider(f.path,plan),/DPI_STALE/);
 assert.equal(await readFile(f.path,'utf8'),'model="gpt-6-astra"');
 await writeFile(f.path+'.router-provider.lock','occupied');
 await assert.rejects(api.applyDesktopProvider(f.path,await api.planDesktopProvider(f.path,59508)),/DPI_LOCKED/);
});
test('invalid port, forged receipt and invalid utf8 fail safely',async t=>{
 assert.equal(typeof api.planDesktopProvider,'function');const f=await fixture(t,'');
 await assert.rejects(api.planDesktopProvider(f.path,0),/DPI_INPUT/);
 const plan=await api.planDesktopProvider(f.path,59508);
 await assert.rejects(api.applyDesktopProvider(f.path,{...plan,afterSha256:'0'.repeat(64)}),/DPI_STALE/);
 await writeFile(f.path,Buffer.from([255]));await assert.rejects(api.planDesktopProvider(f.path,59508),/DPI_CONFIG_INVALID/);
});
test('unrelated multiline strings survive and conflicting backups are never overwritten',async t=>{
 const original='notes = """\n[model_providers.codex_router_desktop]\nnot a table\n"""\n';
 const f=await fixture(t,original),plan=await api.planDesktopProvider(f.path,59508);
 const backup=f.path+'.codex-router.'+plan.beforeSha256+'.bak';
 await writeFile(backup,'unrelated backup');
 await assert.rejects(api.applyDesktopProvider(f.path,plan),/DPI_BACKUP_CONFLICT/);
 assert.equal(await readFile(f.path,'utf8'),original);assert.equal(await readFile(backup,'utf8'),'unrelated backup');
});
