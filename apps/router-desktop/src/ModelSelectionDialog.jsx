import {useEffect,useRef,useState} from 'react';
import {MagnifyingGlass,X,Info} from '@phosphor-icons/react';
import {filterModels,summarize} from './model-state.mjs';

export function ModelSelectionDialog({gateway,changes,draft,busy,error,notice,onClose,onChange,onSave,onApply,onRefresh,onVerify,onSync}){
 const dialog=useRef(null);
 const [query,setQuery]=useState(''),[filter,setFilter]=useState('all');
 const [verification,setVerification]=useState(null);
 const locked=busy||!!draft||Object.keys(changes).length>0;
 useEffect(()=>{const element=dialog.current;const previous=document.activeElement;element.showModal();return()=>{element.close();previous?.focus();};},[]);
 const models=gateway.models.map(m=>({...m,enabled:changes[m.id]??m.enabled}));
 const visible=filterModels(models,query,filter),stats=summarize(models);
 return <dialog ref={dialog} className="wide model-selection" aria-labelledby="model-selection-title" aria-busy={busy} onCancel={e=>{e.preventDefault();if(!busy)onClose();}}>
  <div className="modal-heading"><h2 id="model-selection-title">管理网关模型</h2><button className="icon" disabled={busy} aria-label="关闭模型详情" onClick={onClose}><X size={20} aria-hidden="true"/></button></div>
  <p className="subtitle">{gateway.name} <span>· {gateway.url}</span></p>
  <div className="model-overview"><span>已配置 <b>{stats.total}</b> 个</span><span>已选择 <b>{stats.enabled}</b> 个</span><span>所选已验证 <b>{stats.ready}</b> 个</span></div>
  <div className="search"><MagnifyingGlass size={20} aria-hidden="true"/><input autoFocus aria-label="搜索模型" placeholder="搜索模型名称…" value={query} onChange={e=>setQuery(e.target.value)}/></div>
  <div className="filters" aria-label="模型筛选">{[['all','全部'],['enabled','已启用'],['disabled','未启用']].map(([value,label])=><button key={value} aria-pressed={filter===value} className={filter===value?'selected':''} onClick={()=>setFilter(value)}>{label}</button>)}</div>
  <div className="table-scroll"><table><thead><tr><th>启用</th><th>网关模型名称</th><th>菜单名称</th><th>文本验证记录</th>{onVerify&&<th>操作</th>}</tr></thead><tbody>{visible.map(m=><tr key={m.id}><td><input type="checkbox" disabled={busy} aria-label={`启用 ${m.selectionId}`} checked={m.enabled} onChange={e=>onChange({id:m.id,enabled:e.target.checked})}/></td><td>{m.upstream}</td><td className="muted">{m.selectionId}</td><td><span className={`badge ${m.readiness==='verified'?'green':''}`}>{m.readiness==='verified'?'已记录验证':'未验证'}</span></td>{onVerify&&<td><button disabled={locked} onClick={()=>setVerification(m)}>验证模型（可选）</button></td>}</tr>)}</tbody></table>{!visible.length&&<p className="empty">没有匹配的模型</p>}</div>
  {verification&&<section className="impact" aria-label="确认模型验证"><p>验证 {verification.selectionId} 将向此网关发送 1 次真实文本请求，可能消耗额度。成功后保存文本验证记录；不会自动启用或切换当前网关，也不代表工具、上下文上限或 Worker 已通过验证。</p><button disabled={locked} className="primary" onClick={()=>{const id=verification.id;setVerification(null);onVerify(id);}}>确认验证（发送 1 次请求）</button><button disabled={busy} onClick={()=>setVerification(null)}>取消验证</button></section>}
  <p className="help"><Info size={17} aria-hidden="true"/>{gateway.global?'所有 Router Worker 共用当前网关的已启用模型，无需逐个绑定。验证仅用于诊断，不是使用前置条件。':'旧配置尚未迁移；请先升级 runtime 并选择当前网关，再使用全局共享模式。'}{gateway.global&&!gateway.active?' 此网关尚未激活，启用模型不会切换当前网关。':''}</p>
  {error&&<div role="alert" className="error">操作未完成：{error}。选择已保留；结果不明确时先刷新配置。<button disabled={busy} onClick={onRefresh}>刷新并重新选择</button></div>}
  {notice&&<p role="status" className="notice">{notice}</p>}
  {draft&&<section className="impact" aria-label="应用影响"><h3>{draft.plan.status==='compatible'?'影响检查通过，可应用':'受现有绑定保护，不能应用'}</h3>{draft.plan.issues.map((issue,i)=><div key={i}><p>{issue.code} · {issue.selectionId||issue.modelId}</p>{issue.workers?.map(w=><p key={w.hostId+w.threadId}>Worker {w.threadId}（绑定允许使用，不代表正在调用）</p>)}</div>)}</section>}
  <p className="help">应用后同步当前网关的模型到 Codex 自定义目录，保留官方条目；重启 Codex 后加载。不发送模型请求。</p>
  <div className="modal-footer" style={{flexWrap:'wrap'}}><span>{busy?'正在处理，请稍候…':`未应用的选择变更：${Object.keys(changes).length} 项`}</span><button disabled={busy} onClick={onClose}>取消／关闭</button>{onSync&&<button disabled={locked} onClick={onSync}>更新 Codex 菜单</button>}<button disabled={busy||!Object.keys(changes).length||!!draft} className={draft?'':'primary'} onClick={onSave}>保存草稿</button>{draft&&<button className="primary" disabled={busy||draft.plan.status!=='compatible'} onClick={onApply}>应用并更新 Codex 菜单</button>}</div>
 </dialog>;
}
