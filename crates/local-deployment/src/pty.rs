use std::{
    collections::{HashMap, HashSet, VecDeque},
    io::{Read, Write},
    path::PathBuf,
    sync::{Arc, Mutex},
    thread,
};

#[cfg(not(windows))]
use agents::is_bash_like_posix_shell;
use agents::{
    HostTerminalSnapshot, TerminalOutputChunk, TerminalOutputRx, TerminalOutputTx,
    classify_shell_family, shell_flavor::ShellFamily,
};
use portable_pty::{CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};
use thiserror::Error;
use utils::shell::{get_interactive_shell, resolve_executable_path};
use uuid::Uuid;

fn is_usable_pty_shell(name: &str) -> bool {
    !name.is_empty() && !name.eq_ignore_ascii_case("warp")
}

async fn resolve_pty_shell(shell_override: Option<String>) -> PathBuf {
    let mut preferred = Vec::new();
    if let Some(shell) = shell_override.filter(|value| is_usable_pty_shell(value)) {
        preferred.push(shell);
    }
    if let Some(configured) = agents::configured_terminal_shell().await
        && is_usable_pty_shell(&configured)
        && !preferred.iter().any(|item| item == &configured)
    {
        preferred.push(configured);
    }
    pick_existing_pty_shell(preferred, get_interactive_shell().await).await
}

/// Pick a shell that actually exists on this Host. Missing names (for example
/// a macOS `zsh` default sent to a Linux Host) must not be spawned.
pub(crate) async fn pick_existing_pty_shell(
    preferred: Vec<String>,
    interactive: PathBuf,
) -> PathBuf {
    let mut candidates = preferred;
    let interactive_name = interactive.to_string_lossy().into_owned();
    if is_usable_pty_shell(&interactive_name) {
        candidates.push(interactive_name);
    }
    #[cfg(windows)]
    {
        candidates.extend(
            ["powershell.exe", "pwsh.exe", "cmd.exe"]
                .into_iter()
                .map(str::to_string),
        );
    }
    #[cfg(not(windows))]
    {
        candidates.extend(
            ["bash", "sh", "/bin/bash", "/bin/sh"]
                .into_iter()
                .map(str::to_string),
        );
    }

    let mut seen = HashSet::new();
    for candidate in candidates {
        if !is_usable_pty_shell(&candidate) || !seen.insert(candidate.clone()) {
            continue;
        }
        if let Some(path) = resolve_executable_path(&candidate).await {
            return path;
        }
    }
    interactive
}

fn configure_shell_command(cmd: &mut CommandBuilder, shell: &str, initial_command: Option<&str>) {
    let family = classify_shell_family(shell);

    #[cfg(windows)]
    {
        cmd.env("PYTHONUTF8", "1");
        cmd.env("PYTHONIOENCODING", "utf-8");
        match family {
            ShellFamily::Cmd => {
                if let Some(command) = initial_command {
                    cmd.env("DIMO_CMD", command);
                    cmd.args(["/D", "/S", "/C", "chcp 65001 >nul & %DIMO_CMD%"]);
                } else {
                    cmd.args(["/D", "/S", "/K", "chcp 65001 >nul"]);
                }
            }
            ShellFamily::PowerShell => {
                if let Some(command) = initial_command {
                    cmd.env("DIMO_CMD", command);
                    cmd.args([
                        "-NoLogo",
                        "-NoProfile",
                        "-Command",
                        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $ErrorActionPreference = 'Stop'; Invoke-Expression $env:DIMO_CMD",
                    ]);
                } else {
                    cmd.args([
                        "-NoLogo",
                        "-NoProfile",
                        "-NoExit",
                        "-Command",
                        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
                    ]);
                }
            }
            ShellFamily::Posix => {
                cmd.env("TERM", "xterm-256color");
                cmd.env("COLORTERM", "truecolor");
                cmd.env("TERM_PROGRAM", "dimo");
                cmd.env("LANG", "C.UTF-8");
                if let Some(command) = initial_command {
                    cmd.env("DIMO_CMD", command);
                    cmd.args(["-l", "-i", "-c", "eval \"$DIMO_CMD\""]);
                } else {
                    cmd.args(["-l", "-i"]);
                }
            }
        }
    }

    #[cfg(not(windows))]
    {
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("TERM_PROGRAM", "dimo");
        match family {
            ShellFamily::PowerShell => {
                cmd.arg("-NoLogo");
                if let Some(command) = initial_command {
                    cmd.args(["-NoProfile", "-Command", command]);
                }
            }
            ShellFamily::Cmd => {}
            ShellFamily::Posix if is_bash_like_posix_shell(shell) => {
                if let Some(command) = initial_command {
                    cmd.env("DIMO_CMD", command);
                    cmd.args(["-l", "-i", "-c", "eval \"$DIMO_CMD\""]);
                } else {
                    cmd.args(["-l", "-i"]);
                }
            }
            ShellFamily::Posix => {
                if let Some(command) = initial_command {
                    cmd.args(["-c", command]);
                }
            }
        }
    }
}

