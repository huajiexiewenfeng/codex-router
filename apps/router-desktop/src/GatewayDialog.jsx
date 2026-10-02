import {useEffect,useRef,useState} from 'react';
import {X} from '@phosphor-icons/react';
import {saveGateway,initialGatewayForm,mergeGatewayModels,parseGatewayReceipt,persistGatewayReceipt,retainGatewayReceipt,receiptStorageKey as storageKey} from './gateway-form.mjs';
const syncErrors={DG_URL:'请填写有效的 Base URL（例如 https://gateway.example/v1）。',DG_HTTP_CONFIRMATION:'使用 HTTP 同步前，请勾选明文传输风险确认。',GM_AUTH:'网关拒绝认证，请填写有效 API Key 后重试。',GM_UNSUPPORTED:'网关没有提供 models 接口，请手动填写模型。',GM_REDIRECT:'网关要求重定向；为防止 Key 转发到其他地址，已停止。请核对 Base URL。',GM_TIMEOUT:'同步超时，请稍后重试或手动填写。',GM_NETWORK:'无法连接网关，请检查地址和网络。',GM_EMPTY:'网关返回空列表，请手动填写。',GM_FORMAT:'模型列表格式不兼容，请手动填写。',GM_TOO_LARGE:'模型列表响应过大，请手动填写。',GM_PAGINATION:'网关返回分页列表，本版尚不支持该分页方式，请手动填写。',GM_HTTP:'网关返回错误，请核对地址或稍后重试。',GM_INPUT:'请检查地址和 API Key 输入。'};
const labels={prepared:'配置已准备，尚未保存 Key', 'credential-ready':'Key 已加密保存，配置尚未应用','credentials-registered':'凭据已登记，模型配置待恢复',applied:'已写入本地配置，模型禁用待验证','credential-uncertain':'密文状态不确定，请保留回执并检查，勿重新提交 Key'};
export function GatewayDialog({request,onClose,onApplied}){
 const dialog=useRef(null),keyInput=useRef(null),gate=useRef(false);
 const [form,setForm]=useState(initialGatewayForm),[syncNotice,setSyncNotice]=useState('');
 const [receipt,setReceipt]=useState(null),[status,setStatus]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[recoveryBlocked,setRecoveryBlocked]=useState(false);
 function persist(r){persistGatewayReceipt(localStorage,r);}
 async function act(fn){if(gate.current)return;gate.current=true;setBusy(true);setError('');try{await fn();}catch(e){setStatus('');setError(e.message||'宿主连接失败，请重新打开应用后检查恢复状态。');}finally{gate.current=false;setBusy(false);}}
 useEffect(()=>{const el=dialog.current,previous=document.activeElement;el.showModal();
  act(async()=>{try{const saved=localStorage.getItem(storageKey);if(saved){const r=parseGatewayReceipt(saved);setReceipt(r);setStatus((await request({operation:'gateway-inspect',receipt:r})).status);}}catch(e){setRecoveryBlocked(true);throw e;}});
  return()=>{if(keyInput.current)keyInput.current.value='';el.close();previous?.focus();};
 },[]);
 const edit=(key,value)=>{setForm(f=>({...f,[key]:value}));setError('');if(key==='baseUrl')setSyncNotice('');};
 async function syncModels(){
  if(gate.current)return;
  const secret=keyInput.current?.value??'';
  await act(async()=>{setSyncNotice('');try{const result=await request({operation:'gateway-models',input:{baseUrl:form.baseUrl,allowHttp:form.allowHttp,secret}});setForm(f=>({...f,models:mergeGatewayModels(f.models,result.models)}));setSyncNotice(`已同步 ${result.models.length} 个模型，已与手动输入合并去重；尚未保存或验证。`);}catch(e){setSyncNotice(syncErrors[e.message]??'同步失败，可保留当前列表并手动填写。');}});
 }
 const close=()=>{if(!gate.current){if(keyInput.current)keyInput.current.value='';onClose();}};
 async function save(){await act(async()=>{
  await saveGateway({request,storage:localStorage,form,secret:keyInput.current?.value??'',receipt,onReceipt:setReceipt,onStatus:setStatus});
  if(keyInput.current)keyInput.current.value='';
  await onApplied();localStorage.removeItem(storageKey);onClose();
 });}
 return <dialog ref={dialog} className="gateway-form" aria-labelledby="gateway-title" aria-busy={busy} onCancel={e=>{e.preventDefault();close();}}>
 <div className="modal-heading"><h2 id="gateway-title">添加网关</h2><button className="icon" disabled={busy} aria-label="关闭新增网关" onClick={close}><X size={20} aria-hidden="true"/></button></div>
 <p className="subtitle">模型调用仅支持 Responses 协议。同步只读取模型列表；保存不会调用模型、启用模型或切换 Worker。</p>
 <div className="gateway-form-scroll">
 <fieldset disabled={busy||!!receipt} hidden={!!receipt}>
  <label className="field">网关名称<input autoFocus maxLength={80} value={form.displayName} onChange={e=>edit('displayName',e.target.value)}/></label>
  <label className="field">Base URL<input placeholder="https://gateway.example/v1" value={form.baseUrl} onChange={e=>edit('baseUrl',e.target.value)}/></label>
  <label className="field checkbox-field"><input type="checkbox" checked={form.allowHttp} onChange={e=>edit('allowHttp',e.target.checked)}/><span>我明确接受 HTTP 明文传输 Key 的风险</span></label>
 </fieldset>
 <label className="field">API Key<input ref={keyInput} type="password" autoComplete="off" spellCheck={false} disabled={busy||!!receipt&&status!=='prepared'} maxLength={8192}/><span className="muted">只需填写一次，供同步与保存使用；保存时由 Windows 加密。关闭窗口或保存成功后清空，不写入浏览器存储。</span></label>
 {!receipt&&<fieldset disabled={busy}>
  <div className="model-sync-actions"><button type="button" disabled={busy||!form.baseUrl.trim()} onClick={syncModels}>同步模型</button><span className="muted">读取 Base URL 对应的 models 列表，可继续手动编辑</span></div>
  {syncNotice&&<p className="notice" role="status">{syncNotice}</p>}
  <label className="field">网关模型名称（每行一个）<textarea rows={3} value={form.models} onChange={e=>edit('models',e.target.value)}/></label>
  <p>菜单名称统一追加 _self；新模型默认禁用、待验证。</p>
  <label className="field">上下文 token 上限<input type="number" min="1" value={form.contextWindow} onChange={e=>edit('contextWindow',e.target.value)}/></label>
  <label className="field">思考强度（逗号分隔）<input value={form.reasoning} onChange={e=>edit('reasoning',e.target.value)}/></label>
  <label className="field checkbox-field"><input type="checkbox" checked={form.tools} onChange={e=>edit('tools',e.target.checked)}/><span>声明支持工具调用</span></label>
  <p className="help">能力值是你的配置声明，不代表上游已验证；当前输入类型为文本。</p>
 </fieldset>}
 {receipt&&<p className="help">恢复编号：{receipt.operationId}。回执不包含 Key。</p>}
 {status&&<p role="status" className="notice">{labels[status]||'请检查恢复状态'}</p>}
 {error&&<p className="error" role="alert">{error}。{receipt?'已保留恢复记录；继续保存前会自动检查状态。':'请修改后重新保存。'}</p>}
 </div>
 <div className="modal-footer"><button disabled={busy} onClick={close}>关闭</button>
 {!receipt&&<button className="primary" disabled={busy||recoveryBlocked} onClick={save}>保存网关</button>}
 {receipt&&<button disabled={busy} onClick={()=>act(async()=>{persist(receipt);setStatus((await request({operation:'gateway-inspect',receipt})).status);})}>检查恢复状态</button>}
 {receipt&&status!=='credential-uncertain'&&status!=='applied'&&<button className="primary" disabled={busy} onClick={save}>继续保存</button>}
 {receipt&&(error==='GE_CONFLICT'||status==='prepared')&&<button disabled={busy} onClick={()=>act(async()=>{retainGatewayReceipt(localStorage,receipt);setReceipt(null);setStatus('');setRecoveryBlocked(false);})}>保留记录，返回新建</button>}
 {status==='applied'&&<button disabled={busy} onClick={()=>act(async()=>{await onApplied();localStorage.removeItem(storageKey);onClose();})}>完成</button>}
 </div>{busy&&<p role="status">正在处理，请稍候…</p>}
 </dialog>;
}
