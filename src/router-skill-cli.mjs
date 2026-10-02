import {readFile} from 'node:fs/promises';
import {dirname,join,isAbsolute,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {loadRouterConfig,routerStatus} from './router-service.mjs';
import {validateManagedOptions} from './managed-model-router.mjs';
import {validateModelRegistry} from './model-registry.mjs';
import {createDesktopWorkerHost} from './desktop-worker-host.mjs';

const fail=code=>{throw Error(code);};
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
async function readModels(configPath){
 const options=validateManagedOptions(loadRouterConfig(configPath).adapterOptions);
 return validateModelRegistry(JSON.parse(await readFile(options.modelRegistryPath,'utf8')));
}
// Local product entry, not a daemon: no bootstrap, service control or config writes.
export async function runRouterSkill(args,output=value=>console.log(JSON.stringify(value)),deps={}){
 const [command,configPath,value,confirmation]=args;
 if(!['status','prepare','start','job-status'].includes(command)||!isAbsolute(configPath??''))fail('RS_USAGE');
 if(args.length!==(command==='status'?2:command==='start'?4:3))fail('RS_USAGE');
 if(command==='start'&&confirmation!=='--confirm-initialization')fail('RS_USAGE');
 if(['start','job-status'].includes(command)&&!uuid.test(value??''))fail('RS_INPUT');
 if(command==='status'){
  const s=(deps.readStatus??routerStatus)(configPath),r=await (deps.readModels??readModels)(configPath);
  const p=r.providers.find(p=>p.id===r.activeProviderId);
  output({state:s.state,kind:s.kind,registryHealthy:s.registryHealthy===true,stopRequested:s.stopRequested===true,port:s.port,
   activeGateway:p?{id:p.id}:null,enabledModels:r.models.filter(m=>m.providerId===p?.id&&m.enabled!==false).map(m=>m.selectionId),
   observation:'local-state-only',sendsModelRequest:false});return;
 }
 let input;
 if(command==='prepare'){
  try{input=JSON.parse(await readFile(value,'utf8'));}catch{fail('RS_INPUT');}
  if(!input||Array.isArray(input)||Object.keys(input).sort().join(',')!=='cwd,model,title'||
   !isAbsolute(input.cwd??'')||typeof input.title!=='string'||!input.title.trim()||
   typeof input.model!=='string'||!input.model.trim())fail('RS_INPUT');
 }
 const host=await (deps.host??createDesktopWorkerHost)({routerConfigPath:configPath,jobRoot:join(dirname(configPath),'worker-jobs')});
 if(command==='prepare'){output(await host.prepare(input));return;}
 if(command==='job-status'){output(await host.status(value));return;}
 output(await host.start({operationId:value,confirmed:true}));
 // Await only work started in this process. An earlier uncertain intent is not replayed.
 output(await host.wait(value));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{await runRouterSkill(process.argv.slice(2));}
 catch(error){console.error(JSON.stringify({error:/^(RS|DW)_[A-Z_]+$/.test(error.message)?error.message:'RS_FAILED'}));process.exitCode=1;}
}