fn thread_name_prefix(terminal_id: Uuid) -> String {
    terminal_id.simple().to_string().chars().take(8).collect()
}

#[derive(Debug, Error)]
pub enum PtyError {
    #[error("Failed to create PTY: {0}")]
    CreateFailed(String),
    #[error("Session not found: {0}")]
    SessionNotFound(Uuid),
    #[error("Failed to write to PTY: {0}")]
    WriteFailed(String),
    #[error("Failed to resize PTY: {0}")]
    ResizeFailed(String),
    #[error("Session already closed")]
    SessionClosed,
}

/// Recent PTY output kept so a viewer that mounts after spawn (or remounts)
/// can redraw. Whole chunks are evicted from the front: slicing mid-escape
/// paints the replay with whatever the truncated tail happens to mean.
#[derive(Default)]
struct Scrollback {
    chunks: VecDeque<Vec<u8>>,
    bytes: usize,
    seq: u64,
}

impl Scrollback {
    fn append(&mut self, data: &[u8], max_bytes: usize) -> u64 {
        self.seq += 1;
        self.bytes = self.bytes.saturating_add(data.len());
        self.chunks.push_back(data.to_vec());
        while self.bytes > max_bytes && self.chunks.len() > 1 {
            if let Some(old) = self.chunks.pop_front() {
                self.bytes = self.bytes.saturating_sub(old.len());
            }
        }
        self.seq
    }

    fn read(&self) -> (Vec<u8>, u64) {
        let mut data = Vec::with_capacity(self.bytes);
        for chunk in &self.chunks {
            data.extend_from_slice(chunk);
        }
        (data, self.seq)
    }
}

const PTY_INPUT_CHANNEL_CAPACITY: usize = 1024;
type SharedMasterPty = Arc<Mutex<Box<dyn MasterPty + Send>>>;
type SharedPtyChild = Arc<Mutex<Box<dyn portable_pty::Child + Send>>>;

struct PtySession {
    working_dir: PathBuf,
    input_tx: tokio::sync::mpsc::Sender<Vec<u8>>,
    master: SharedMasterPty,
    child: SharedPtyChild,
    process_job: Option<utils::process::ProcessTreeJob>,
    scrollback: Arc<Mutex<Scrollback>>,
    subscribers: Arc<Mutex<Vec<TerminalOutputTx>>>,
    _input_handle: thread::JoinHandle<()>,
    closed: bool,
}

#[derive(Clone)]
pub struct PtyService {
    sessions: Arc<Mutex<HashMap<Uuid, PtySession>>>,
}

impl PtyService {
    const MAX_HISTORY_BYTES: usize = 512 * 1024;

