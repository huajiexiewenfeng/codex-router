import {useState} from 'react';
import {officialProxyFormView,officialProxyError} from './config-view.mjs';

export function OfficialProxySettings({request,service,onService,disabled=false}){
 const [setting,setSetting]=useState(null),[mode,setMode]=useState('direct'),[url,setUrl]=useState(''),[confirmed,setConfirmed]=useState(false);
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const view=officialProxyFormView({setting,mode,url,service,confirmed});
 async function read(){
  const current=await request({operation:'official-proxy-read'});
  setSetting(current);setMode(current.proxyUrl===null?'direct':'proxy');setUrl(current.proxyUrl??'');setConfirmed(false);
  onService(await request({operation:'router-status'}));
 }
 async function act(save){
  setBusy(true);setError('');setNotice('');
  try{
   if(save){await request({operation:'official-proxy-save',revision:setting.revision,proxyUrl:view.proxyUrl,confirmed});setNotice('官方出口设置已保存并备份。请自行启动 Router 后生效；公司网关未改变，未发送连接测试或模型请求。');}
   await read();
  }catch(e){setSetting(null);setConfirmed(false);setError(officialProxyError(e.message));}
  finally{setBusy(false);}
 }
 function edit(callback){callback();setConfirmed(false);setNotice('');setError('');}
 return <details className="codex-setup official-proxy"><summary>官方网络出口</summary>
  <p className="help">仅影响所有 Router Worker 的官方模型请求；公司网关地址与 Key 不变。Router 不会自动读取 Codex 或系统代理设置。</p>
  <button disabled={busy||disabled} onClick={()=>act(false)}>读取官方出口设置</button>
  {setting&&<div style={{maxWidth:680}}>
   <p className="help" style={{overflowWrap:'anywhere'}}>已保存：{setting.proxyUrl??'直连（不使用显式代理）'}。这是配置值，不代表网络连通。</p>
   <label className="field">连接方式 <select value={mode} disabled={busy||disabled} onChange={e=>edit(()=>setMode(e.target.value))}><option value="direct">直连</option><option value="proxy">指定 HTTP/HTTPS 代理</option></select></label>
   {mode==='proxy'&&<label className="field">官方代理地址<input type="url" value={url} disabled={busy||disabled} autoComplete="off" placeholder="http://127.0.0.1:7897" onChange={e=>edit(()=>setUrl(e.target.value))}/></label>}
   {view.error&&<p className="help">{view.error}</p>}
   <p className="help">修改前请在上方停止 Router，并检查确认已停止。不会自动中断 Worker；保存后需自行启动 Router。</p>
   <label style={{display:'flex',alignItems:'center',gap:10,margin:'16px 0'}}><input type="checkbox" checked={confirmed} disabled={busy||disabled} onChange={e=>setConfirmed(e.target.checked)}/>确认修改全部 Router Worker 的官方出口</label>
   <button className="primary" disabled={busy||disabled||!view.canSave} onClick={()=>act(true)}>保存官方出口（自动备份）</button>
  </div>}
  {error&&<p className="error" role="alert">{error}</p>}{notice&&<p className="notice" role="status">{notice}</p>}
 </details>;
}
