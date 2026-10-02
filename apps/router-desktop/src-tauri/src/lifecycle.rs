// Check before bridge initialization: detached children can still inherit a
// host-owned Windows Job. Do not auto-break away from unknown nested Jobs.
#[cfg(windows)]
fn in_job()->Result<bool,&'static str>{
 use std::ffi::c_void;
 #[link(name="kernel32")]
 extern "system" {
  fn GetCurrentProcess()->*mut c_void;
  fn IsProcessInJob(process:*mut c_void,job:*mut c_void,result:*mut i32)->i32;
 }
 let mut value=0;
 if unsafe{IsProcessInJob(GetCurrentProcess(),std::ptr::null_mut(),&mut value)}==0{return Err("DESKTOP_JOB_CHECK_FAILED");}
 Ok(value!=0)
}
fn check_independent(in_job:bool,verified_explorer_parent:bool)->Result<(),&'static str>{
 if in_job&&!verified_explorer_parent{Err("DESKTOP_HOST_JOB_DETECTED")}else{Ok(())}
}
pub fn prepare()->Result<(),&'static str>{
 #[cfg(windows)] {
  let member=in_job()?;
  let external=if member{crate::parent_process::is_system_explorer_parent()?}else{false};
  check_independent(member,external)
 }
 #[cfg(not(windows))] {Ok(())}
}
pub fn report_failure(code:&str){
 #[cfg(windows)] {
  #[link(name="user32")]
  extern "system" {fn MessageBoxW(window:*mut std::ffi::c_void,text:*const u16,title:*const u16,kind:u32)->i32;}
  let reason=if code=="DESKTOP_HOST_JOB_DETECTED"{"检测到未核验的受管启动方式，Router 可能随宿主退出"}else{"无法确认 Router 的启动环境"};
  let text=format!("{reason}（{code}）。\n请在 Windows 文件资源管理器中直接打开 Router，再退出 Codex。\n本次未启动 Router 服务、未修改配置。若独立打开仍提示此错误，请保留现场排查。");
  let text:Vec<u16>=text.encode_utf16().chain(Some(0)).collect();
  let title:Vec<u16>="Codex Router：启动方式需要调整".encode_utf16().chain(Some(0)).collect();
  unsafe{MessageBoxW(std::ptr::null_mut(),text.as_ptr(),title.as_ptr(),0x10);}
 }
 #[cfg(not(windows))] eprintln!("{code}");
}
#[cfg(test)]
mod tests {
 use super::*;
 #[test]
 fn refuses_host_job_before_startup(){
  assert_eq!(check_independent(false,false),Ok(()));
  assert_eq!(check_independent(true,false),Err("DESKTOP_HOST_JOB_DETECTED"));
 }
 #[test]
 fn explorer_launch_is_not_rejected_just_for_job_membership(){
  assert_eq!(check_independent(true,true),Ok(()));
 }
 #[test]
 #[cfg(windows)]
 fn native_membership_check_matches_gate(){
  let member=in_job().expect("Windows must report Job membership");
  assert_eq!(prepare(),check_independent(member,false));
 }
}
