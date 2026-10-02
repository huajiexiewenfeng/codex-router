import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initializeDesktopData} from '../src/desktop-bootstrap.mjs';
import {planDesktopProvider,applyDesktopProvider} from '../src/desktop-provider-install.mjs';
const api=await import('../src/desktop-worker-host.mjs').catch(()=>({}));
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'desktop-worker-host-')),home=join(root,'home');await mkdir(home);
 const {host}=await initializeDesktopData(join(root,'data'));
 const config=JSON.parse(await readFile(host.routerConfigPath,'utf8'));config.port=59509;config.adapterOptions.port=59509;
 await writeFile(host.routerConfigPath,JSON.stringify(config));
 const path=join(home,'config.toml');await writeFile(path,'');await applyDesktopProvider(path,await planDesktopProvider(path,59509));
 return {root,home,host,path,jobRoot:join(root,'data','worker-jobs'),codexExecutable:join(root,'codex.exe')};
}
test('desktop host supplies native home and child-only ingress without saving secrets in jobs',async()=>{
 assert.equal(typeof api.createDesktopWorkerHost,'function');
 const f=await fixture(),token='c'.repeat(64);let connections=0,creates=0;
 const jobs=await api.createDesktopWorkerHost({routerConfigPath:f.host.routerConfigPath,jobRoot:f.jobRoot},{
  discover:async()=>({codexHome:f.home,codexExecutable:f.codexExecutable}),
  readStatus:()=>({kind:'shared',state:'running',registryHealthy:true,port:59509}),
  readIngress:()=>token,
  connect:async(exe,options)=>{connections++;assert.equal(exe,f.codexExecutable);assert.equal(options.codexHome,f.home);assert.equal(options.router.ingressToken,token);return {close:async()=>{}};},
  plan:async(r,deps)=>{assert.equal(r.codexHome,f.home);assert.equal(r.provider,'codex_router_desktop');await (await deps.connect(r.codexExecutable,{codexHome:r.codexHome})).close();return {status:'ready_to_create'};},
  create:async()=>{creates++;},
 });
 const p=await jobs.prepare({cwd:f.root,title:'Test',model:'gpt-6-sol_self'});
 assert.equal(creates,0);assert.equal(connections,1);
 assert.equal((await readFile(join(f.jobRoot,p.operationId+'.job.json'),'utf8')).includes(token),false);
 await jobs.start({operationId:p.operationId,confirmed:true});await new Promise(r=>setImmediate(r));assert.equal(creates,1);
 await jobs.start({operationId:p.operationId,confirmed:true});assert.equal(creates,1);
});
test('desktop host refuses missing persistent provider and stopped service before native connection',async()=>{
 assert.equal(typeof api.createDesktopWorkerHost,'function');const f=await fixture();let running=false,calls=0;
 const jobs=await api.createDesktopWorkerHost({routerConfigPath:f.host.routerConfigPath,jobRoot:f.jobRoot},{
  discover:async()=>({codexHome:f.home,codexExecutable:f.codexExecutable}),
  readStatus:()=>({kind:'shared',state:running?'running':'stopped',registryHealthy:true,port:59509}),
  readIngress:()=>{calls++;return 'c'.repeat(64);},plan:async()=>{calls++;return {status:'ready_to_create'};},
 });
 const input={cwd:f.root,title:'Test',model:'gpt-6-sol_self'};
 await assert.rejects(jobs.prepare(input),/DW_NOT_READY/);
 running=true;await writeFile(f.path,'');await assert.rejects(jobs.prepare(input),/DW_NOT_READY/);assert.equal(calls,0);
});
