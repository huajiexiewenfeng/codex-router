import { fail, safeModelId, validateModelRegistry, usesActiveGateway, currentGatewayModels, declaredCatalogEntry } from './model-registry.mjs';

function object(value){return value!==null&&typeof value==='object'&&!Array.isArray(value);}

export function buildModelCatalog(registry,baseCatalog){
 const validated=validateModelRegistry(registry);
 if(!object(baseCatalog)||!Array.isArray(baseCatalog.models))fail('MR_BASE_CATALOG');
 const base=structuredClone(baseCatalog),slugs=new Set();
 for(const model of base.models){
  if(!object(model)||!safeModelId(model.slug)||slugs.has(model.slug))fail('MR_BASE_MODEL');
  slugs.add(model.slug);
 }
 const models=currentGatewayModels(validated);
 for(const model of models){if(slugs.has(model.selectionId))fail('MR_CATALOG_COLLISION');}
 const entries=models.filter(model=>model.enabled!==false&&(usesActiveGateway(validated)||model.readiness==='verified')).map(model=>structuredClone(declaredCatalogEntry(model)));
 return {...base,models:[...base.models,...entries]};
}
