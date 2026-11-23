#[cfg(target_os = "windows")]
fn is_process_still_alive_when_sync_denied(pid: u32) -> bool {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, ERROR_ACCESS_DENIED, GetLastError, STILL_ACTIVE},
        System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
    };

    // SAFETY: Querying process liveness by PID with read-only limited-information access.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if !handle.is_null() {
            let mut exit_code: u32 = 0;
            let ok = GetExitCodeProcess(handle, &mut exit_code);
            let _ = CloseHandle(handle);
            // If GetExitCodeProcess fails, assume still alive only if access wasn't lost;
            // STILL_ACTIVE (259) means the process has not terminated.
            return ok != 0 && exit_code == STILL_ACTIVE as u32;
        }
        // Even limited query can fail with ERROR_ACCESS_DENIED for elevated/protected
        // parents while they are alive; a vanished PID returns ERROR_INVALID_PARAMETER.
        GetLastError() == ERROR_ACCESS_DENIED
    }
}

#[cfg(target_os = "windows")]
pub fn wait_for_parent_exit(pid: u32) {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, ERROR_ACCESS_DENIED, GetLastError},
        System::Threading::{INFINITE, OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject},
    };
    if pid == 0 {
        return;
    }
    // SAFETY: Waiting on a Win32 process handle opened for synchronization.
    unsafe {
        let handle = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
        if !handle.is_null() {
            let _ = WaitForSingleObject(handle, INFINITE);
            let _ = CloseHandle(handle);
            return;
        }
        let err = GetLastError();
        if err != ERROR_ACCESS_DENIED {
            return;
        }
    }

    tracing::warn!(
        pid,
        "OpenProcess(PROCESS_SYNCHRONIZE) returned ERROR_ACCESS_DENIED; falling back to periodic parent-exit polling"
    );
    loop {
        std::thread::sleep(std::time::Duration::from_millis(500));
        if !is_process_still_alive_when_sync_denied(pid) {
            return;
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

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;

    #[test]
    fn current_process_is_reported_alive_by_limited_query_helper() {
        assert!(is_process_still_alive_when_sync_denied(std::process::id()));
    }

    #[test]
    fn wait_for_parent_exit_returns_immediately_for_zero_or_missing_pid() {
        wait_for_parent_exit(0);
        // PID u32::MAX - 3 is never a valid Windows PID (PIDs are multiples of 4).
        assert!(!is_process_still_alive_when_sync_denied(u32::MAX - 3));
        wait_for_parent_exit(u32::MAX - 3);
    }
}
