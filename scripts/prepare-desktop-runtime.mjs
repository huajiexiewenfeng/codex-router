import {readFile,writeFile,mkdir,readdir,lstat} from 'node:fs/promises';
import {join,dirname,isAbsolute,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const source=fileURLToPath(new URL('../',import.meta.url));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=code=>{throw Error(code);};
async function regular(path){const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink())fail('DR_SOURCE_TYPE');return readFile(path);}

// Build-time developer staging only. No runtime configuration or credentials.
export async function prepareDesktopRuntime({destination,nodePath,nodeSha256}){
 if(process.platform!=='win32'||!isAbsolute(destination)||!isAbsolute(nodePath)||!/^[a-f0-9]{64}$/.test(nodeSha256))fail('DR_INPUT');
 const node=await regular(nodePath);if(hash(node)!==nodeSha256)fail('DR_NODE_HASH');
 const noticeRoot=join(source,'docs/third-party/node-v22.23.3');
 const provenanceBytes=await regular(join(noticeRoot,'provenance.json')),provenance=JSON.parse(provenanceBytes);
 const nodeLicense=await regular(join(noticeRoot,'LICENSE')),checksums=await regular(join(noticeRoot,'SHASUMS256.txt'));
 if(nodeSha256!==provenance.binarySha256)fail('DR_NODE_UNREGISTERED');
 if(hash(nodeLicense)!==provenance.licenseSha256||hash(checksums)!==provenance.checksumsSha256||!checksums.toString('utf8').split(/\r?\n/).includes(`${nodeSha256}  win-x64/node.exe`))fail('DR_NODE_NOTICES');
 const lock=JSON.parse(await regular(join(source,'package-lock.json')));
 const pkg=JSON.parse(await regular(join(source,'node_modules/undici/package.json')));
 if(pkg.version!==lock.packages['node_modules/undici'].version||Object.keys(pkg.dependencies??{}).length)fail('DR_DEPENDENCY');
 const tomlPkg=JSON.parse(await regular(join(source,'node_modules/smol-toml/package.json')));
 if(tomlPkg.version!==lock.packages['node_modules/smol-toml'].version||Object.keys(tomlPkg.dependencies??{}).length)fail('DR_DEPENDENCY');
 // Collect before creating destination, so it can never be collected recursively.
 const files=new Map([['node.exe',node],['notices/node-LICENSE',nodeLicense],['notices/node-provenance.json',provenanceBytes],['notices/node-SHASUMS256.txt',checksums]]);
 async function collect(root,prefix,accept){
  const info=await lstat(root);if(!info.isDirectory()||info.isSymbolicLink())fail('DR_SOURCE_TYPE');
  for(const entry of (await readdir(root,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
   if(entry.isSymbolicLink())fail('DR_SOURCE_TYPE');
   if(entry.isDirectory())await collect(join(root,entry.name),prefix+'/'+entry.name,accept);
   else if(accept(entry.name))files.set(prefix+'/'+entry.name,await regular(join(root,entry.name)));
  }
 }
 await collect(join(source,'src'),'src',name=>name.endsWith('.mjs'));
 // Explicit product assets only: never package unrelated skills or user config.
 for(const name of ['skills/codex-router/SKILL.md','docs/router-skill-setup.md'])files.set(name,await regular(join(source,name)));
 await collect(join(source,'node_modules/undici/lib'),'node_modules/undici/lib',name=>/\.(js|json|wasm)$/.test(name));
 for(const name of ['index.js','index-fetch.js','package.json','LICENSE'])files.set('node_modules/undici/'+name,await regular(join(source,'node_modules/undici',name)));
 await collect(join(source,'node_modules/smol-toml/dist'),'node_modules/smol-toml/dist',name=>/\.(js|cjs|json)$/.test(name));
 for(const name of ['package.json','LICENSE'])files.set('node_modules/smol-toml/'+name,await regular(join(source,'node_modules/smol-toml',name)));
 for(const name of ['manage-router-credential.ps1','read-router-credential.ps1'])files.set('scripts/'+name,await regular(join(source,'scripts',name)));
 files.set('package.json',Buffer.from(JSON.stringify({name:'codex-router-desktop-runtime',private:true,type:'module'})));
 try{await mkdir(destination);}catch(e){if(e.code==='EEXIST')fail('DR_DESTINATION_EXISTS');throw e;}
 const manifest={schemaVersion:1,distributable:false,limitations:['development-staging-only','release-signature-and-security-review-pending','application-dependency-notices-pending'],nodeSha256,nodeProvenance:provenance,undiciVersion:pkg.version,files:{}};
 for(const [name,bytes] of files){
  const target=join(destination,name);await mkdir(dirname(target),{recursive:true});await writeFile(target,bytes,{flag:'wx'});
  const actual=hash(await regular(target));if(actual!==hash(bytes))fail('DR_COPY_HASH');manifest.files[name]=actual;
 }
 await writeFile(join(destination,'runtime-manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
 return manifest;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  if(process.argv.length!==5)fail('DR_USAGE');
  const result=await prepareDesktopRuntime({destination:process.argv[2],nodePath:process.argv[3],nodeSha256:process.argv[4]});
  console.log(JSON.stringify({ok:true,files:Object.keys(result.files).length,distributable:false}));
 }catch(e){console.error(/^DR_[A-Z_]+$/.test(e.message)?e.message:'DR_BUILD_FAILED');process.exitCode=1;}
}
