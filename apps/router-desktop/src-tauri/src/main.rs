#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]
mod bridge;
mod lifecycle;
#[cfg(windows)]
mod parent_process;
use std::sync::{Arc,Mutex};
type HostState=Arc<Mutex<Result<bridge::Bridge,&'static str>>>;
#[tauri::command]
async fn desktop_request(window:tauri::WebviewWindow,state:tauri::State<'_,HostState>,request:serde_json::Value)->Result<serde_json::Value,String>{
 let url=window.url().map_err(|_|"DESKTOP_ORIGIN")?;
 if !bridge::allowed_origin(window.label(),url.as_str()){return Err("DESKTOP_ORIGIN".into());}
 let shared=state.inner().clone();
 tauri::async_runtime::spawn_blocking(move||{
  let mut state=shared.lock().map_err(|_|"DESKTOP_HOST_DISCONNECTED")?;
  match state.as_mut(){Ok(host)=>host.request(request),Err(code)=>Err(*code)}
 }).await.map_err(|_|"DESKTOP_HOST_DISCONNECTED".to_string())?.map_err(str::to_string)
}
fn main() {
 if let Err(code)=lifecycle::prepare(){lifecycle::report_failure(code);return;}
 let state:HostState=Arc::new(Mutex::new(bridge::Bridge::start()));
 let shutdown=state.clone();
 tauri::Builder::default().manage(state).invoke_handler(tauri::generate_handler![desktop_request])
 .build(tauri::generate_context!()).expect("failed to build desktop UI")
 .run(move|_,event|{if matches!(event,tauri::RunEvent::Exit){
  if let Ok(mut host)=shutdown.lock(){*host=Err("DESKTOP_HOST_DISCONNECTED");}
 }});
}
