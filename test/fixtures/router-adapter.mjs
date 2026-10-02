// Offline fixture: never connects to a model endpoint or reads credentials.
import { readBudget } from '../../src/router-budget.mjs';
export async function createManagedRouter({ guardTransport, record, grant, options }) {
  let calls=0;
  const transport=guardTransport(async()=>{
    calls++;
    if(readBudget(options.budgetPath).usedRequests!==grant.usedRequests+calls)throw Error('reservation not durable');
    return new Response('fixture');
  });
  let stopped=false;
  return {
    port:0,
    handle:async(req,res)=>{
      try {
        const result=await transport({signal:new AbortController().signal});
        record({stage:'upstream',code:'response_completed',route:'company',model:'gpt-6-sol_self',upstreamModel:'gpt-6-sol',upstreamStatus:200,authorization:'Bearer secret',body:'private-prompt'});
        res.end(await result.text());
      }
      catch(error){res.writeHead(error.message==='BUDGET_EXHAUSTED'?429:503);res.end('denied');}
    },
    snapshot:()=>({stopped,active:false,lastCode:stopped?'stopped':'ready'}),
    stop:()=>{stopped=true;},
  };
}
