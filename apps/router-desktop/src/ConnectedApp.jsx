import {useEffect,useState} from 'react';
import {invoke,isTauri} from '@tauri-apps/api/core';
import {Cube,HardDrives} from '@phosphor-icons/react';
import {App as DemoApp} from './App.jsx';
import {projectGateways,selectionState,serviceStatusView,serviceControls,codexSetupView,runtimeUpgradeView,requestFailureView,catalogSyncView} from './config-view.mjs';
import {ModelSelectionDialog} from './ModelSelectionDialog.jsx';
import {summarize} from './model-state.mjs';
import {GatewayDialog} from './GatewayDialog.jsx';
import {GatewayManageDialog} from './GatewayManageDialog.jsx';
import {WorkerCreationDialog} from './WorkerCreationDialog.jsx';
import {OfficialProxySettings} from './OfficialProxySettings.jsx';
import {RouterMaintenance} from './RouterMaintenance.jsx';

async function request(value){
 const result=await invoke('desktop_request',{request:value});
 if(!result.ok)throw new Error(result.code);
 return result;
}
export function DesktopApp(){
 const [creating,setCreating]=useState(false);
 const [adding,setAdding]=useState(false);
 const [managing,setManaging]=useState(null);
 const [activating,setActivating]=useState(null);
 const [service,setService]=useState(null);
 const [codexSetup,setCodexSetup]=useState(null),[codexNotice,setCodexNotice]=useState('');
 const [snapshot,setSnapshot]=useState(null),[error,setError]=useState(''),[demo,setDemo]=useState(!isTauri());
 const [selected,setSelected]=useState(null),[changes,setChanges]=useState({}),[draft,setDraft]=useState(null),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
 async function refresh(){const next=await request({operation:'read'});setSnapshot(next);}
 useEffect(()=>{if(!demo)refresh().catch(e=>setError(String(e.message||e)));},[]);
 async function act(callback){setBusy(true);setError('');setNotice('');try{await callback();}catch(e){setError(String(e.message||e));}finally{setBusy(false);}}
 if(demo)return <DemoApp/>;
 const gateways=snapshot?projectGateways(snapshot):[];
 const gateway=gateways.find(g=>g.id===selected);
 const managed=gateways.find(g=>g.id===managing);
 async function manageGateway(operation,displayName){
  setBusy(true);try{await request({operation,providerId:managed.id,revision:snapshot.revision,...(operation==='gateway-delete'?{confirmed:true}:{displayName})});await refresh();setManaging(null);setNotice(operation==='gateway-delete'?'网关及模型配置已删除，已自动备份；加密 Key 和凭据记录仍保留。':'网关显示名称已更新；地址、Key 和 Worker 路由未改变。');}finally{setBusy(false);}
 }
 const serviceView=serviceStatusView(service);
 const controls=serviceControls(snapshot?.serviceControl,service);
 const codexControls=codexSetupView(codexSetup);
 async function codexAction(operation){
  setCodexNotice('');
  try{
   if(operation==='codex-prepare'){setCodexSetup(null);setCodexSetup(await request({operation}));return;}
   const receiptId=codexSetup.receiptId;
   if(operation==='codex-launch')setCodexSetup(null);
   await request({operation,receiptId});
   if(operation==='codex-apply'){setCodexSetup({...codexSetup,status:'already-installed'});setCodexNotice('已登记专用 provider 并保留备份；默认模型与官方条目不变。尚未启动 Codex。');}
   else setCodexNotice('已提交 Codex 启动；请确认原生窗口是否打开。尚未验证 Worker 恢复或模型调用。');
  }catch(e){setCodexSetup(null);setCodexNotice(e.message==='DCL_CODEX_RUNNING'?'请先自行完全退出 Codex，再重新检查并启动。本工具不会关闭你的窗口。':'操作未完成，请重新检查；不会自动重试启动。');throw e;}
 }
 async function control(operation){setService(null);setNotice('');setCodexSetup(null);try{const result=await request({operation});setService(result);setNotice(operation==='router-start'?'本地服务已启动或复用；不代表 Worker 已可用，未发送模型请求。关闭本窗口不会停止服务。':'已请求停止全部 Router Worker 的连接；请重新检查状态确认停止完成。');}finally{await refresh();}}
 return <div className="app">{creating&&<WorkerCreationDialog models={(snapshot?.models??[]).filter(m=>m.providerId===snapshot.activeProviderId&&m.enabled!==false).map(m=>m.selectionId)} request={request} onClose={()=>setCreating(false)}/>}<header><div className="brand"><Cube size={36}/><h1>Codex Router</h1></div><div className="toolbar"><button disabled={busy||adding} title={serviceView.detail} onClick={()=>act(async()=>{setService(null);setService(await request({operation:'router-status'}));})}>{serviceView.label}</button><button disabled={busy||!snapshot?.workerCreation} title={snapshot?.workerCreation?'创建当前网关的原生对话':'宿主创建能力尚未就绪'} onClick={()=>setCreating(true)}>创建 Worker</button><button disabled={busy||!snapshot} onClick={()=>setAdding(true)}>添加网关</button></div></header>
 <main><nav><button className="active">网关与模型</button><span className="demo-label">本地配置 · 未验证运行状态</span></nav>
 <p role="status" className="help">{serviceView.detail}</p>
 {service?.requests&&<section aria-label="最近请求诊断">
 <h3>最近请求诊断</h3><p className="help">随右上角状态检查更新，仅显示当前运行周期最近记录。不自动重发请求。</p>
 {!service.requests.available?<p className="help">暂无可读取的请求记录，不能据此判断网关正常。</p>:service.requests.workers.length===0?<p className="help">最近记录中未发现失败或正在处理的请求；这不代表网关已验证。</p>:service.requests.workers.map(row=>{const failure=row.failure&&requestFailureView(row.failure);return <article className="notice" key={row.threadId} style={{overflowWrap:'anywhere'}}>
 <strong>Worker：{row.threadId}</strong>{row.model&&<span> · 最近请求模型：{row.model}</span>}
 <p>{row.active?'请求处理中，请耐心等待，不要重复发送。':row.state==='running'?'本地路由仍在运行。':'该 Worker 本地路由当前不可用。'}</p>
 {failure&&<><p><strong>{row.recovered?'历史失败（之后已有成功响应）':'最近失败'}：{failure.title}</strong> · {new Date(row.failure.timestamp).toLocaleString()}{row.failure.elapsedMs!==undefined&&` · 等待 ${(row.failure.elapsedMs/1000).toFixed(1)} 秒`}</p>{row.failure.model&&<p>失败请求模型：{row.failure.model}</p>}<p>{row.failure.networkCode??row.failure.code}{row.failure.upstreamStatus&&` / HTTP ${row.failure.upstreamStatus}`}</p>{!row.recovered&&<p>{failure.action}</p>}</>}
 </article>;})}
 </section>}
 {runtimeUpgradeView(snapshot?.runtimeUpgrade)&&<p role="status" className="notice">{runtimeUpgradeView(snapshot.runtimeUpgrade)}</p>}
 <p className="notice">{snapshot?.routingMode==='single-active-gateway'?`当前网关：${gateways.find(g=>g.active)?.name??'尚未选择'}。所有 Router Worker 共用其已启用模型；官方模型仍走官方。`:'旧配置尚未迁移到单一当前网关模式。请先更新 runtime，再选择当前网关；不会自动切换或重启服务。'}</p>
 {activating&&<section className="impact" aria-label="确认切换当前网关"><h3>切换至「{gateways.find(g=>g.id===activating)?.name}」？</h3><p>这会影响全部 Router Worker 后续的 _self 请求。正在执行的请求不迁移；目标网关缺少或停用的模型将报错，不自动回退。官方请求不变。</p><button disabled={busy} className="primary" onClick={()=>act(async()=>{await request({operation:'gateway-activate',providerId:activating,revision:snapshot.revision,confirmed:true});setActivating(null);await refresh();setNotice('当前网关已保存。后续公司模型请求使用新网关；已有请求保持原路由，未发送验证请求。');})}>确认切换（全部 Router Worker）</button><button disabled={busy} onClick={()=>setActivating(null)}>取消</button></section>}
 {error==='AG_RUNTIME_UPDATE_REQUIRED'&&<p className="help">当前服务仍登记旧 runtime，尚未切换或写入新格式。请先安排停止服务、备份并更新 runtime，再重新打开本管理窗口。</p>}
 {snapshot?.serviceControl&&<div className="toolbar"><button disabled={busy||adding||!!selected||!controls.start} onClick={()=>act(()=>control('router-start'))}>启动 Router</button><button disabled={busy||adding||!!selected||!controls.stop} title="将中断此 Router 下全部 Worker 连接" onClick={()=>act(()=>control('router-stop'))}>停止 Router（全部 Worker）</button><span className="help">先检查状态；服务运行不等于 Worker 就绪。</span></div>}
 {error&&<p className="error" role="alert">操作未完成：{error}。请检查本地配置；应用失败时先刷新确认结果，勿盲目重试。</p>}
 {error==='DESKTOP_NOT_CONFIGURED'&&<button onClick={()=>setDemo(true)}>未配置本地连接，进入演示预览</button>}
 {notice&&<p role="status" className="notice">{notice}</p>}
 {snapshot?.serviceControl&&<OfficialProxySettings request={request} service={service} onService={setService} disabled={busy||adding||!!selected}/>}
 {snapshot?.serviceControl&&<RouterMaintenance request={request} disabled={busy||adding||!!selected||creating||!!managing} act={act} onChanged={async()=>{setService(null);await refresh();}}/>}
 {snapshot?.serviceControl&&<details className="codex-setup"><summary>连接 Codex</summary>
 <p className="help">先启动 Router 以准备固定入口。这里只登记专用 provider，不改变默认模型或官方模型目录；启动前请自行退出 Codex。</p>
 <div className="toolbar" style={{flexWrap:'wrap'}}><button disabled={busy||adding||!!selected} onClick={()=>act(()=>codexAction('codex-prepare'))}>检查安装与配置</button>
 <button disabled={busy||adding||!!selected||!codexControls.apply} onClick={()=>act(()=>codexAction('codex-apply'))}>登记 Router provider（自动备份）</button>
 <button disabled={busy||adding||!!selected||!codexControls.launch} onClick={()=>act(()=>codexAction('codex-launch'))}>启动 Codex（附带 Router 入口）</button></div>
 {codexSetup&&<p className="help" style={{overflowWrap:'anywhere'}}>桌面程序：{codexSetup.desktopExecutable}<br/>配置目录：{codexSetup.codexHome}<br/>{codexControls.apply?'待登记：仅追加 Router provider。':'provider 已登记；尚未验证原生窗口与 Worker。'}</p>}
 {codexNotice&&<p role="status" className="help">{codexNotice}</p>}
 </details>}
 <div className="section-title"><h2>我的网关</h2><button disabled={busy||!snapshot} onClick={()=>act(async()=>{await refresh();setChanges({});setDraft(null);})}>刷新配置</button></div>
 <div className="cards">{gateways.map(g=>{const stats=summarize(g.models);return <article className="gateway" key={g.id}><div className="gateway-icon"><HardDrives size={29}/></div><div className="gateway-info"><h3>{g.name} {g.active&&<span className="badge green">当前网关</span>}</h3><p>{g.url}</p><div className="gateway-meta"><span className="badge">Key 状态未检查</span><span>已选择 {stats.enabled} / 配置 {stats.total}</span><span>{g.active?'所有 Router Worker 共用':'已保存配置'}</span></div><div className="chips">{stats.preview.map(m=><span key={m.id}>{m.selectionId}</span>)}{stats.enabled>3&&<span>+{stats.enabled-3}</span>}</div></div><div className="gateway-actions"><button disabled={busy||g.active} onClick={()=>{setActivating(g.id);setError('');setNotice('');}}>{g.active?'当前网关':'设为当前网关'}</button><button disabled={busy} onClick={()=>{setSelected(g.id);setChanges({});setDraft(null);}}>查看模型</button><button disabled={busy} onClick={()=>setManaging(g.id)}>管理网关</button></div></article>;})}</div>
 {!gateways.length&&snapshot&&<p className="empty">还没有网关，点击「添加网关」开始配置。</p>}
 {managed&&<GatewayManageDialog key={managed.id} gateway={managed} busy={busy} onClose={()=>setManaging(null)} onRename={name=>manageGateway('gateway-rename',name)} onDelete={()=>manageGateway('gateway-delete')}/>}
 {gateway&&<ModelSelectionDialog key={gateway.id} gateway={gateway} changes={changes} draft={draft} busy={busy} error={error} notice={notice}
  onVerify={modelId=>act(async()=>{await request({operation:'model-verify',modelId,revision:snapshot.revision,confirmed:true});await refresh();setNotice('文本流验证通过并已保存记录；启用状态和当前网关未改变。工具调用、上下文上限与原生对话尚未验证。');})}
  onClose={()=>{if(!busy){setSelected(null);setDraft(null);setChanges({});setNotice('');setError('');}}}
  onChange={edit=>{const next=selectionState(gateway.models,changes,draft,edit);setChanges(next.changes);setDraft(next.receipt);setNotice('');setError('');}}
  onRefresh={()=>act(async()=>{await refresh();setChanges({});setDraft(null);setNotice('已重新读取配置，请重新选择。');})}
  onSave={()=>act(async()=>{setNotice('');const receipt=await request({operation:'save-selection',revision:snapshot.revision,changes:Object.entries(changes).map(([modelId,enabled])=>({modelId,enabled}))});setDraft(receipt);setNotice('草稿已保存，尚未应用。');})}
  onSync={()=>act(async()=>{const result=await request({operation:'catalog-sync',confirmed:true});setNotice(catalogSyncView(result.catalog));})}
  onApply={()=>act(async()=>{setNotice('');const result=await request({operation:'apply',draftId:draft.draftId});setDraft(null);setChanges({});setNotice('Router 模型配置已保存。'+catalogSyncView(result.catalog));await refresh();})}
 />}
 {adding&&<GatewayDialog request={request} onClose={()=>setAdding(false)} onApplied={refresh}/>}
 </main><footer><span>Key 仅加密写入，不回显 · 模型验证与 Worker 初始化需明确确认；结果不明不自动重发</span><span>配置版本 {snapshot?.generation??'—'}</span></footer></div>;
}