    fn normalize_working_dir_for_shell(working_dir: PathBuf) -> PathBuf {
        #[cfg(windows)]
        {
            let raw = working_dir.to_string_lossy();
            if let Some(path) = raw.strip_prefix(r"\\?\UNC\") {
                return PathBuf::from(format!(r"\\{path}"));
            }
            if let Some(path) = raw.strip_prefix(r"\\?\") {
                return PathBuf::from(path);
            }
        }

        working_dir
    }

    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn create_session(
        &self,
        working_dir: PathBuf,
        cols: u16,
        rows: u16,
        shell_override: Option<String>,
        preset_session_id: Option<Uuid>,
        initial_command: Option<String>,
    ) -> Result<(Uuid, TerminalOutputRx), PtyError> {
        let session_id = preset_session_id.unwrap_or_else(Uuid::new_v4);
        {
            let sessions = self
                .sessions
                .lock()
                .map_err(|e| PtyError::CreateFailed(e.to_string()))?;
            if sessions.contains_key(&session_id) {
                return Err(PtyError::CreateFailed(format!(
                    "terminal id '{session_id}' already exists"
                )));
            }
        }

        let (output_tx, output_rx) = TerminalOutputTx::pair();
        let working_dir = Self::normalize_working_dir_for_shell(working_dir);
        let session_working_dir = working_dir.clone();
        let shell = resolve_pty_shell(shell_override).await;
        let scrollback = Arc::new(Mutex::new(Scrollback::default()));
        let subscribers = Arc::new(Mutex::new(vec![output_tx]));
        let history_for_thread = Arc::clone(&scrollback);
        let subscribers_for_thread = Arc::clone(&subscribers);
        let sessions_for_reader = Arc::clone(&self.sessions);
        let short_id = thread_name_prefix(session_id);

        let result = tokio::task::spawn_blocking(move || {
            let pty_system = NativePtySystem::default();

            let pty_pair = pty_system
                .openpty(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|e| PtyError::CreateFailed(e.to_string()))?;

            let mut cmd = CommandBuilder::new(&shell);
            cmd.cwd(&working_dir);
            for key in utils::process::HOST_SECRET_ENV_KEYS {
                cmd.env_remove(key);
            }
            configure_shell_command(
                &mut cmd,
                &shell.to_string_lossy(),
                initial_command.as_deref(),
            );

            let child = pty_pair
                .slave
                .spawn_command(cmd)
                .map_err(|e| PtyError::CreateFailed(e.to_string()))?;
            let child_pid = child.process_id();
            #[cfg(windows)]
            if let Some(pid) = child_pid {
                let _ = utils::process::assign_pid_to_guardian_job(pid);
            }
            let process_job = child_pid.map(utils::process::ProcessTreeJob::create_and_assign);
            drop(pty_pair.slave);

            let writer = pty_pair
                .master
                .take_writer()
                .map_err(|e| PtyError::CreateFailed(e.to_string()))?;
            let reader = pty_pair
                .master
                .try_clone_reader()
                .map_err(|e| PtyError::CreateFailed(e.to_string()))?;
            let (input_tx, input_rx) =
                tokio::sync::mpsc::channel::<Vec<u8>>(PTY_INPUT_CHANNEL_CAPACITY);

            Ok::<_, PtyError>((
                pty_pair.master,
                child,
                process_job,
                writer,
                reader,
                input_tx,
                input_rx,
            ))
        })
        .await
        .map_err(|e| PtyError::CreateFailed(e.to_string()))??;

        let (master, child, process_job, mut writer, mut reader, input_tx, mut input_rx) = result;

        let input_handle = thread::Builder::new()
            .name(format!("pty-writer-{short_id}"))
            .spawn(move || {
                while let Some(data) = input_rx.blocking_recv() {
                    if writer.write_all(&data).is_err() {
                        break;
                    }
                    while let Ok(more) = input_rx.try_recv() {
                        if writer.write_all(&more).is_err() {
                            return;
                        }
                    }
                    if writer.flush().is_err() {
                        break;
                    }
                }
            })
            .map_err(|e| PtyError::CreateFailed(e.to_string()))?;

        let session = PtySession {
            working_dir: session_working_dir,
            input_tx,
            master: Arc::new(Mutex::new(master)),
            child: Arc::new(Mutex::new(child)),
            process_job,
            scrollback,
            subscribers,
            _input_handle: input_handle,
            closed: false,
        };

        {
            let mut sessions = self
                .sessions
                .lock()
                .map_err(|e| PtyError::CreateFailed(e.to_string()))?;
            if sessions.contains_key(&session_id) {
                let child = Arc::clone(&session.child);
                let process_job = session.process_job.clone();
                tokio::task::spawn_blocking(move || {
                    if let Some(job) = process_job {
                        let _ = job.terminate();
                    }
                    if let Ok(mut child) = child.lock() {
                        let _ = child.kill();
                        let _ = child.wait();
                    }
                });
                return Err(PtyError::CreateFailed(format!(
                    "terminal id '{session_id}' already exists"
                )));
            }
            sessions.insert(session_id, session);
        }

        thread::Builder::new()
            .name(format!("pty-reader-{short_id}"))
            .spawn(move || {
                let mut buf = [0u8; 8192];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            let data = buf[..n].to_vec();
                            let seq = history_for_thread
                                .lock()
                                .map(|mut history| {
                                    history.append(&data, PtyService::MAX_HISTORY_BYTES)
                                })
                                .unwrap_or_default();
                            if let Ok(mut subscribers) = subscribers_for_thread.lock() {
                                subscribers.retain(|subscriber| {
                                    if subscriber.is_closed() {
                                        return false;
                                    }
                                    subscriber.push(TerminalOutputChunk {
                                        seq,
                                        data: data.clone(),
                                    });
                                    true
                                });
                            }
                        }
                        Err(_) => break,
                    }
                }
                let removed = sessions_for_reader
                    .lock()
                    .ok()
                    .and_then(|mut sessions| sessions.remove(&session_id));
                if let Some(mut session) = removed {
                    session.closed = true;
                    if let Ok(mut subscribers) = session.subscribers.lock() {
                        for subscriber in subscribers.drain(..) {
                            subscriber.close();
                        }
                    }
                    if let Some(job) = session.process_job.take() {
                        job.terminate();
                    }
                    if let Ok(mut child) = session.child.lock() {
                        let _ = child.kill();
                        let _ = child.wait();
                    }
                }
            })
            .map_err(|e| PtyError::CreateFailed(e.to_string()))?;

        Ok((session_id, output_rx))
    }

    pub fn snapshot(&self, session_id: Uuid) -> HostTerminalSnapshot {
        let scrollback = {
            let Ok(sessions) = self.sessions.lock() else {
                return HostTerminalSnapshot::missing();
            };
            match sessions.get(&session_id) {
                Some(session) if !session.closed => Arc::clone(&session.scrollback),
                _ => return HostTerminalSnapshot::missing(),
            }
        };
        let (data, seq) = scrollback
            .lock()
            .map(|buffer| buffer.read())
            .unwrap_or_else(|_| (Vec::new(), 0));
        HostTerminalSnapshot::from_bytes(&data, seq)
    }

    pub async fn subscribe_output(&self, session_id: Uuid) -> Result<TerminalOutputRx, PtyError> {
        let (tx, rx) = TerminalOutputTx::pair();
        let subscribers = {
            let sessions = self
                .sessions
                .lock()
                .map_err(|e| PtyError::CreateFailed(e.to_string()))?;
            let session = sessions
                .get(&session_id)
                .ok_or(PtyError::SessionNotFound(session_id))?;

            if session.closed {
                return Err(PtyError::SessionClosed);
            }

            Arc::clone(&session.subscribers)
        };

        subscribers
            .lock()
            .map_err(|e| PtyError::CreateFailed(e.to_string()))?
            .push(tx);

        Ok(rx)
    }

    pub async fn write(&self, session_id: Uuid, data: &[u8]) -> Result<(), PtyError> {
        let input_tx = {
            let sessions = self
                .sessions
                .lock()
                .map_err(|e| PtyError::WriteFailed(e.to_string()))?;
            let session = sessions
                .get(&session_id)
                .ok_or(PtyError::SessionNotFound(session_id))?;

            if session.closed {
                return Err(PtyError::SessionClosed);
            }

            session.input_tx.clone()
        };

        let payload = data.to_vec();
        match tokio::time::timeout(std::time::Duration::from_secs(2), input_tx.send(payload)).await
        {
            Ok(Ok(())) => Ok(()),
            Ok(Err(_)) => Err(PtyError::WriteFailed(
                "PTY input channel closed".to_string(),
            )),
            Err(_) => Err(PtyError::WriteFailed("PTY input buffer full".to_string())),
        }
    }

    pub async fn resize(&self, session_id: Uuid, cols: u16, rows: u16) -> Result<(), PtyError> {
        let master = {
            let sessions = self
                .sessions
                .lock()
                .map_err(|e| PtyError::ResizeFailed(e.to_string()))?;
            let session = sessions
                .get(&session_id)
                .ok_or(PtyError::SessionNotFound(session_id))?;

            if session.closed {
                return Err(PtyError::SessionClosed);
            }

            Arc::clone(&session.master)
        };

        tokio::task::spawn_blocking(move || {
            let master = master
                .lock()
                .map_err(|e| PtyError::ResizeFailed(e.to_string()))?;
            master
                .resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|e| PtyError::ResizeFailed(e.to_string()))
        })
        .await
        .map_err(|e| PtyError::ResizeFailed(e.to_string()))?
    }

    pub async fn close_session(&self, session_id: Uuid) -> Result<(), PtyError> {
        let removed = self
            .sessions
            .lock()
            .map_err(|_| PtyError::SessionClosed)?
            .remove(&session_id);
        if let Some(mut session) = removed {
            session.closed = true;
            if let Ok(mut subscribers) = session.subscribers.lock() {
                for subscriber in subscribers.drain(..) {
                    subscriber.close();
                }
            }
            let _ = tokio::task::spawn_blocking(move || {
                if let Some(job) = session.process_job.take() {
                    let _ = job.terminate();
                }
                if let Ok(mut child) = session.child.lock() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
                drop(session.master);
                drop(session.input_tx);
            })
            .await;
        }
        Ok(())
    }

    /// Kill and drain every active PTY session concurrently (used on host shutdown).
    pub async fn close_all(&self) {
        let removed: Vec<PtySession> = {
            let mut sessions = self
                .sessions
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            sessions.drain().map(|(_, session)| session).collect()
        };
        let tasks = removed.into_iter().map(|mut session| {
            session.closed = true;
            if let Ok(mut subscribers) = session.subscribers.lock() {
                for subscriber in subscribers.drain(..) {
                    subscriber.close();
                }
            }
            tokio::task::spawn_blocking(move || {
                if let Some(job) = session.process_job.take() {
                    let _ = job.terminate();
                }
                if let Ok(mut child) = session.child.lock() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
                drop(session.master);
                drop(session.input_tx);
            })
        });
        let _ = futures::future::join_all(tasks).await;
    }

    pub fn has_running_in_directory(&self, root: &std::path::Path) -> Result<bool, PtyError> {
        let root = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
        let candidates: Vec<(PathBuf, SharedPtyChild)> = {
            let sessions = self
                .sessions
                .lock()
                .map_err(|e| PtyError::CreateFailed(e.to_string()))?;
            sessions
                .values()
                .filter(|session| !session.closed)
                .map(|session| (session.working_dir.clone(), Arc::clone(&session.child)))
                .collect()
        };
        for (working_dir, child) in candidates {
            let cwd = std::fs::canonicalize(&working_dir).unwrap_or(working_dir);
            if !cwd.starts_with(&root) {
                continue;
            }
            let mut child = child
                .lock()
                .map_err(|e| PtyError::CreateFailed(e.to_string()))?;
            if child
                .try_wait()
                .map_err(|e| PtyError::CreateFailed(e.to_string()))?
                .is_none()
            {
                return Ok(true);
            }
        }
        Ok(false)
    }

    pub fn session_exists(&self, session_id: &Uuid) -> bool {
        self.sessions
            .lock()
            .map(|s| s.get(session_id).is_some_and(|session| !session.closed))
            .unwrap_or(false)
    }
}

