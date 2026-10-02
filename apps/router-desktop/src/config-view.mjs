export function selectionState(models,changes,receipt,edit){
 const original=models.find(model=>model.id===edit.id);
 if(!original||typeof edit.enabled!=='boolean')throw new Error('未知模型或无效选择');
 const next={...changes};
 if(original.enabled===edit.enabled)delete next[edit.id];else next[edit.id]=edit.enabled;
 return {changes:next,receipt:null,models:models.map(model=>({...model,enabled:next[model.id]??model.enabled}))};
}
export function projectGateways(snapshot){
 return snapshot.providers.map(provider=>({
  id:provider.id,name:provider.displayName??provider.id,url:provider.responsesUrl,
  active:snapshot.routingMode==='single-active-gateway'&&snapshot.activeProviderId===provider.id,global:snapshot.routingMode==='single-active-gateway',
  workers:provider.workers??[],
  models:snapshot.models.filter(model=>model.providerId===provider.id).map(model=>({
   id:model.modelId,upstream:model.upstreamModel,selectionId:model.selectionId,
   enabled:model.enabled,readiness:model.readiness
  }))
 }));
}
export function serviceStatusView(snapshot){
 const labels={not_started:'未启动',stopped:'已停止',running:'运行中',stopping:'停止中',unknown:'状态异常',expired:'已过期',budget_exhausted:'请求额度已用完'};
 if(!snapshot||snapshot.scope!=='local-heartbeat-only'||!Number.isSafeInteger(snapshot.checkedAt)||!Object.hasOwn(labels,snapshot.state))return {label:'Router 状态未检查',detail:'点击检查当前桌面配置对应的 Router；不会启动服务或发送模型请求。'};
 return {label:`上次检查：${labels[snapshot.state]}`,detail:`检查时间 ${new Date(snapshot.checkedAt).toLocaleTimeString()}。仅依据本地心跳和锁，不代表网关或模型可用；点击可重新检查。`};
}
export function serviceControls(allowed,snapshot){
 const checked=allowed===true&&snapshot?.scope==='local-heartbeat-only'&&Number.isSafeInteger(snapshot.checkedAt);
 return {start:checked&&['not_started','stopped'].includes(snapshot.state),stop:checked&&snapshot.canStop===true};
}
export function requestFailureView(failure){
 const action='网关可能已接收或计费，本程序不会自动重发。请先核对网关记录，再决定是否在原对话手动重试。';
 if(failure?.route==='official'&&failure.code==='transport_failed_before_headers')return {
  title:failure.networkCode==='UND_ERR_CONNECT_TIMEOUT'?'官方连接超时':'官方连接失败',
  action:'未收到官方响应头。请检查「官方网络出口」中的代理地址、代理程序及网络；这不是公司网关额度的判断。本程序不会自动重发或切换路由。'
 };
 if(failure?.code==='local_storage_failed')return {title:'本地调用记录写入失败',action:'此 Worker 已保护性停止。请检查存储和诊断记录，确认修复后恢复服务；不要反复发送消息。'};
 if(failure?.code==='first_byte_timeout')return {title:'等待上游响应超时',action:'尚未确认云端是否完成。请检查网关记录，避免重复请求或重复计费。'};
 if(failure?.code==='stream_idle_timeout')return {title:'响应流长时间无数据',action};
 if(failure?.code==='transport_failed_before_headers')return {title:failure.networkCode==='ECONNRESET'?'上游连接中断':'连接上游失败',action};
 if(failure?.code==='upstream_http_error')return {title:'上游返回错误状态',action:'请核对网关错误详情。程序不会自动重发，也不会自动更换模型或网关。'};
 return {title:'本次响应未完成',action};
}
export function codexSetupView(setup){
 const valid=typeof setup?.receiptId==='string'&&setup.receiptId.length>0;
 return {apply:valid&&setup.status==='ready',launch:valid&&setup.status==='already-installed'};
}
export function officialProxyFormView({setting,mode,url,service,confirmed}){
 const proxyUrl=mode==='direct'?null:url.trim();
 let valid=mode==='direct',error='';
 if(mode==='proxy'){
  try{const u=new URL(proxyUrl);valid=['http:','https:'].includes(u.protocol)&&!u.username&&!u.password&&!u.search&&!u.hash&&u.pathname==='/'&&!/[\x00-\x20\x7f]/.test(proxyUrl);}catch{valid=false;}
  if(!valid)error='请填写 HTTP/HTTPS 代理地址（例如 http://127.0.0.1:7897），不含账号、密码、路径或查询参数。';
 }
 const stopped=serviceControls(true,service).start;
 return {proxyUrl,error,canSave:!!setting?.revision&&stopped&&valid&&confirmed===true&&proxyUrl!==setting.proxyUrl};
}
export function officialProxyError(code){
 return ({OP_STOP_REQUIRED:'请先在上方停止 Router（全部 Worker），检查确认已停止后再保存。程序不会自动停止服务。',OP_STALE:'配置已更新，请重新读取后再修改。',DESKTOP_CONFIG_CHANGED:'本地配置已被其他操作更改，请重新打开管理窗口后读取。',OP_URL:'代理地址格式不支持；请使用不含账号密码的 HTTP/HTTPS 代理地址。',OP_CONFIRM:'请确认此次修改会影响全部 Router Worker 的官方出口。',MR_STORE_LOCKED:'其他操作正在使用配置，请操作结束后重新读取。'})[code]??'操作未完成，请重新读取确认配置；不会自动重试或发送模型请求。';
}
export function runtimeUpgradeView(upgrade){
 if(upgrade?.status==='updated')return '后台程序与配置已自动更新，旧配置已备份；Key 和 Worker 保留。未发送模型请求。';
 if(upgrade?.status==='pending-stop')return '后台更新待完成：请先停止 Router，确认已停止后点击启动 Router，将自动备份并更新。不会自动中断当前服务。状态异常时请保留现场排查。';
 if(upgrade?.status==='blocked'){
  const actions={DU_PACKAGE_INVALID:'安装包文件缺失或校验失败，请重新安装完整的新版本。',DU_LOCKED:'配置正被占用，请关闭其他管理窗口，确认操作结束后重开。',DU_CONFIG_UNSUPPORTED:'此配置不属于受支持的桌面托管格式，已保留原配置，请联系维护者迁移。',DU_CONFIG_CHANGED:'配置已被其他操作更改，请重新打开管理窗口。'};
  return `后台更新未完成：${actions[upgrade.code]??'请保留配置和备份，联系维护者检查；不要删除数据。'}（${upgrade.code??'DU_UPGRADE_FAILED'}）`;
 }
 return '';
}
export function catalogSyncView(result){
 const official=result?.officialCatalog;
 const officialNote=!official?'':['cache-merged','cache-bundled-merged','bundled-merged'].includes(official.status)
  ?` 已合并本地官方${official.status==='cache-merged'?'缓存':'缓存或已安装客户端内置目录'}中的新条目，不保证云端最新；已有同名条目保持不变。菜单条目不代表 Router 路由或账号已支持该模型。`
  :' 官方模型未同步：本地官方缓存缺失、过期或格式不受支持。请先确认 Codex 原生官方列表已更新，再同步菜单；不会自动联网刷新。';
 if(result?.status==='updated')return 'Codex 自定义模型目录已更新并备份。请在方便时重启 Codex 加载菜单；不会自动重启或切换已有对话的模型。'+officialNote;
 if(result?.status==='unchanged')return 'Codex 自定义模型目录与当前配置一致；若此前尚未重启 Codex，请重启加载。尚未核验原生菜单。'+officialNote;
 const reason=result?.code==='DCM_NOT_CONFIGURED'?'尚未配置 Codex 自定义模型目录。':result?.code==='DCM_LOCKED'?'目录正在被其他操作使用，请稍后重新同步。':result?.code==='DCM_TARGET'?'目录路径不安全或指向官方缓存，已停止更新。':'请检查 Codex 接入配置后重新同步。';
 return `Codex 菜单未更新：${reason} Router 已保存的配置不回滚。`;
}

