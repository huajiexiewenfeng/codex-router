export function demoGateways() {
  return [{id:'company',name:'公司 AI 网关',url:'https://gateway.example.com/v1',credential:true,models:['gpt-6-sol','gpt-6-luna','gpt-6-astra','deepseek-chat','glm-model',...Array.from({length:20},(_,i)=>`model-${String(i+1).padStart(2,'0')}`)].map((upstream,i)=>({id:`company-${i}`,upstream,selectionId:`${upstream}_self`,enabled:i<5,readiness:i<3?'verified':'pending'}))},{id:'personal',name:'个人备用网关',url:'https://api.example.net/v1',credential:false,models:[]}];
}
