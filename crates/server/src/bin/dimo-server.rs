use std::{
    io::Write,
    net::SocketAddr,
    path::PathBuf,
    process::ExitCode,
    sync::Arc,
};

use server::{
    HeadlessServer, LaunchCommand, ParsedArgs, ServerBootstrapConfig, ServerConfig, ServerLaunch,
    ServerToken, format_host_console, issue_host_token, parse_args, read_host_token,
    resolve_console_token, run_agents_command, run_pairing_command, usage, write_host_token,
};
use tokio::sync::Notify;

fn main() -> ExitCode {
    let parsed = parse_args(std::env::args().skip(1));
    if let Ok(ParsedArgs::Start(ref launch)) = parsed {
        apply_launch_process_hints(launch);
    }

    // Match the desktop Host: debug command futures exceed Tokio's default stack.
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .thread_stack_size(16 * 1024 * 1024)
        .build()
        .expect("could not initialize Host runtime")
        .block_on(run_command(parsed))
}

fn apply_launch_process_hints(launch: &ServerLaunch) {
    if let Some(version) = launch
        .app_version
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        && std::env::var_os("DIMO_APP_VERSION").is_none()
    {
        // SAFETY: Called in `main()` before the Tokio runtime or any background threads spawn.
        unsafe {
            std::env::set_var("DIMO_APP_VERSION", version);
        }
    }

    if let Some(resources_dir) = launch.resources_dir.as_ref() {
        let candidate = resources_dir
            .join("scripts")
            .join("claude-native-driver.mjs");
        if candidate.is_file() {
            agents::engine::claude_events::register_claude_driver_script(candidate.clone());
            if std::env::var_os("DIMO_CLAUDE_DRIVER_SCRIPT").is_none() {
                // SAFETY: Called in `main()` before the Tokio runtime or any background threads spawn.
                unsafe {
                    std::env::set_var("DIMO_CLAUDE_DRIVER_SCRIPT", &candidate);
                }
            }
        }
    }
}

async fn run_command(parsed: Result<ParsedArgs, server::ParseError>) -> ExitCode {
    match parsed {
        Ok(ParsedArgs::Command(LaunchCommand::Version)) => {
            println!("{}", utils::version::runtime_app_version());
            ExitCode::SUCCESS
        }
        Ok(ParsedArgs::Command(LaunchCommand::Help)) => {
            print!("{}", usage());
            ExitCode::SUCCESS
        }
        Ok(ParsedArgs::Agents(command)) => run_agents_command(command).await,
        Ok(ParsedArgs::Pairing(command)) => run_pairing_command(command).await,
        Ok(ParsedArgs::Start(launch)) => run(launch).await,
        Err(error) => {
            eprintln!("{error}");
            eprint!("{}", usage());
            ExitCode::from(2)
        }
    }
}