impl Default for PtyService {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::{PtyService, Scrollback};

    #[test]
    fn normalize_working_dir_preserves_regular_windows_paths() {
        let path = PathBuf::from(r"C:\Users\Administrator\Documents\Projects");
        assert_eq!(
            PtyService::normalize_working_dir_for_shell(path.clone()),
            path
        );
    }

    #[cfg(windows)]
    #[test]
    fn normalize_working_dir_strips_extended_windows_drive_prefix() {
        let normalized =
            PtyService::normalize_working_dir_for_shell(PathBuf::from(r"\\?\C:\Users\Admin"));
        assert_eq!(normalized, PathBuf::from(r"C:\Users\Admin"));
    }

    #[cfg(windows)]
    #[test]
    fn normalize_working_dir_strips_extended_unc_prefix() {
        let normalized = PtyService::normalize_working_dir_for_shell(PathBuf::from(
            r"\\?\UNC\server\share\workspace",
        ));
        assert_eq!(normalized, PathBuf::from(r"\\server\share\workspace"));
    }

    #[test]
    fn scrollback_seq_counts_every_chunk_and_never_rewinds() {
        let mut buffer = Scrollback::default();
        assert_eq!(buffer.append(b"a", PtyService::MAX_HISTORY_BYTES), 1);
        assert_eq!(buffer.append(b"b", PtyService::MAX_HISTORY_BYTES), 2);
        let (data, seq) = buffer.read();
        assert_eq!(seq, 2);
        assert_eq!(data, b"ab");
    }

