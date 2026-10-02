use windows_sys::Win32::{Foundation::{CloseHandle,FILETIME,HANDLE,INVALID_HANDLE_VALUE},System::{
 Diagnostics::ToolHelp::{CreateToolhelp32Snapshot,Process32FirstW,Process32NextW,PROCESSENTRY32W,TH32CS_SNAPPROCESS},
 SystemInformation::GetWindowsDirectoryW,
 Threading::{GetCurrentProcess,GetProcessTimes,OpenProcess,QueryFullProcessImageNameW,PROCESS_QUERY_LIMITED_INFORMATION},
}};
const ERROR:&str="DESKTOP_PARENT_CHECK_FAILED";
struct OwnedHandle(HANDLE);
impl Drop for OwnedHandle{fn drop(&mut self){unsafe{CloseHandle(self.0);}}}
fn stamp(t:FILETIME)->u64{((t.dwHighDateTime as u64)<<32)|t.dwLowDateTime as u64}
fn times(handle:HANDLE)->Result<(u64,u64),&'static str>{
 let(mut created,mut exited,mut kernel,mut user)=(FILETIME::default(),FILETIME::default(),FILETIME::default(),FILETIME::default());
 if unsafe{GetProcessTimes(handle,&mut created,&mut exited,&mut kernel,&mut user)}==0{return Err(ERROR);}
 Ok((stamp(created),stamp(exited)))
}
fn verified(image:&str,windows:&str,parent_created:u64,parent_exited:u64,child_created:u64)->bool{
 let expected=format!("{}\\explorer.exe",windows.trim_end_matches('\\'));
 image.eq_ignore_ascii_case(&expected)&&parent_created>0&&parent_created<child_created&&parent_exited==0
}
// Read only the current process's direct parent. Do not trust a basename,
// environment path or a recycled PID; keep the queried parent handle open.
pub fn is_system_explorer_parent()->Result<bool,&'static str>{
 let snapshot=unsafe{CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS,0)};
 if snapshot==INVALID_HANDLE_VALUE{return Err(ERROR);}
 let snapshot=OwnedHandle(snapshot);
 let mut entry=PROCESSENTRY32W::default();entry.dwSize=std::mem::size_of::<PROCESSENTRY32W>() as u32;
 let mut found=unsafe{Process32FirstW(snapshot.0,&mut entry)}!=0;
 let mut parent_id=None;
 while found{
  if entry.th32ProcessID==std::process::id(){parent_id=Some(entry.th32ParentProcessID);break;}
  found=unsafe{Process32NextW(snapshot.0,&mut entry)}!=0;
 }
 let parent_id=parent_id.filter(|p|*p!=0).ok_or(ERROR)?;
 let parent=unsafe{OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION,0,parent_id)};
 if parent.is_null(){return Err(ERROR);}
 let parent=OwnedHandle(parent);
 let mut image=vec![0u16;32768];let mut length=image.len() as u32;
 if unsafe{QueryFullProcessImageNameW(parent.0,0,image.as_mut_ptr(),&mut length)}==0{return Err(ERROR);}
 let image=String::from_utf16(&image[..length as usize]).map_err(|_|ERROR)?;
 let mut windows=vec![0u16;32768];let length=unsafe{GetWindowsDirectoryW(windows.as_mut_ptr(),windows.len() as u32)} as usize;
 if length==0||length>=windows.len(){return Err(ERROR);}
 let windows=String::from_utf16(&windows[..length]).map_err(|_|ERROR)?;
 let (parent_created,parent_exited)=times(parent.0)?;
 let (child_created,_)=times(unsafe{GetCurrentProcess()})?;
 Ok(verified(&image,&windows,parent_created,parent_exited,child_created))
}
#[cfg(test)]
mod tests{
 use super::*;
 #[test]
 fn only_live_older_system_explorer_is_accepted(){
  assert!(verified("C:\\Windows\\explorer.exe","C:\\Windows",1,0,2));
  assert!(verified("c:\\WINDOWS\\EXPLORER.EXE","C:\\Windows",1,0,2));
  assert!(!verified("C:\\Temp\\explorer.exe","C:\\Windows",1,0,2));
  assert!(!verified("C:\\Windows\\explorer.exe","C:\\Windows",3,0,2));
  assert!(!verified("C:\\Windows\\explorer.exe","C:\\Windows",1,4,2));
  assert!(!verified("C:\\Windows\\explorer.exe","C:\\Windows",0,0,2));
 }
 #[test]
 fn cargo_or_command_parent_is_not_explorer(){assert_eq!(is_system_explorer_parent(),Ok(false));}
}