async fn run(launch: ServerLaunch) -> ExitCode {
    if let Some(explicit) = utils::assets::renamed_env_var("DIMO_DATA_DIR") {
        let path = PathBuf::from(explicit);
        let _ = std::fs::create_dir_all(&path);
        utils::assets::use_data_dir_for_this_run(path);
    }
    let data_dir_adoptions = server::adopt_legacy_data_dir().await;
    utils::shell::bootstrap_desktop_path();
    let _log_guard = server::desktop::logging::init_logging(launch.desktop, launch.reveal_console);
    if launch.desktop {
        server::desktop::crash_reports::install_panic_hook();
    }
    for outcome in &data_dir_adoptions {
        server::log_data_dir_adoption(outcome);
    }
    let _ = std::thread::Builder::new()
        .name("acp-temp-sweep".into())
        .spawn(agents::sweep_stale_agent_runtime_temps);

    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();

    if launch.desktop {
        server::init_system_proxy().await;
    }

    let data_dir = utils::assets::host_data_dir();
    let listen_addr = match env_listen_override() {
        Some(address) if !launch.reveal_console && !launch.desktop => address,
        _ => launch.listen_addr(),
    };
    let mut server = match ServerConfig::default().with_listen_addr(listen_addr, launch.allow_lan) {
        Ok(server) => server,
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::from(2);
        }
    };
    if let Some(version) = launch.app_version.as_deref()
        && !version.trim().is_empty()
    {
        server.server_version = version.trim().to_string();
    }
    if let Some(static_root) = std::env::var_os("DIMO_STATIC_ROOT") {
        server = server.with_static_root(PathBuf::from(static_root));
    } else if let Some(sibling) = sibling_web_root() {
        server = server.with_static_root(sibling);
    }
    if let Ok(origins) = std::env::var("DIMO_SERVER_ALLOWED_ORIGINS") {
        server = server.with_allowed_origins(
            origins
                .split(',')
                .map(str::trim)
                .filter(|origin| !origin.is_empty()),
        );
    }
    if launch.desktop {
        server = server.with_desktop_mode(true);
    }

    let mut bootstrap = ServerBootstrapConfig::new(data_dir.clone());
    bootstrap.server = server;

    if launch.desktop {
        let desktop_token = match resolve_desktop_token() {
            Ok(token) => token,
            Err(error) => {
                eprintln!("invalid DIMO_DESKTOP_TOKEN: {error}");
                return ExitCode::from(2);
            }
        };
        let shutdown_notify = Arc::new(Notify::new());
        bootstrap.desktop_mode = true;
        bootstrap.desktop_token = Some(desktop_token);
        bootstrap.resources_dir = launch.resources_dir.clone();
        bootstrap.shutdown_notify = Some(Arc::clone(&shutdown_notify));

        let headless = match HeadlessServer::bootstrap(bootstrap).await {
            Ok(headless) => headless,
            Err(error) => {
                tracing::error!(%error, "failed to initialize dimo-server in desktop mode");
                return ExitCode::from(1);
            }
        };
        spawn_desktop_watchdogs(launch.parent_pid, Arc::clone(&shutdown_notify));
        let signal_shutdown = async move {
            let _ = tokio::signal::ctrl_c().await;
        };
        let ready_data_dir = data_dir.to_string_lossy().into_owned();
        let result = headless
            .serve_with_ready_and_shutdown(
                |bound_addr| {
                    let payload = serde_json::json!({
                        "type": "dimo-server-ready",
                        "listen_addr": bound_addr.to_string(),
                        "port": bound_addr.port(),
                        "pid": std::process::id(),
                        "protocol_version": remote_protocol::PROTOCOL_VERSION,
                        "data_dir": ready_data_dir,
                    });
                    let mut stdout = std::io::stdout().lock();
                    let _ = writeln!(stdout, "{payload}");
                    let _ = stdout.flush();
                },
                signal_shutdown,
            )
            .await;
        return match result {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                tracing::error!(%error, "dimo-server desktop mode stopped");
                ExitCode::from(1)
            }
        };
    }

    let supplied_token = match resolve_startup_token(&data_dir, &launch) {
        Ok(token) => token,
        Err(error) => {
            eprintln!("invalid host token: {error}");
            return ExitCode::from(2);
        }
    };
    if let Some(token) = &supplied_token
        && let Err(error) = write_host_token(&data_dir, token)
    {
        eprintln!("could not save host token: {error}");
        return ExitCode::from(2);
    }

    bootstrap.token = supplied_token.clone();

    let mut headless = match HeadlessServer::bootstrap(bootstrap).await {
        Ok(headless) => headless,
        Err(error) => {
            tracing::error!(%error, "failed to initialize dimo-server");
            return ExitCode::from(1);
        }
    };
    if let Some(token) = headless.take_issued_token() {
        if let Err(error) = write_host_token(&data_dir, &token) {
            eprintln!("could not save host token: {error}");
            return ExitCode::from(2);
        }
        if !launch.reveal_console {
            println!(
                "Dimo server token (saved for `serve`; keep it secret): {}",
                token.expose_once()
            );
        }
    }
    if launch.reveal_console {
        let saved = read_host_token(&data_dir);
        let token = supplied_token
            .as_ref()
            .or(saved.as_ref())
            .map(ServerToken::as_str)
            .unwrap_or("");
        print_console(&launch, token);
    }
    match headless.serve().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            tracing::error!(%error, "dimo-server stopped");
            ExitCode::from(1)
        }
    }
}

