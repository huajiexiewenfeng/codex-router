export function workerCreationView(job){
 const status=job?.status;
 const message=status==='prepared'?'准备完成。确认创建会发送一次初始化请求，可能产生费用。':
 status==='initialized-awaiting-desktop-confirmation'?'初始化及持久化检查完成，请在 Codex 原生对话中确认可用；尚未加入团队。':
 status==='needs-reconciliation'?'创建结果需要核对。不要重复创建；先查询回执并检查已有对话。':
 status?'创建处理中或结果尚未确认。请查询进度，不要重复创建。':'选择当前网关模型，准备创建 Router 对话。';
 return {message,canStart:status==='prepared',canRefresh:!!status};
}
