#[cfg(target_os = "windows")]
pub fn wait_for_parent_exit(pid: u32) {
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        System::Threading::{INFINITE, OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject},
    };
    unsafe {
        let handle = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
        if !handle.is_null() {
            let _ = WaitForSingleObject(handle, INFINITE);
            let _ = CloseHandle(handle);
        }
    }
}

#[cfg(unix)]
pub fn wait_for_parent_exit(pid: u32) {
    let Ok(target_pid) = libc::pid_t::try_from(pid) else {
        return;
    };
    if target_pid <= 0 {
        return;
    }

    // Track whether `target_pid` is our direct parent so reparenting (e.g. to
    // launchd/systemd PID 1) is detected immediately even if the PID is recycled.
    let started_as_direct_parent = unsafe { libc::getppid() } == target_pid;
    loop {
        std::thread::sleep(std::time::Duration::from_millis(500));
        if started_as_direct_parent && unsafe { libc::getppid() } != target_pid {
            return;
        }
        let rc = unsafe { libc::kill(target_pid, 0) };
        if rc == 0 {
            continue;
        }
        // `EPERM` means the process still exists under another user; any other
        // error (`ESRCH`) means the parent has exited.
        let err = std::io::Error::last_os_error().raw_os_error();
        if err != Some(libc::EPERM) {
            return;
        }
    }
}

#[cfg(all(not(target_os = "windows"), not(unix)))]
pub fn wait_for_parent_exit(_pid: u32) {}

/// Terminate a single owned child process by PID (never by global image name).
pub fn terminate_owned_pid(pid: u32) {
    if pid == 0 || pid == std::process::id() {
        return;
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = std::process::Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
    #[cfg(unix)]
    {
        if let Ok(raw_pid) = libc::pid_t::try_from(pid) {
            unsafe {
                let _ = libc::kill(raw_pid, libc::SIGTERM);
            }
        }
    }
}
