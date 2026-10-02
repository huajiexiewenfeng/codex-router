import test from 'node:test';
import assert from 'node:assert/strict';
import * as selection from '../src/config-view.mjs';
import {filterModels} from '../src/model-state.mjs';
const models=[{id:'a',upstream:'sol',selectionId:'sol_self',enabled:true},{id:'b',upstream:'luna',selectionId:'luna_self',enabled:false}];
test('maintenance messages explain local-only scope, safe recovery and explicit stop requirement',()=>{
 assert.match(selection.maintenanceError('OM_STOP_REQUIRED'),/停止 Router/);
 assert.match(selection.maintenanceError('OM_STALE'),/重新检查/);
 assert.match(selection.maintenanceError('ROUTER_RECOVERY_PROCESS_NOT_ABSENT'),/进程/);
 assert.match(selection.maintenanceError('ROUTER_RECOVERY_PORT_NOT_FREE'),/端口/);
 assert.doesNotMatch(selection.maintenanceError('private-secret'),/private-secret/);
 assert.match(selection.catalogSyncView({status:'updated',officialCatalog:{status:'cache-bundled-merged'}}),/内置/);
 assert.match(selection.catalogSyncView({status:'updated',officialCatalog:{status:'bundled-merged'}}),/已有同名条目保持不变/);
});
test('official proxy form requires loaded settings, stopped status, valid input and explicit shared-impact confirmation',()=>{
 assert.equal(typeof selection.officialProxyFormView,'function');
 const args={setting:{revision:'a'.repeat(64),proxyUrl:null},mode:'proxy',url:'http://127.0.0.1:7897',service:{state:'stopped',scope:'local-heartbeat-only',checkedAt:1},confirmed:true};
 assert.equal(selection.officialProxyFormView(args).canSave,true);
 assert.equal(selection.officialProxyFormView({...args,setting:null}).canSave,false);
 assert.equal(selection.officialProxyFormView({...args,confirmed:false}).canSave,false);
 for(const state of ['running','unknown','stopping'])assert.equal(selection.officialProxyFormView({...args,service:{...args.service,state}}).canSave,false);
 for(const url of ['','socks5://127.0.0.1:7897','http://user:secret@localhost','http://localhost/path'])assert.equal(selection.officialProxyFormView({...args,url}).canSave,false);
 assert.equal(selection.officialProxyFormView({...args,mode:'direct'}).proxyUrl,null);
 assert.equal(selection.officialProxyFormView({...args,mode:'direct'}).canSave,false,'unchanged configuration is not resaved');
 assert.match(selection.officialProxyError('OP_STOP_REQUIRED'),/停止 Router/);
 assert.match(selection.officialProxyError('OP_STALE'),/重新读取/);
 assert.doesNotMatch(selection.officialProxyError('private-secret'),/private-secret/);
});

