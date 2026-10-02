const fail=code=>{throw new Error(code);};
export function workerModePlan(request) {
  if(!request||typeof request!=='object'||Array.isArray(request))fail('WORKER_MODE_INVALID');
  if(request.mode===undefined)return {
    status:'needs_user_choice',createsThread:false,
    question:{title:'创建哪种 Worker？',options:[
      {value:'official',label:'官方原生',description:'保留官方登录与原生 Provider。'},
      {value:'router',label:'Router',description:'原生菜单支持官方与公司 _self 模型，独立任务绑定，默认无有效期和请求次数上限。'},
    ]},
  };
  if(!['official','router'].includes(request.mode))fail('WORKER_MODE_INVALID');
  if(typeof request.title!=='string'||!request.title.trim()||/[\r\n\u0000-\u001f]/.test(request.title))fail('WORKER_TITLE_INVALID');
  const title=request.mode==='router'&&!request.title.startsWith('Router-')?'Router-'+request.title:request.title;
  if(title.length>200)fail('WORKER_TITLE_INVALID');
  if(request.mode==='official') {
    if(title.startsWith('Router-'))fail('WORKER_TITLE_ROUTE_CONFLICT');
    if(typeof request.model==='string'&&/(?:_|-)self$/.test(request.model))fail('WORKER_OFFICIAL_SELF_MODEL');
  }
  return {status:'mode_selected',mode:request.mode,title,requiresTaskBinding:request.mode==='router',createsThread:false};
}
