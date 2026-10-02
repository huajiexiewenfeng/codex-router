export const threadId='00000000-0000-4000-8000-000000000001';
export const turnId='00000000-0000-4000-8000-000000000002';
export const binding={hostId:'local',threadId,allowedModels:['one_self','two_self']};
export function modelRegistry(){return {
 schemaVersion:2,generation:1,suffix:'_self',
 providers:['one','two'].map(id=>({id,kind:'api-key',wireApi:'responses',responsesUrl:`https://${id}.example/v1/responses`,credentialRef:id+'-key',allowHttp:false})),
 models:['one','two'].map(id=>({modelId:'model-'+id,selectionId:id+'_self',displayName:id,upstreamModel:'gpt-6-sol',providerId:id,readiness:'verified',verificationRef:'fixture-proof',
  capabilities:{contextWindow:262144,inputModalities:['text','image'],tools:true,reasoningEfforts:['low','high','xhigh','max']},
  catalogEntry:{slug:id+'_self',display_name:id,description:'fixture',visibility:'list',context_window:262144,input_modalities:['text','image'],supported_reasoning_levels:['low','high','xhigh','max'].map(effort=>({effort,description:'fixture'})),default_reasoning_level:'high',supported_in_api:true}}))
};}