test('official connection failure points to its own network exit, not company quota',()=>{
 const failure={code:'transport_failed_before_headers',route:'official',networkCode:'UND_ERR_CONNECT_TIMEOUT'};
 const result=selection.requestFailureView(failure);
 assert.match(result.title,/官方/);assert.match(result.title,/超时/);assert.match(result.action,/官方网络出口/);assert.match(result.action,/不会自动重发/);
 assert.doesNotMatch(result.action,/网关记录|公司额度不足/);
 assert.doesNotMatch(selection.requestFailureView({...failure,route:'company'}).action,/官方网络出口/);
 assert.doesNotMatch(selection.requestFailureView({...failure,route:undefined}).action,/官方网络出口/);
});
test('request failures explain uncertainty without encouraging replay',()=>{
 assert.equal(typeof selection.requestFailureView,'function');
 const r=selection.requestFailureView({code:'transport_failed_before_headers',networkCode:'ECONNRESET'});
 assert.match(r.title,/连接中断/);assert.match(r.action,/可能已接收/);assert.match(r.action,/原对话/);
 assert.match(selection.requestFailureView({code:'local_storage_failed'}).title,/本地/);
 assert.match(selection.requestFailureView({code:'first_byte_timeout'}).action,/重复/);
 assert.doesNotMatch(JSON.stringify(selection.requestFailureView({code:'private-secret'})),/private-secret/);
});
test('gateway projection exposes binding records without inventing an active route',()=>{
 const workers=[{hostId:'local',threadId:'id',allowedModels:['sol_self']}];
 const view=selection.projectGateways({providers:[{id:'p',responsesUrl:'https://example/v1/responses',workers}],models:[]});
 assert.deepEqual(view[0].workers,workers);assert.equal(view[0].active,false);
});
test('active gateway UI state comes from configuration rather than worker presence',()=>{
 const view=selection.projectGateways({routingMode:'single-active-gateway',activeProviderId:'b',providers:[{id:'a',workers:[{threadId:'x'}]},{id:'b',workers:[]}],models:[]});
 assert.equal(view[0].active,false);assert.equal(view[1].active,true);assert.equal(view[1].global,true);
});
test('selection draft preserves hidden rows and removes reverted changes',()=>{
 assert.equal(typeof selection.selectionState,'function');
 let state=selection.selectionState(models,{},null,{id:'b',enabled:true});
 assert.equal(filterModels(state.models,'sol','enabled').length,1);
 assert.deepEqual(state.changes,{b:true});
 state=selection.selectionState(models,state.changes,null,{id:'b',enabled:false});
 assert.deepEqual(state.changes,{});assert.equal(models[1].enabled,false);
});
test('editing invalidates saved receipt without mutating unrelated selections',()=>{
 assert.equal(typeof selection.selectionState,'function');
 const state=selection.selectionState(models,{b:true},{draftId:'old'},{id:'a',enabled:false});
 assert.equal(state.receipt,null);assert.deepEqual(state.changes,{b:true,a:false});
 assert.throws(()=>selection.selectionState(models,{},null,{id:'missing',enabled:true}));
});
test('config projection preserves stable IDs and does not fabricate credential or live state',async()=>{
 const api=await import('../src/config-view.mjs').catch(()=>({}));assert.equal(typeof api.projectGateways,'function');
 const result=api.projectGateways({providers:[{id:'p',responsesUrl:'https://example.com/v1/responses'}],models:[{modelId:'m',providerId:'p',upstreamModel:'gpt-6-sol',selectionId:'gpt-6-sol_self',enabled:false,readiness:'verified'}]});
 assert.equal(result[0].models[0].id,'m');assert.equal(result[0].models[0].enabled,false);assert.equal(result[0].credential,undefined);
});
test('friendly gateway labels do not replace machine identifiers',()=>{
 const view=selection.projectGateways({providers:[{id:'a',displayName:'公司网关',responsesUrl:'https://a.example/v1/responses'},{id:'b',responsesUrl:'https://b.example/v1/responses'}],models:[]});
 assert.equal(view[0].name,'公司网关');assert.equal(view[0].id,'a');assert.equal(view[1].name,'b');
});
test('service snapshot wording never claims upstream health or perpetual live status',async()=>{
 const {serviceStatusView}=await import('../src/config-view.mjs');
 assert.equal(typeof serviceStatusView,'function');
 assert.equal(serviceStatusView(null).label,'Router 状态未检查');
 for(const [state,label] of Object.entries({not_started:'未启动',stopped:'已停止',running:'运行中',stopping:'停止中',unknown:'状态异常',expired:'已过期',budget_exhausted:'请求额度已用完'})){
  const result=serviceStatusView({state,checkedAt:1,scope:'local-heartbeat-only'});
  assert.equal(result.label,`上次检查：${label}`);assert.match(result.detail,/不代表网关或模型可用/);
 }
 assert.equal(serviceStatusView({state:'private-invalid'}).label,'Router 状态未检查');
});
test('service controls require host capability and a checked usable state',()=>{
 assert.equal(typeof selection.serviceControls,'function');
 const snap=state=>({state,checkedAt:1,scope:'local-heartbeat-only',canStop:state==='running'});
 assert.deepEqual(selection.serviceControls(true,null),{start:false,stop:false});
 assert.deepEqual(selection.serviceControls(false,snap('running')),{start:false,stop:false});
 assert.deepEqual(selection.serviceControls(true,snap('not_started')),{start:true,stop:false});
 assert.deepEqual(selection.serviceControls(true,snap('stopped')),{start:true,stop:false});
 assert.deepEqual(selection.serviceControls(true,snap('running')),{start:false,stop:true});
 for(const state of ['stopping','unknown'])assert.deepEqual(selection.serviceControls(true,snap(state)),{start:false,stop:false});
 assert.deepEqual(selection.serviceControls(true,{...snap('unknown'),canStop:true}),{start:false,stop:true});
});
test('runtime upgrade messages give an action without claiming model health',()=>{
 assert.equal(typeof selection.runtimeUpgradeView,'function');
 assert.equal(selection.runtimeUpgradeView(null),'');
 assert.match(selection.runtimeUpgradeView({status:'pending-stop'}),/停止 Router/);
 assert.match(selection.runtimeUpgradeView({status:'updated'}),/备份/);
 assert.match(selection.runtimeUpgradeView({status:'blocked',code:'DU_PACKAGE_INVALID'}),/安装包/);
 assert.match(selection.runtimeUpgradeView({status:'blocked',code:'DU_LOCKED'}),/其他管理窗口/);
 assert.equal(selection.runtimeUpgradeView({status:'current'}),'');
});
test('Codex setup allows launch only after provider registration',async()=>{
 const {codexSetupView}=await import('../src/config-view.mjs');
 assert.equal(typeof codexSetupView,'function');
 assert.deepEqual(codexSetupView(null),{apply:false,launch:false});
 assert.deepEqual(codexSetupView({status:'ready',receiptId:'one'}),{apply:true,launch:false});
 assert.deepEqual(codexSetupView({status:'already-installed',receiptId:'one'}),{apply:false,launch:true});
 assert.deepEqual(codexSetupView({status:'spawned'}),{apply:false,launch:false});
});
test('catalog sync distinguishes local application, startup reload and failure',async()=>{
 const {catalogSyncView}=await import('../src/config-view.mjs');
 assert.match(catalogSyncView({status:'updated'}),/重启 Codex/);
 assert.match(catalogSyncView({status:'unchanged'}),/一致/);
 assert.match(catalogSyncView({status:'failed',code:'DCM_NOT_CONFIGURED'}),/未配置/);
 assert.match(catalogSyncView({status:'failed',code:'DCM_LOCKED'}),/未更新/);
});

test('catalog sync never presents cached official models as cloud freshness or route readiness',()=>{
 const merged=selection.catalogSyncView({status:'updated',officialCatalog:{status:'cache-merged',addedCount:1,cloudVerified:false}});
 assert.match(merged,/官方缓存/);assert.match(merged,/云端最新/);assert.match(merged,/路由/);
 for(const status of ['missing','invalid','stale']){
  const message=selection.catalogSyncView({status:'unchanged',officialCatalog:{status,cloudVerified:false}});
  assert.match(message,/官方模型未同步/);assert.match(message,/Codex/);
 }
});
