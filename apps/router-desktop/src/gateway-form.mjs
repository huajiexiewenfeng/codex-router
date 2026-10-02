export function initialGatewayForm(){return {displayName:'',baseUrl:'',models:'',contextWindow:'262144',reasoning:'low,medium,high,xhigh,max',tools:true,allowHttp:true};}
export async function saveGateway({request,storage,form,secret,receipt,onReceipt=()=>{},onStatus=()=>{}}){
 const validateKey=()=>{if(typeof secret!=='string'||! /^[\x21-\x7e]{1,8192}$/.test(secret))throw Error('请填写有效 API Key（不含空格）。');};
 let status;
 if(!receipt){
  validateKey();
  receipt=await request({operation:'gateway-prepare',input:gatewayInput(form)});
  receipt=parseGatewayReceipt(JSON.stringify(receipt));onReceipt(receipt);status='prepared';
 }else{
  receipt=parseGatewayReceipt(JSON.stringify(receipt));
  status=(await request({operation:'gateway-inspect',receipt})).status;
 }
 onStatus(status);
 if(status==='credential-uncertain')throw Error('GE_KEY_UNCERTAIN');
 if(!['prepared','credential-ready','credentials-registered','applied'].includes(status))throw Error('恢复状态未知，请检查配置。');
 persistGatewayReceipt(storage,receipt);
 if(status==='prepared'){
  validateKey();status=(await request({operation:'gateway-create-key',receipt,secret})).status;onStatus(status);
 }
 if(['credential-ready','credentials-registered'].includes(status)){
  status=(await request({operation:'gateway-apply',receipt})).status;onStatus(status);
 }
 if(status!=='applied')throw Error('保存结果未确认，请检查恢复状态。');
 return {receipt,status};
}
export function mergeGatewayModels(current,names){return [...new Set([...String(current).split(/[\n,]/).map(s=>s.trim()).filter(Boolean),...names])].join('\n');}
export function gatewayInput(form){
 const models=String(form.models).split(/[\n,]/).map(s=>s.trim()).filter(Boolean);
 const contextWindow=Number(form.contextWindow),reasoningEfforts=String(form.reasoning).split(',').map(s=>s.trim()).filter(Boolean);
 if(!models.length)throw Error('请同步或填写至少一个模型名称。');
 if(models.length>200)throw Error('一次最多添加 200 个模型，请从列表中删去暂不需要的模型。');
 if(!Number.isSafeInteger(contextWindow)||contextWindow<=0||!reasoningEfforts.length)throw Error('请填写有效上下文长度和思考强度。');
 return {displayName:form.displayName,baseUrl:form.baseUrl,allowHttp:form.allowHttp,models,capabilities:{contextWindow,inputModalities:['text'],tools:form.tools,reasoningEfforts}};
}
export function parseGatewayReceipt(text){
 const r=JSON.parse(text);
 if(!r||Object.keys(r).sort().join(',')!=='ok,operationId,planSha256'||r.ok!==true||typeof r.operationId!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(r.operationId)||typeof r.planSha256!=='string'||!/^[a-f0-9]{64}$/.test(r.planSha256))throw Error('恢复回执无效；请保留记录并检查宿主配置。');
 return r;
}
export const receiptStorageKey='codex-router.gateway-receipt.v1';
export function persistGatewayReceipt(storage,receipt){
 const encoded=JSON.stringify(parseGatewayReceipt(JSON.stringify(receipt)));
 storage.setItem(receiptStorageKey,encoded);
 if(storage.getItem(receiptStorageKey)!==encoded)throw Error('恢复回执未保存，禁止继续写入 Key');
}
export function retainGatewayReceipt(storage,receipt){
 const key=receiptStorageKey+'.retained',records=JSON.parse(storage.getItem(key)||'[]');
 if(!Array.isArray(records))throw Error('保留记录无效');
 const next=JSON.stringify([...records,parseGatewayReceipt(JSON.stringify(receipt))]);
 storage.setItem(key,next);if(storage.getItem(key)!==next)throw Error('保留记录失败');
 storage.removeItem(receiptStorageKey);
}
