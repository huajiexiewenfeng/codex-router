import {createDesktopConfigBridge} from './desktop-config-bridge.mjs';
import {initializeDesktopData} from './desktop-bootstrap.mjs';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';
import {createDesktopWorkerHost} from './desktop-worker-host.mjs';

// Private child-process protocol. Paths are supplied by the host, never requests.
let bridge;
try {
 const host=process.argv[2]==='--data-root'?(await initializeDesktopData(process.argv[3])).host:{routerConfigPath:process.argv[2],draftRoot:process.argv[3]};
 let workerJobs=null;
 if(process.argv[2]==='--data-root'){
  try{workerJobs=await createDesktopWorkerHost({routerConfigPath:host.routerConfigPath,jobRoot:join(dirname(host.routerConfigPath),'worker-jobs')});}
  catch{/* Unsupported or ambiguous native installation leaves creation disabled. */}
 }
 bridge=await createDesktopConfigBridge({...host,workerJobs,allowServiceControl:process.argv[2]==='--data-root',bundledRuntimeRoot:process.argv[2]==='--data-root'?fileURLToPath(new URL('../',import.meta.url)):null});
} catch { process.exitCode=1; }
if(bridge){
 let pending=Buffer.alloc(0);
 const reply=value=>process.stdout.write(JSON.stringify(value)+'\n');
 for await(const chunk of process.stdin){
  pending=Buffer.concat([pending,chunk]);
  let end;
  while((end=pending.indexOf(10))!==-1){
   if(end>65536){process.exitCode=1;break;}
   const line=pending.subarray(0,end).toString('utf8');pending=pending.subarray(end+1);
   let request;
   try{request=JSON.parse(line);}catch{reply({ok:false,code:'DESKTOP_CONFIG_REQUEST'});continue;}
   reply(await bridge.dispatch(request));
  }
  if(process.exitCode||pending.length>65536){process.exitCode=1;break;}
 }
}
