export function summarize(models) {
  const selected = models.filter(m => m.enabled);
  return {preview:selected.slice(0,3), enabled:selected.length, total:models.length, ready:selected.filter(m=>m.readiness==='verified').length};
}
export function filterModels(models, query='', filter='all') {
  const q=query.trim().toLowerCase();
  return models.filter(m=>(filter==='all'||m.enabled===(filter==='enabled')) && `${m.upstream} ${m.selectionId}`.toLowerCase().includes(q));
}
export function setEnabled(models,id,enabled) {
  if(!models.some(m=>m.id===id)||typeof enabled!=='boolean') throw new Error('未知模型或无效选择');
  return models.map(m=>m.id===id?{...m,enabled}:m);
}
export function gatewayFromDraft(draft,existing) {
  const name=draft.name.trim();
  if(!name||name.length>80) throw new Error('请输入 1–80 字的网关名称');
  let url; try {url=new URL(draft.url);} catch {throw new Error('请输入有效的 HTTPS 地址');}
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash) throw new Error('演示版仅接受不含凭据、查询参数的 HTTPS 地址');
  if(existing.some(g=>g.name===name)) throw new Error('网关名称已存在');
  const names=draft.models.map(m=>m.trim()).filter(Boolean);
  if(names.some(m=>! /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(m))||new Set(names).size!==names.length) throw new Error('模型名称无效或重复');
  return {id:crypto.randomUUID(),name,url:url.href.replace(/\/$/,''),credential:false,models:names.map(upstream=>({id:crypto.randomUUID(),upstream,selectionId:`${upstream}_self`,enabled:false,readiness:'pending'}))};
}
