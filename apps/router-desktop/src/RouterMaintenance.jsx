import {useState} from 'react';
import {catalogSyncView,maintenanceError} from './config-view.mjs';

export function RouterMaintenance({request,disabled,act,onChanged}){
 const [official,setOfficial]=useState(null),[recovery,setRecovery]=useState(null),[message,setMessage]=useState(''),[error,setError]=useState('');
 const run=callback=>act(async()=>{setMessage('');setError('');try{await callback();}catch(e){setError(maintenanceError(e.message));}});
 return <details className="codex-setup"><summary>维护与恢复</summary>
 <p className="help">仅处理本地配置与异常遗留状态；不会发送模型请求、自动停止或重启服务。</p>
 <section aria-label="同步官方模型">
 <h3>同步官方模型与路由</h3><p className="help">检查已安装 Codex 的内置目录和有效本地缓存。确认后只追加官方模型路由并同步自定义菜单，不修改已有官方条目的指令，不改变任何对话当前模型。</p>
 <button disabled={disabled} onClick={()=>run(async()=>{setOfficial(null);setRecovery(null);setOfficial(await request({operation:'official-models-prepare'}));})}>检查官方模型（只读）</button>
 {official&&<div className="impact"><p>待加入 Router 官方路由：{official.addedModels.length?official.addedModels.join('、'):'无新增'}。</p><p>请先停止 Router。此次同步影响全部 Router Worker 的后续官方请求；公司网关配置不变。保存后需自行启动 Router，重启 Codex 加载新菜单。模型可用性仍取决于账号权限。</p><button className="primary" disabled={disabled} onClick={()=>run(async()=>{const receiptId=official.receiptId;setOfficial(null);const r=await request({operation:'official-models-sync',receiptId,confirmed:true});setMessage('官方路由配置已同步，未启动服务。'+catalogSyncView(r.catalog));await onChanged();})}>确认同步官方路由与菜单</button><button disabled={disabled} onClick={()=>setOfficial(null)}>取消</button></div>}
 </section>
 <section aria-label="恢复异常服务"><h3>恢复异常停止的 Router</h3><p className="help">仅当服务心跳或维护锁超过 60 秒未更新、原进程已退出、端口空闲且锁归属一致时允许恢复。先备份，再清理已确认的遗留锁；不删除 Worker、计数记录或历史。</p>
 <button disabled={disabled} onClick={()=>run(async()=>{setRecovery(null);setOfficial(null);setRecovery(await request({operation:'router-recovery-prepare'}));})}>检查是否可恢复（只读）</button>
 {recovery&&<div className="impact"><p>已确认旧进程 {recovery.pid} 不存在，可恢复残留状态及 {recovery.lockCount} 个遗留锁。确认时会再次核验，状态变化则停止。</p><button className="primary" disabled={disabled} onClick={()=>run(async()=>{const token=recovery.token;setRecovery(null);const r=await request({operation:'router-recovery-confirm',token,confirmed:true});setMessage(`已恢复残留状态及 ${r.recoveredLocks} 个锁并保留备份。请重新检查状态后自行启动 Router；未重发请求。备份：${r.backupPath}`);await onChanged();})}>确认备份并恢复（不启动服务）</button><button disabled={disabled} onClick={()=>setRecovery(null)}>取消</button></div>}
 </section>
 {error&&<p className="error" role="alert">{error}</p>}{message&&<p className="notice" role="status" style={{overflowWrap:'anywhere'}}>{message}</p>}
 </details>;
}
