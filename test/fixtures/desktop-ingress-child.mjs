import {createHash} from 'node:crypto';
const token=process.env.CODEX_ROUTER_DESKTOP_INGRESS;
console.log(JSON.stringify({validIngress:/^[a-f0-9]{64}$/.test(token??''),credentialSha256:createHash('sha256').update(token??'').digest('hex'),home:process.env.CODEX_HOME,args:process.argv.slice(2)}));
