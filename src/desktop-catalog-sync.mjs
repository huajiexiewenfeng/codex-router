import {readFile,lstat,realpath} from 'node:fs/promises';
import {join,isAbsolute,basename,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {parse} from 'smol-toml';
import {validateModelRegistry,usesActiveGateway,safeModelId} from './model-registry.mjs';
import {buildModelCatalog} from './model-catalog.mjs';
import {atomicWrite} from './store.mjs';
import {withFileLocks} from './registry-projection.mjs';
import {validateOfficialModels} from './desktop-official-catalog.mjs';
const fail=code=>{throw Error(code);},hash=b=>createHash('sha256').update(b).digest('hex');
const alias=id=>typeof id==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}_self$/.test(id);
async function regular(path){const s=await lstat(path);if(!s.isFile()||s.isSymbolicLink()||s.nlink>1||s.size>16*1024*1024)fail('DCM_TARGET');return readFile(path);}
// Read only the native cache beside the trusted host config. No authentication,
// network refresh or inference; a cache snapshot is not a cloud availability check.
async function officialCache(configPath){
 const path=join(dirname(configPath),'models_cache.json');
 const skipped=status=>({models:[],summary:{status,addedCount:0,cloudVerified:false}});
 try{
  const bytes=await regular(path),cache=JSON.parse(bytes),slugs=new Set();
  if(typeof cache.fetched_at!=='string'||!Array.isArray(cache.models)||!cache.models.length)return skipped('invalid');
  const fetched=Date.parse(cache.fetched_at),age=Date.now()-fetched;
  if(!Number.isFinite(fetched)||age< -300_000)return skipped('invalid');
  if(age>24*60*60*1000)return skipped('stale');
  for(const model of cache.models){
   if(!model||!safeModelId(model.slug)||model.slug.endsWith('_self')||slugs.has(model.slug))return skipped('invalid');
   slugs.add(model.slug);
  }
  return {path,bytes,models:cache.models,summary:{status:'cache-merged',fetchedAt:new Date(fetched).toISOString(),addedCount:0,cloudVerified:false}};
 }catch(e){return skipped(e.code==='ENOENT'?'missing':'invalid');}
}
// Host-only read path for explicit maintenance previews; never opens a custom
// catalog or writes configuration, ownership, backup or lock files.
export async function readDesktopOfficialCatalog({configPath,loadBundledModels,bundledModels}){
 if(typeof configPath!=='string'||!isAbsolute(configPath))fail('DCM_TARGET');
 const source=await officialCache(configPath);
 let bundled=[],bundledStatus='not-configured';
 if(loadBundledModels!==undefined||bundledModels!==undefined){
  try{
   const supplied=loadBundledModels!==undefined?await loadBundledModels():bundledModels;
   try{bundled=validateOfficialModels(supplied);bundledStatus='loaded';}catch{bundledStatus='invalid';}
  }catch{bundledStatus='unavailable';}
 }
 // A valid recent cache wins same-slug metadata; bundled entries fill its gaps.
 const official=new Map(source.models.map(model=>[model.slug,model]));
 for(const model of bundled)if(!official.has(model.slug))official.set(model.slug,model);
 const models=[...official.values()];
 return {...source,models,summary:{...source.summary,status:bundledStatus==='loaded'?(source.models.length?'cache-bundled-merged':'bundled-merged'):source.summary.status,cacheStatus:source.summary.status,bundledStatus,discoveredModelIds:models.filter(m=>m.visibility==='list').map(m=>m.slug)}};
}
// Trusted host paths only. Never write Codex config, built-in catalog or cache.
export async function syncDesktopCatalog({configPath,registryPath,stateRoot,loadBundledModels,bundledModels}){
 try{
  if([configPath,registryPath,stateRoot].some(p=>typeof p!=='string'||!isAbsolute(p)))fail('DCM_TARGET');
  const configBytes=await regular(configPath),config=parse(configBytes.toString('utf8')),target=config.model_catalog_json;
  if(typeof target!=='string')fail('DCM_NOT_CONFIGURED');
  if(!isAbsolute(target)||basename(target).toLowerCase()==='models_cache.json')fail('DCM_TARGET');
  await regular(target);const catalogPath=await realpath(target),modelsPath=await realpath(registryPath),root=await realpath(stateRoot);
  if(catalogPath===modelsPath||catalogPath===await realpath(configPath))fail('DCM_TARGET');
  const ownerPath=join(root,'codex-catalog-'+hash(catalogPath)+'.json');
  return await withFileLocks([modelsPath+'.model-update.lock',catalogPath+'.router-catalog.lock',ownerPath+'.lock'],async()=>{
   const before=await regular(catalogPath),registryBytes=await regular(modelsPath),registry=validateModelRegistry(JSON.parse(registryBytes));
   if(!usesActiveGateway(registry)||registry.suffix!=='_self')fail('DCM_REGISTRY');
   const current=JSON.parse(before);let previous=[];
   try{
    const owner=JSON.parse(await regular(ownerPath));
    if(owner.schemaVersion!==1||owner.catalogPath!==catalogPath||!Array.isArray(owner.managedSlugs)||!owner.managedSlugs.every(alias))fail('DCM_OWNERSHIP');
    previous=owner.managedSlugs;
   }catch(e){if(e.code!=='ENOENT')throw e;}
   const owned=[...new Set([...previous,...registry.models.map(m=>m.selectionId)])];if(!owned.every(alias))fail('DCM_REGISTRY');
   // Validate duplicates and preserve all unknown/official fields before filtering.
   buildModelCatalog({...registry,models:[]},current);
   const source=await readDesktopOfficialCatalog({configPath,loadBundledModels,bundledModels}),existing=new Set(current.models.map(m=>m.slug));
   // Additions only: never reinterpret or migrate an existing entry's metadata.
   const additions=source.models.filter(m=>!existing.has(m.slug));
   const next=buildModelCatalog(registry,{...current,models:[...current.models.filter(m=>!owned.includes(m.slug)),...additions]});
   const officialCatalog={...source.summary,addedCount:additions.length};
   async function unchanged(){
    if(!configBytes.equals(await regular(configPath))||await realpath(target)!==catalogPath||!before.equals(await regular(catalogPath))||!registryBytes.equals(await regular(modelsPath)))fail('DCM_STALE');
    if(source.bytes){try{if(!source.bytes.equals(await regular(source.path)))fail('DCM_STALE');}catch{fail('DCM_STALE');}}
   }
   await unchanged();
   const changed=!isDeepStrictEqual(next,current);
   if(changed){
    const backup=join(root,'codex-catalog-'+hash(catalogPath)+'-'+hash(before)+'.bak');
    try{await atomicWrite(backup,before.toString('utf8'),true);}catch(e){if(e.code!=='EEXIST'||!before.equals(await regular(backup)))fail('DCM_BACKUP');}
   }
   // Persist ownership first. These aliases already belong to the accepted
   // registry or prior ownership, even if interruption precedes catalog writing.
   await atomicWrite(ownerPath,JSON.stringify({schemaVersion:1,catalogPath,managedSlugs:owned},null,2)+'\n');
   await unchanged();
   if(changed)await atomicWrite(catalogPath,JSON.stringify(next,null,2)+'\n');
   return {status:changed?'updated':'unchanged',startupReloadRequired:true,nativeVerified:false,modelCount:next.models.length,backupSaved:changed,sendsRequest:false,officialCatalog};
  });
 }catch(e){throw Error(/^DCM_[A-Z_]+$/.test(e.message)?e.message:e.code==='EEXIST'?'DCM_LOCKED':'DCM_UNAVAILABLE');}
}