fn resolve_desktop_token() -> Result<ServerToken, server::ServerTokenError> {
    if let Some(value) = std::env::var("DIMO_DESKTOP_TOKEN")
        .ok()
        .filter(|token| !token.trim().is_empty())
    {
        return ServerToken::try_new(value);
    }
    Ok(issue_host_token())
}

fn spawn_desktop_watchdogs(parent_pid: Option<u32>, shutdown: Arc<Notify>) {
    if let Some(pid) = parent_pid {
        let shutdown_pid = Arc::clone(&shutdown);
        let _ = std::thread::Builder::new()
            .name("dimo-parent-watchdog".into())
            .spawn(move || {
                wait_for_parent_exit(pid);
                tracing::info!(parent_pid = pid, "parent process exited; shutting down");
                shutdown_pid.notify_one();
            });
    }
    // On Windows, a blocking ReadFile on a synchronous piped stdin holds the
    // kernel FILE_OBJECT lock indefinitely, causing any child process that
    // inherits stdin (e.g. git.exe via tokio::process::Command::output) to
    // deadlock on startup. When parent_pid is provided, wait_for_parent_exit
    // already monitors the parent via OpenProcess + WaitForSingleObject.
    #[cfg(target_os = "windows")]
    if parent_pid.is_some() {
        return;
    }

    // Also monitor stdin EOF so if Electron spawns with a piped stdin and dies
    // unexpectedly, the server shuts down promptly on every OS.
    let shutdown_stdin = shutdown;
    let _ = std::thread::Builder::new()
        .name("dimo-stdin-watchdog".into())
        .spawn(move || {
            use std::io::Read;
            let mut stdin = std::io::stdin().lock();
            let mut buf = [0u8; 64];
            loop {
                match stdin.read(&mut buf) {
                    Ok(0) => {
                        tracing::info!("desktop stdin closed; shutting down");
                        shutdown_stdin.notify_one();
                        break;
                    }
                    Ok(_) => continue,
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(error) if error.kind() == std::io::ErrorKind::BrokenPipe => {
                        tracing::info!("desktop stdin pipe broken; shutting down");
                        shutdown_stdin.notify_one();
                        break;
                    }
                    Err(error) => {
                        tracing::warn!(%error, "desktop stdin watchdog stopped");
                        break;
                    }
                }
            }
        });
}

fn wait_for_parent_exit(pid: u32) {
    utils::parent_watch::wait_for_parent_exit(pid);
}

fn resolve_startup_token(
    data_dir: &std::path::Path,
    launch: &ServerLaunch,
) -> Result<Option<ServerToken>, server::ServerTokenError> {
    if let Some(value) = std::env::var("DIMO_SERVER_TOKEN")
        .ok()
        .filter(|token| !token.trim().is_empty())
    {
        return ServerToken::try_new(value).map(Some);
    }
    if launch.reveal_console || launch.rotate_token {
        let token = resolve_console_token(data_dir, launch.rotate_token);
        return Ok(Some(token));
    }
    Ok(read_host_token(data_dir))
}

fn env_listen_override() -> Option<SocketAddr> {
    std::env::var("DIMO_SERVER_LISTEN").ok()?.parse().ok()
}

fn print_console(launch: &ServerLaunch, token: &str) {
    let mut origins = utils::net::advertised_http_origins(launch.port, launch.allow_lan);
    if launch.allow_lan
        && let Some(ip) = utils::net::public_ipv4()
    {
        let origin = format!("http://{ip}:{}", launch.port);
        if !origins.iter().any(|item| item == &origin) {
            origins.push(origin);
        }
    }
    print!("{}", format_host_console("running", token, &origins));
}

fn sibling_web_root() -> Option<PathBuf> {
    let executable = std::env::current_exe().ok()?;
    let directory = executable.parent()?;
    let web = directory.join("web");
    web.join("index.html").is_file().then_some(web)
}
