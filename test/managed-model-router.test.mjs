import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,readFile,cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { execFileSync,execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { modelRegistry,threadId,turnId,binding } from './fixtures/router-model-registry.mjs';
import { initializeBudget,readBudget } from '../src/router-budget.mjs';
import { initializeRouterRegistry,registerRouterBudget } from '../src/router-registry.mjs';
import { routerStatus } from '../src/router-service.mjs';
const execute=promisify(execFile);
const done='event: response.completed\ndata: {"type":"response.completed"}\n\n';
test('shared service default adapter loads registry and DPAPI refs without test resolver injection',{skip:process.platform!=='win32'},async()=>{
 let api;try{api=await import('../src/managed-model-router.mjs');}catch(e){if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;}assert.equal(typeof api?.createManagedRouter,'function');
 const dir=await mkdtemp(join(tmpdir(),'managed-p0-')),calls=[];
 // Run the actual product service module from a relocated package, not the team CLI.
 const installed=join(dir,'relocated-package');
 for(const part of ['src','scripts','node_modules'])await cp(resolve(part),join(installed,part),{recursive:true});
 const serviceUrl=pathToFileURL(join(installed,'src','router-service.mjs')).href;
 const run=async(operation,configPath)=>execute(process.execPath,['--input-type=module','-e',
  `const api=await import(${JSON.stringify(serviceUrl)}); await api[${JSON.stringify(operation)}](${JSON.stringify(configPath)});`],{cwd:dir,windowsHide:true,timeout:15000});
 const upstream=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;calls.push({url:req.url,headers:req.headers,payload:JSON.parse(body)});res.writeHead(200,{'content-type':'text/event-stream'});res.end(done);});
 await new Promise(r=>upstream.listen(0,'127.0.0.1',r));let service;
 try{
  const modelPath=join(dir,'models.json'),credentialsPath=join(dir,'credentials.json'),bindingsPath=join(dir,'bindings.json'),registryPath=join(dir,'threads.jsonl'),budgetPath=join(dir,'budget.jsonl'),configPath=join(dir,'service.json');
  const r=modelRegistry();for(const p of r.providers){p.responsesUrl=`http://127.0.0.1:${upstream.address().port}/${p.id}/responses`;p.allowHttp=true;}await writeFile(modelPath,JSON.stringify(r));await writeFile(bindingsPath,JSON.stringify([binding]));
  const credentials=[];
  for(const [credentialRef,value] of [['ingress-ref','fixture-ingress'],['one-key','fixture-one'],['two-key','fixture-two']]){
   const filePath=join(dir,credentialRef+'.dpapi');
   const cipher=execFileSync(join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-Command',`$ErrorActionPreference='Stop'; Import-Module "$PSHOME\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1"; $v=[Console]::In.ReadToEnd(); [Console]::Out.Write((ConvertFrom-SecureString (ConvertTo-SecureString $v -AsPlainText -Force)))`],{input:value,encoding:'utf8',windowsHide:true,timeout:10000,stdio:['pipe','pipe','pipe']});
   await writeFile(filePath,cipher);credentials.push({credentialRef,filePath});
  }
  await writeFile(credentialsPath,JSON.stringify({schemaVersion:1,credentials}));
  initializeRouterRegistry(registryPath);initializeBudget(budgetPath,{threadId,usedRequests:0});registerRouterBudget(registryPath,budgetPath);
  const adapterPath=join(installed,'src','managed-model-router.mjs');
  const options=api.validateManagedOptions({schemaVersion:1,modelRegistryPath:modelPath,credentialConfigPath:credentialsPath,bindingsPath,ingressCredentialRef:'ingress-ref',officialModels:['gpt-6-sol'],port:0,officialProxyUrl:null});
  await writeFile(configPath,JSON.stringify({registryPath,port:0,adapterPath,adapterSha256:createHash('sha256').update(await readFile(adapterPath)).digest('hex'),adapterOptions:options}));
  await run('startRouter',configPath);
  service={status:()=>routerStatus(configPath),close:async()=>{
   await run('stopRouter',configPath);
   const deadline=Date.now()+10000;
   while(routerStatus(configPath).state!=='stopped'&&Date.now()<deadline)await new Promise(r=>setTimeout(r,100));
   assert.equal(routerStatus(configPath).state,'stopped');
  }};
  assert.equal(service.status().bindings[0].ready,true);
  const send=async(model,headers={})=>{const res=await fetch(`http://127.0.0.1:${service.status().port}/v1/responses`,{method:'POST',headers:{'x-worker-router-token':'fixture-ingress',authorization:'Bearer official-fixture','chatgpt-account-id':'fixture-account','x-codex-turn-metadata':JSON.stringify({thread_id:threadId,turn_id:turnId,model}),...headers},body:JSON.stringify({model,stream:true,reasoning:{effort:'max'},input:[{role:'user',content:'hello'},{type:'function_call_output',call_id:'preserve-call',output:'result'}],tools:[{type:'function',name:'read_file'}]})});return {status:res.status,text:await res.text()};};
  for(const model of ['one_self','two_self'])assert.equal((await send(model)).text,done);
  assert.equal(calls.length,2);assert.equal(calls[0].url,'/one/responses');assert.equal(calls[1].url,'/two/responses');
  assert.equal(calls[0].headers.authorization==='Bearer fixture-one',true);assert.equal(calls[1].headers.authorization==='Bearer fixture-two',true);
  assert.equal(calls[0].headers['chatgpt-account-id'],undefined);assert.equal(calls[0].payload.model,'gpt-6-sol');assert.equal(calls[0].payload.input[1].call_id,'preserve-call');assert.equal(calls[0].payload.reasoning.effort,'max');
  assert.equal((await send('one_self',{'x-worker-router-token':'bad'})).status,403);
  const global=JSON.parse(await readFile(modelPath,'utf8'));global.activeProviderId='one';global.generation++;
  const alias={...structuredClone(global.models[1]),modelId:'global-two-alias',selectionId:'one_self',displayName:'one_self',readiness:'pending'};delete alias.catalogEntry;delete alias.verificationRef;global.models.push(alias);
  await writeFile(modelPath,JSON.stringify(global));await writeFile(bindingsPath,JSON.stringify([{hostId:'local',threadId,allowedModels:[]}]));
  assert.equal((await send('one_self')).text,done);assert.equal(calls.at(-1).url,'/one/responses');
  global.activeProviderId='two';global.generation++;await writeFile(modelPath,JSON.stringify(global));
  assert.equal((await send('one_self')).text,done);assert.equal(calls.at(-1).url,'/two/responses');assert.equal(calls.at(-1).headers.authorization,'Bearer fixture-two');
  global.models.at(-1).enabled=false;global.generation++;await writeFile(modelPath,JSON.stringify(global));assert.equal((await send('one_self')).status,403);
  await writeFile(modelPath,'broken');assert.equal((await send('one_self')).status,403);assert.equal(calls.length,4);assert.equal(readBudget(budgetPath).usedRequests,4);
 }finally{await service?.close();upstream.closeAllConnections();await new Promise(r=>upstream.close(r));}
});
