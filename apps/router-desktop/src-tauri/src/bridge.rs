use std::{io::{BufRead, BufReader, Write}, path::Path, process::{Child, ChildStdin, Command, Stdio}, sync::mpsc, time::Duration};
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Host { node_path: String, script_path: String, router_config_path: String, draft_root: String }
fn bundled_paths(executable:&Path,local_data:&Path)->Result<(std::path::PathBuf,std::path::PathBuf,std::path::PathBuf),&'static str>{
 if !executable.is_absolute()||!local_data.is_absolute(){return Err("DESKTOP_HOST_CONFIG");}
 let runtime=executable.parent().ok_or("DESKTOP_HOST_CONFIG")?.join("runtime");
 Ok((runtime.join("node.exe"),runtime.join("src/desktop-stdio.mjs"),local_data.join("CodexRouterPreview/state-v1")))
}
pub struct Bridge { child: Child, stdin: ChildStdin, replies: mpsc::Receiver<Result<Value, ()>>, failed: bool }
fn request_timeout(value:&Value)->Duration{
 // Confirmed sync rechecks the source and then synchronizes the menu independently.
 if value.get("operation").and_then(Value::as_str)==Some("official-models-sync"){return Duration::from_secs(90);}
 // Local catalog discovery can take 10s plus a 15s bundled read and persistence.
 // Recovery probes are also explicit bounded maintenance, not model requests.
 if matches!(value.get("operation").and_then(Value::as_str),Some("catalog-sync"|"apply"|"official-models-prepare"|"official-models-sync"|"router-recovery-prepare"|"router-recovery-confirm")){return Duration::from_secs(60);}
 // Text verification: up to 10s DPAPI + 60s bounded stream + local persistence.
 if value.get("operation").and_then(Value::as_str)==Some("model-verify"){return Duration::from_secs(90);}
 // Readiness: credential decoding + initialize/config/model RPCs and close.
 // The billable initialization turn runs asynchronously after the start reply.
 if matches!(value.get("operation").and_then(Value::as_str),Some("worker-prepare"|"worker-start")){return Duration::from_secs(60);}
 // Router startup or Codex discovery/process checks plus DPAPI need a wider budget.
 Duration::from_secs(if matches!(value.get("operation").and_then(Value::as_str),Some("router-start"|"codex-launch")){45}else{15})
}
impl Drop for Bridge { fn drop(&mut self) { let _=self.child.kill(); let _=self.child.wait(); } }
impl Bridge {
 pub fn start() -> Result<Self, &'static str> {
  // Development host configuration is trusted local input, not renderer input.
  let (node_path,args)=if let Ok(path)=std::env::var("CODEX_ROUTER_PREVIEW_HOST"){
  if !Path::new(&path).is_absolute(){return Err("DESKTOP_HOST_CONFIG");}
  let host:Host=serde_json::from_slice(&std::fs::read(path).map_err(|_|"DESKTOP_HOST_CONFIG")?).map_err(|_|"DESKTOP_HOST_CONFIG")?;
  if [&host.node_path,&host.script_path,&host.router_config_path,&host.draft_root].iter().any(|p|!Path::new(p).is_absolute()){return Err("DESKTOP_HOST_CONFIG");}
   (host.node_path,vec![host.script_path,host.router_config_path,host.draft_root])
  }else{
   let exe=std::env::current_exe().map_err(|_|"DESKTOP_HOST_CONFIG")?;
   let local=std::env::var_os("LOCALAPPDATA").ok_or("DESKTOP_HOST_CONFIG")?;
   let (node,script,data)=bundled_paths(&exe,Path::new(&local))?;
   if !node.is_file()||!script.is_file(){return Err("DESKTOP_RUNTIME_MISSING");}
   std::fs::create_dir_all(data.parent().ok_or("DESKTOP_HOST_CONFIG")?).map_err(|_|"DESKTOP_DATA_UNAVAILABLE")?;
   (node.to_string_lossy().into_owned(),vec![script.to_string_lossy().into_owned(),"--data-root".into(),data.to_string_lossy().into_owned()])
  };
  let mut command=Command::new(node_path);
  command.env_remove("NODE_OPTIONS").env_remove("NODE_PATH");
  command.args(args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
  #[cfg(windows)] { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
  let mut child=command.spawn().map_err(|_|"DESKTOP_HOST_START")?;
  let stdin=child.stdin.take().ok_or("DESKTOP_HOST_START")?;
  let stdout=child.stdout.take().ok_or("DESKTOP_HOST_START")?;
  let (tx,rx)=mpsc::sync_channel(1);
  std::thread::spawn(move||{
   let mut reader=BufReader::new(stdout);
   loop {
    let mut line=Vec::new();
    // Bounded frame: no arbitrary unbounded readline allocation.
    let result=loop {
     let bytes=match reader.fill_buf(){Ok(v)=>v,Err(_)=>break Err(())};
     if bytes.is_empty(){break Err(());}
     let count=bytes.iter().position(|b|*b==b'\n').map(|i|i+1).unwrap_or(bytes.len());
     if line.len()+count>4*1024*1024{break Err(());}
     line.extend_from_slice(&bytes[..count]);reader.consume(count);
     if line.last()==Some(&b'\n'){break serde_json::from_slice(&line).map_err(|_|());}
    };
    let done=result.is_err();if tx.send(result).is_err()||done{break;}
   }
  });
  Ok(Self{child,stdin,replies:rx,failed:false})
 }
 pub fn request(&mut self, value:Value)->Result<Value,&'static str>{
  if self.failed{return Err("DESKTOP_HOST_DISCONNECTED");}
  let mut bytes=serde_json::to_vec(&value).map_err(|_|"DESKTOP_CONFIG_REQUEST")?;
  if bytes.len()>65536{return Err("DESKTOP_CONFIG_REQUEST");}bytes.push(b'\n');
  let result=self.stdin.write_all(&bytes).map_err(|_|()).and_then(|_|self.stdin.flush().map_err(|_|())).and_then(|_|self.replies.recv_timeout(request_timeout(&value)).map_err(|_|())).and_then(|v|v);
  result.map_err(|_|{self.failed=true;let _=self.child.kill();"DESKTOP_HOST_DISCONNECTED"})
 }
}
pub fn allowed_origin(label:&str,url:&str)->bool{
 label=="main" && (url=="http://tauri.localhost/"||url=="tauri://localhost/")
}
#[cfg(test)] mod tests {use super::*;
 #[test] fn startup_has_time_for_credential_preparation_and_service_ack(){
  assert_eq!(request_timeout(&serde_json::json!({"operation":"official-models-sync"})),Duration::from_secs(90));
  for operation in ["catalog-sync","apply","official-models-prepare","router-recovery-prepare","router-recovery-confirm"]{assert_eq!(request_timeout(&serde_json::json!({"operation":operation})),Duration::from_secs(60));}
  for operation in ["worker-prepare","worker-start"]{assert_eq!(request_timeout(&serde_json::json!({"operation":operation})),Duration::from_secs(60));}
  assert_eq!(request_timeout(&serde_json::json!({"operation":"model-verify"})),Duration::from_secs(90));
  assert_eq!(request_timeout(&serde_json::json!({"operation":"router-start"})),Duration::from_secs(45));
  assert_eq!(request_timeout(&serde_json::json!({"operation":"codex-launch"})),Duration::from_secs(45));
  for value in [serde_json::json!({"operation":"read"}),serde_json::json!({"operation":"router-stop"}),serde_json::json!({})]{assert_eq!(request_timeout(&value),Duration::from_secs(15));}
 }
 #[test] fn bundled_paths_are_host_owned(){
  let (node,script,data)=bundled_paths(Path::new("C:/app/router.exe"),Path::new("C:/user/data")).unwrap();
  assert_eq!(node,Path::new("C:/app/runtime/node.exe"));
  assert_eq!(script,Path::new("C:/app/runtime/src/desktop-stdio.mjs"));
  assert_eq!(data,Path::new("C:/user/data/CodexRouterPreview/state-v1"));
  assert!(bundled_paths(Path::new("relative.exe"),Path::new("C:/data")).is_err());
 }
 #[test] fn only_bundled_main(){assert!(allowed_origin("main","http://tauri.localhost/"));assert!(!allowed_origin("main","http://127.0.0.1:1420/"));assert!(!allowed_origin("other","http://tauri.localhost/"));assert!(!allowed_origin("main","http://tauri.localhost.evil/"));}
}
