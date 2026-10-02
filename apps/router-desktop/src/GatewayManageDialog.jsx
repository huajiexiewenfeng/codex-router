import {useEffect,useRef,useState} from 'react';
export function GatewayManageDialog({gateway,busy,onClose,onRename,onDelete}){
 const dialog=useRef(null),[name,setName]=useState(gateway.name),[confirmed,setConfirmed]=useState(false),[error,setError]=useState('');
 const deleteBlocked=gateway.global?gateway.active:gateway.workers.length>0;
 useEffect(()=>{const el=dialog.current,previous=document.activeElement;el.showModal();return()=>{el.close();previous?.focus();};},[]);
 async function run(fn){setError('');try{await fn();}catch(e){const errors={GMG_BOUND:'此网关仍有关联 Worker，请先解除或迁移绑定。',GMG_SERVICE_ACTIVE:'请先停止 Router 服务，再删除网关。程序不会自动停止服务。',GMG_NAME:'名称不能为空、超过 80 字或与其他网关重复。',DESKTOP_CONFIG_STALE:'配置已变化，请关闭并刷新配置后重试。'};setError(errors[e.message]??'操作失败，请关闭并刷新配置确认结果，勿盲目重试。');}}
 return <dialog ref={dialog} className="gateway-form" aria-labelledby="manage-gateway-title" onCancel={e=>{e.preventDefault();if(!busy)onClose();}}>
  <h2 id="manage-gateway-title">管理网关</h2>
  <div className="gateway-form-scroll">
   <p className="help">网关 ID：{gateway.id}<br/>地址：{gateway.url}</p>
   <label className="field">显示名称<input autoFocus maxLength={80} disabled={busy} value={name} onChange={e=>setName(e.target.value)}/></label>
   <button disabled={busy||!name.trim()||name.trim()===gateway.name} onClick={()=>run(()=>onRename(name))}>保存名称</button>
   <h3>{gateway.active?'当前网关':'已保存网关'}</h3>
   <p className="help">{gateway.global?(gateway.active?'所有 Router Worker 共用此网关的已启用模型，无需逐个绑定。删除前请切换至另一个网关。':'此网关不接收常规 Worker 请求；设为当前网关后对全部 Router Worker 生效。'):'旧配置尚未迁移，请先升级 runtime 并选择当前网关。'}</p>
   <h3>删除网关</h3><p>删除本地网关及其模型配置，先自动备份。加密 Key 和凭据记录暂时保留，不会销毁。需要 Router 服务已停止。</p>
   <label className="field checkbox-field"><input type="checkbox" disabled={busy||deleteBlocked} checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/><span>确认删除「{gateway.name}」及其 {gateway.models.length} 个模型配置</span></label>
   {error&&<p className="error" role="alert">{error}</p>}
  </div>
  <div className="modal-footer"><button disabled={busy} onClick={onClose}>关闭</button><button disabled={busy||!confirmed||deleteBlocked} onClick={()=>run(onDelete)}>删除网关</button></div>
 </dialog>;
}