export function maintenanceError(code){
 if(code==='OM_PORT_REQUIRED')return '尚未准备固定 Router 入口。请先正常启动 Router 一次，再自行停止服务后检查官方模型；本操作不会自动启动。';
 if(code==='OM_LOCK_CHANGED')return '维护锁在操作期间发生变化，已保留现场。请关闭其他管理窗口并联系维护者检查，不要手动删除锁。';
 const known={OM_STOP_REQUIRED:'请先停止 Router（全部 Worker），确认空闲并停止后再同步；程序不会自动停止服务。',OM_STALE:'来源或配置已变化，请重新检查官方模型后确认。',OM_SOURCE_UNAVAILABLE:'未找到可信的本地官方模型，请检查 Codex 安装及本地缓存；不会联网刷新。',OM_CONFIRM:'请明确确认将官方模型加入全部 Router Worker 共用的路由配置。',OM_SHARED_ONLY:'此入口仅支持共享 Router，未更改旧式配置。',ROUTER_RECOVERY_PROCESS_NOT_ABSENT:'尚不能确认原服务进程已经退出；不会清理锁，也不会终止进程。',ROUTER_RECOVERY_PORT_NOT_FREE:'服务端口仍被占用；不会清理锁或停止占用进程。',ROUTER_RECOVERY_STATUS_AMBIGUOUS:'服务心跳尚未过期或状态无法确认；请稍后重新检查，保留现场。',ROUTER_RECOVERY_PLAN_EXPIRED:'恢复检查已过期，请重新检查后确认。',ROUTER_RECOVERY_SNAPSHOT_CHANGED:'恢复期间状态已改变，已停止操作。请重新检查，不要手动删除锁。',DESKTOP_CONFIG_CHANGED:'配置已被其他操作修改，请重新打开管理窗口。',MR_STORE_LOCKED:'配置或服务正在被其他操作使用，请稍后重新检查。'};
 return known[code]??'未满足安全检查条件，未自动重启或重发请求。请保留现场并重新检查；不要手动删除锁文件。';
}
