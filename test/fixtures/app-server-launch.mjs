import {createInterface} from 'node:readline';
const token=process.env.CODEX_ROUTER_DESKTOP_INGRESS;
for await(const line of createInterface({input:process.stdin})){
 const m=JSON.parse(line);if(m.id===undefined)continue;
 if(m.method==='fixture/fail'){
  process.stdout.write(JSON.stringify({id:m.id,error:{message:token}})+'\n');continue;
 }
 const result=m.method==='fixture/inspect'?{
  args:process.argv.slice(2),
  tokenMatches:token==='a'.repeat(64),
  hasToken:token!==undefined,
  home:process.env.CODEX_HOME,
 }:{};
 process.stdout.write(JSON.stringify({id:m.id,result})+'\n');
 if(m.method==='fixture/delayed-turn')setTimeout(()=>process.stdout.write(JSON.stringify({method:'turn/completed',params:{turn:{id:'test-turn',status:'completed'}}})+'\n'),250);
}