    #[test]
    fn scrollback_evicts_whole_chunks_and_keeps_counting() {
        let mut buffer = Scrollback::default();
        let chunk = vec![b'x'; PtyService::MAX_HISTORY_BYTES / 2 + 1];
        buffer.append(&chunk, PtyService::MAX_HISTORY_BYTES);
        buffer.append(&chunk, PtyService::MAX_HISTORY_BYTES);
        let seq = buffer.append(b"tail", PtyService::MAX_HISTORY_BYTES);
        let (data, read_seq) = buffer.read();
        assert_eq!(read_seq, seq);
        assert!(data.ends_with(b"tail"));
        assert!(data.len() <= PtyService::MAX_HISTORY_BYTES);
    }

    #[test]
    fn scrollback_keeps_the_last_chunk_even_when_it_alone_is_too_big() {
        let mut buffer = Scrollback::default();
        let huge = vec![b'y'; PtyService::MAX_HISTORY_BYTES * 2];
        buffer.append(&huge, PtyService::MAX_HISTORY_BYTES);
        let (data, seq) = buffer.read();
        assert_eq!(seq, 1);
        assert_eq!(data.len(), huge.len());
    }

    #[test]
    fn a_missing_terminal_reports_not_alive_rather_than_failing() {
        let service = PtyService::new();
        let snapshot = service.snapshot(uuid::Uuid::nil());
        assert!(!snapshot.alive);
        assert!(snapshot.data.is_empty());
        assert_eq!(snapshot.seq, 0);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn uses_an_existing_preferred_shell() {
        let path =
            super::pick_existing_pty_shell(vec!["/bin/sh".into()], PathBuf::from("/bin/bash"))
                .await;
        assert_eq!(path, PathBuf::from("/bin/sh"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn skips_a_missing_preferred_shell_instead_of_spawning_it() {
        let path = super::pick_existing_pty_shell(
            vec!["zsh-missing-on-this-host-xyz".into()],
            PathBuf::from("/no/such/interactive-shell"),
        )
        .await;
        assert!(
            path.is_file(),
            "expected a real shell after zsh was missing, got {}",
            path.display()
        );
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        assert!(
            name == "bash" || name == "sh",
            "unexpected fallback shell {name}"
        );
    }
}
