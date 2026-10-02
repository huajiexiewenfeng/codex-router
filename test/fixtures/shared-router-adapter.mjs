export async function createManagedRouter({grant,guardTransport,record,options}) {
  if(options?.failThreadId===grant.threadId)throw Error('fixture-private-secret');
  const send=guardTransport(async()=>{
    if(options?.transportFailure){const error=new Error('fixture-private-secret');error.cause={code:'UND_ERR_CONNECT_TIMEOUT',message:'fixture-private-secret'};throw error;}
    return new Response('fixture');
  });
  let stopped=false;
  return {port:0,stop:()=>{stopped=true;if(options?.stopFailureThreadId===grant.threadId)throw Error('fixture-private-secret');},
    close:async()=>{if(options?.closeFailureThreadId===grant.threadId)throw Error('fixture-private-secret');},
    snapshot:()=>({stopped,active:false}),handle:async(req,res)=>{
    const meta=JSON.parse(req.headers['x-codex-turn-metadata']??'null');
    if(meta?.thread_id!==grant.threadId){res.writeHead(403);res.end('binding');return;}
    try{const r=await send({signal:new AbortController().signal});record({stage:'upstream',code:'response_completed',threadId:grant.threadId,route:'company',upstreamStatus:200});res.end(await r.text());}
    catch{res.writeHead(503);res.end('denied');}
  }};
}
