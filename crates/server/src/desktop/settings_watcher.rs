use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use notify::{EventKind, RecursiveMode, Watcher};

pub const SETTINGS_CHANGED_EVENT: &str = "dimo://settings-file-changed";
const EMIT_COALESCE: Duration = Duration::from_millis(100);
const POLL_INTERVAL: Duration = Duration::from_millis(250);

/// Lifecycle handle for the background settings file watcher thread.
/// Calling [`stop`] (or dropping the handle) signals the watcher thread to exit.
pub struct SettingsWatcherHandle {
    stop: Arc<AtomicBool>,
    join: Option<std::thread::JoinHandle<()>>,
}

impl SettingsWatcherHandle {
    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(handle) = self.join.take() {
            let _ = handle.join();
        }
    }
}

impl Drop for SettingsWatcherHandle {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

pub fn start(
    events: Arc<crate::HostEventBus>,
    on_change: Option<Arc<dyn Fn() + Send + Sync>>,
) -> Option<SettingsWatcherHandle> {
    let stop = Arc::new(AtomicBool::new(false));
    let thread_stop = Arc::clone(&stop);
    match std::thread::Builder::new()
        .name("dimo-settings-watcher".to_string())
        .spawn(move || {
            let settings_path = utils::assets::settings_path();
            let Some(parent) = settings_path.parent() else {
                return;
            };
            if let Err(error) = std::fs::create_dir_all(parent) {
                tracing::warn!(%error, "Failed to create settings directory for watcher");
                return;
            }

            let (sender, receiver) = std::sync::mpsc::channel();
            let mut watcher = match notify::recommended_watcher(sender) {
                Ok(watcher) => watcher,
                Err(error) => {
                    tracing::warn!(%error, "Failed to create settings file watcher");
                    return;
                }
            };
            if let Err(error) = watcher.watch(parent, RecursiveMode::NonRecursive) {
                tracing::warn!(%error, "Failed to watch settings directory");
                return;
            }

            let mut last_emit: Option<Instant> = None;
            while !thread_stop.load(Ordering::SeqCst) {
                let event = match receiver.recv_timeout(POLL_INTERVAL) {
                    Ok(Ok(event)) => event,
                    Ok(Err(_)) | Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                };
                if !matches!(
                    event.kind,
                    EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
                ) || !event.paths.iter().any(|path| path == &settings_path)
                {
                    continue;
                }
                if last_emit.is_some_and(|emitted| emitted.elapsed() < EMIT_COALESCE) {
                    continue;
                }
                last_emit = Some(Instant::now());
                if let Some(callback) = on_change.as_ref() {
                    callback();
                }
                events.emit(SETTINGS_CHANGED_EVENT, ());
            }
        }) {
        Ok(join) => Some(SettingsWatcherHandle {
            stop,
            join: Some(join),
        }),
        Err(error) => {
            tracing::warn!(%error, "Failed to start settings file watcher");
            None
        }
    }
}
