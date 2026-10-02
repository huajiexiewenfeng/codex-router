import {useEffect,useRef,useState} from 'react';
import {workerCreationView} from './worker-creation-view.mjs';
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export function WorkerCreationDialog({models,request,onClose}){
 const dialog=useRef(null);
 const [cwd,setCwd]=useState(''),[title,setTitle]=useState(''),[model,setModel]=useState(models[0]??'');
 const [job,setJob]=useState(null),[receipt,setReceipt]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 useEffect(()=>{const d=dialog.current;d.showModal();return()=>d.close();},[]);
 const view=workerCreationView(job);
 async function act(operation){
  setBusy(true);setError('');
  try{
   if(operation==='worker-prepare'){
    const result=await request({operation,input:{cwd,title,model}});setReceipt(result.operationId);setJob(result);
   }else{
    // Before dispatch, remove the create action even when IPC loses its reply.
    if(operation==='worker-start')setJob({...job,status:'creation-in-progress'});
    const result=await request({operation,operationId:receipt,...(operation==='worker-start'?{confirmed:true}:{})});setJob(result);
   }
  }catch(e){setError(e.message);}finally{setBusy(false);}
 }
 return <dialog ref={dialog} className="wide" aria-labelledby="worker-create-title" onCancel={e=>{e.preventDefault();if(!busy)onClose();}}>
 <div className="modal-heading"><h2 id="worker-create-title">创建 Router Worker</h2><button disabled={busy} onClick={onClose}>关闭</button></div>
 <p className="help">使用当前网关；不会更改其他 Worker，也不会自动加入 Team Runtime 团队。</p>
 {!job&&<><label>项目目录（绝对路径）<input value={cwd} disabled={busy} onChange={e=>setCwd(e.target.value)}/></label>
 <label>对话标题<input value={title} disabled={busy} onChange={e=>setTitle(e.target.value)} placeholder="自动添加 Router- 前缀"/></label>
 <label>模型<select value={model} disabled={busy} onChange={e=>setModel(e.target.value)}>{models.map(m=><option key={m}>{m}</option>)}</select></label></>}
 <p role="status" className="notice">{view.message}</p>
 {receipt&&<p style={{overflowWrap:'anywhere'}}>创建回执：{receipt}。保留此编号可查询结果。</p>}
 {job?.threadId&&uuid.test(job.threadId)&&<p>原生对话入口：<code>{`codex://threads/${job.threadId}`}</code>（复制到 Codex 打开）</p>}
 {error&&<p role="alert" className="error">{error}。结果不明确时先查询，不要重新创建。</p>}
 {!job&&<label>恢复已有创建回执<input value={receipt} disabled={busy} onChange={e=>setReceipt(e.target.value)} placeholder="operationId"/></label>}
 <div className="modal-footer"><button disabled={busy} onClick={onClose}>关闭</button>
 {!job&&<button disabled={busy||!cwd.trim()||!title.trim()||!model||!!receipt} onClick={()=>act('worker-prepare')}>准备创建（不发送请求）</button>}
 {view.canStart&&<button className="primary" disabled={busy} onClick={()=>act('worker-start')}>确认创建（含一次初始化请求）</button>}
 {receipt&&<button disabled={busy||!uuid.test(receipt)} onClick={()=>act('worker-status')}>查询创建结果</button>}</div>
 </dialog>;
}
