use serde::{Deserialize, Serialize};
use std::{
    io::{BufRead, BufReader, Write},
    net::TcpStream,
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{mpsc, Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

#[derive(Clone, Serialize)]
pub struct RuntimeConfig {
    pub origin: String,
    pub token: String,
}

#[derive(Deserialize)]
struct Ready {
    origin: String,
    pid: u32,
    version: String,
}

pub struct Runtime {
    pub config: RuntimeConfig,
    owner: Mutex<Option<RuntimeOwner>>,
}

// Keep the child and its containment lifetime together, including during startup errors.
struct RuntimeOwner {
    child: Child,
    #[cfg(windows)]
    job: Option<windows_job::RuntimeJob>,
}

impl RuntimeOwner {
    fn spawn(command: &mut Command) -> Result<Self, String> {
        #[cfg(windows)]
        let job = {
            use std::os::windows::process::CommandExt;
            use windows_sys::Win32::System::Threading::{CREATE_NO_WINDOW, CREATE_SUSPENDED};

            let job = windows_job::RuntimeJob::new()
                .map_err(|error| format!("Could not contain local API: {error}"))?;
            // Do not let Node run (or spawn media children) before assignment succeeds.
            command.creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);
            job
        };
        let owner = Self {
            child: command.spawn().map_err(|_| "Could not start local API")?,
            #[cfg(windows)]
            job: Some(job),
        };
        #[cfg(windows)]
        let owner = owner.contain()?;
        Ok(owner)
    }

    #[cfg(windows)]
    fn contain(self) -> Result<Self, String> {
        self.job
            .as_ref()
            .expect("owned runtime job")
            .assign(&self.child)
            .and_then(|()| windows_job::resume(&self.child))
            .map_err(|error| format!("Could not contain/start local API: {error}"))?;
        Ok(self)
    }
}

impl Drop for RuntimeOwner {
    fn drop(&mut self) {
        // Closing the last job handle kills the entire tree, even if Node already exited.
        // On assignment failure the suspended, unassigned child is also killed and reaped.
        #[cfg(windows)]
        drop(self.job.take());
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[cfg(windows)]
mod windows_job {
    use std::{
        io,
        mem::size_of,
        os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
        process::Child,
        ptr::null,
    };
    use windows_sys::Win32::{
        Foundation::INVALID_HANDLE_VALUE,
        System::{
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD,
                THREADENTRY32,
            },
            JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
                SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            },
            Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME},
        },
    };

    pub(super) struct RuntimeJob(OwnedHandle);

    impl RuntimeJob {
        pub(super) fn new() -> io::Result<Self> {
            // Unnamed and non-inheritable: only the native owner holds this handle.
            let handle = unsafe { CreateJobObjectW(null(), null()) };
            if handle.is_null() {
                return Err(io::Error::last_os_error());
            }
            // SAFETY: CreateJobObjectW returned a new, valid handle owned by this process.
            let job = Self(unsafe { OwnedHandle::from_raw_handle(handle) });
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            // No breakaway flags: ffmpeg/ffprobe and their descendants stay in the job.
            let result = unsafe {
                SetInformationJobObject(
                    job.0.as_raw_handle(),
                    JobObjectExtendedLimitInformation,
                    (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            };
            if result == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(job)
        }

        pub(super) fn assign(&self, child: &Child) -> io::Result<()> {
            // SAFETY: both handles remain live for this call; Node is still suspended.
            if unsafe { AssignProcessToJobObject(self.0.as_raw_handle(), child.as_raw_handle()) }
                == 0
            {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        }
    }

    pub(super) fn resume(child: &Child) -> io::Result<()> {
        // std::process::Child does not retain the primary thread handle. Find that thread
        // using documented Win32 APIs; a CREATE_SUSPENDED child has not run user code yet.
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
        if snapshot == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: the snapshot is a fresh valid handle, closed on every return path.
        let snapshot = unsafe { OwnedHandle::from_raw_handle(snapshot) };
        let mut entry = THREADENTRY32 {
            dwSize: size_of::<THREADENTRY32>() as u32,
            ..Default::default()
        };
        let mut found = unsafe { Thread32First(snapshot.as_raw_handle(), &mut entry) };
        while found != 0 {
            if entry.th32OwnerProcessID == child.id() {
                let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
                if thread.is_null() {
                    return Err(io::Error::last_os_error());
                }
                // SAFETY: OpenThread returned a fresh handle to the suspended child thread.
                let thread = unsafe { OwnedHandle::from_raw_handle(thread) };
                if unsafe { ResumeThread(thread.as_raw_handle()) } == u32::MAX {
                    return Err(io::Error::last_os_error());
                }
                return Ok(());
            }
            found = unsafe { Thread32Next(snapshot.as_raw_handle(), &mut entry) };
        }
        Err(io::Error::new(
            io::ErrorKind::NotFound,
            "Runtime thread unavailable",
        ))
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use crate::runtime::RuntimeOwner;
        use std::{
            io::Read,
            os::windows::{io::AsHandle, process::CommandExt},
            path::PathBuf,
            process::{Command, Stdio},
        };
        use windows_sys::Win32::{
            Foundation::WAIT_OBJECT_0,
            System::{
                JobObjects::JOB_OBJECT_LIMIT_ACTIVE_PROCESS,
                Threading::{WaitForSingleObject, CREATE_NO_WINDOW, CREATE_SUSPENDED},
            },
        };

        #[test]
        fn rejected_assignment_kills_and_reaps_without_running_node() {
            let job = RuntimeJob::new().unwrap();
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags =
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
            limits.BasicLimitInformation.ActiveProcessLimit = 1;
            assert_ne!(
                unsafe {
                    SetInformationJobObject(
                        job.0.as_raw_handle(),
                        JobObjectExtendedLimitInformation,
                        (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                        size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                    )
                },
                0
            );
            let node = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .ancestors()
                .nth(3)
                .unwrap()
                .join("node_modules/node/bin/node.exe");
            let suspended = || {
                Command::new(&node)
                    .args(["-e", "console.log('must never execute')"])
                    .env_remove("NODE_OPTIONS")
                    .env_remove("NODE_PATH")
                    .creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED)
                    .stdin(Stdio::null())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::null())
                    .spawn()
                    .unwrap()
            };
            let occupant = RuntimeOwner {
                child: suspended(),
                job: None,
            };
            job.assign(&occupant.child).unwrap();
            let mut rejected = RuntimeOwner {
                child: suspended(),
                job: Some(job),
            };
            let process = rejected.child.as_handle().try_clone_to_owned().unwrap();
            let mut output = rejected.child.stdout.take().unwrap();
            assert!(
                rejected.contain().is_err(),
                "full job must reject assignment"
            );
            assert_eq!(
                unsafe { WaitForSingleObject(process.as_raw_handle(), 5000) },
                WAIT_OBJECT_0
            );
            let mut bytes = Vec::new();
            output.read_to_end(&mut bytes).unwrap();
            assert!(
                bytes.is_empty(),
                "uncontained Node executed before failure cleanup"
            );
            // contain consumed the owner and its Drop waited for the rejected child.
        }
    }
}

fn random_token() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|_| "OS random source unavailable")?;
    Ok(bytes.iter().map(|value| format!("{value:02x}")).collect())
}

fn address(origin: &str) -> Result<String, String> {
    let port = origin
        .strip_prefix("http://127.0.0.1:")
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|value| *value > 0)
        .ok_or("Invalid local API address")?;
    Ok(format!("127.0.0.1:{port}"))
}

// Node's ESM entry resolver must receive ordinary Windows paths, not Win32 \\?\ paths.
fn node_path(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let value = path.to_string_lossy();
        if let Some(unc) = value.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{unc}"));
        }
        if let Some(local) = value.strip_prefix(r"\\?\") {
            return PathBuf::from(local);
        }
    }
    path
}

impl Runtime {
    pub fn launch(
        resources: Option<PathBuf>,
        data_directory: Option<PathBuf>,
    ) -> Result<Self, String> {
        let node_name = if cfg!(windows) { "node.exe" } else { "node" };
        let (node, entry) = if tauri::is_dev() {
            let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .ancestors()
                .nth(3)
                .ok_or("Workspace root missing")?
                .to_path_buf();
            (
                root.join("node_modules/node/bin").join(node_name),
                root.join("dist/services/local-api/src/entry.js"),
            )
        } else {
            let directory = resources
                .ok_or("Runtime resources missing")?
                .join("runtime");
            (directory.join(node_name), directory.join("api.mjs"))
        };
        if !node.is_file() || !entry.is_file() {
            return Err("Local runtime missing. Run npm ci and npm run build:core before native development.".into());
        }
        let token = random_token()?;
        let mut command = Command::new(node_path(node));
        command
            .arg(node_path(entry))
            .env("ATRIS_SHARE_RUNTIME_TOKEN", &token)
            .env("ATRIS_SHARE_PARENT_PID", std::process::id().to_string())
            .env_remove("NODE_OPTIONS")
            .env_remove("NODE_PATH")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if tauri::is_dev() {
            command.env("ATRIS_SHARE_DEV_ORIGIN", "http://127.0.0.1:1438");
        } else {
            command.env_remove("ATRIS_SHARE_DEV_ORIGIN");
        }
        if let Some(directory) = data_directory {
            command.env("ATRIS_SHARE_DATA_DIR", directory);
        }
        let mut owner = RuntimeOwner::spawn(&mut command)?;
        let stdout = owner
            .child
            .stdout
            .take()
            .ok_or("Runtime output unavailable")?;
        let stderr = owner
            .child
            .stderr
            .take()
            .ok_or("Runtime diagnostics unavailable")?;
        let (sender, receiver) = mpsc::channel();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Some(payload) = line.strip_prefix("ATRIS_SHARE_READY ") {
                    let _ = sender.send(serde_json::from_str::<Ready>(payload));
                }
            }
        });
        // Keep bounded startup diagnostics in memory, with the session key removed.
        let diagnostics = Arc::new(Mutex::new(String::new()));
        let output_diagnostics = diagnostics.clone();
        let secret = token.clone();
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                let redacted = line.replace(&secret, "[REDACTED]");
                if let Ok(mut output) = output_diagnostics.lock() {
                    if output.len() + redacted.len() > 8000 {
                        output.clear();
                    }
                    output.push_str(&redacted.chars().take(2000).collect::<String>());
                    output.push('\n');
                }
            }
        });
        let result = receiver
            .recv_timeout(Duration::from_secs(20))
            .map_err(|_| "Local API did not become ready")
            .and_then(|result| result.map_err(|_| "Invalid local API handshake"));
        match result {
            Ok(ready)
                if ready.pid == owner.child.id()
                    && ready.version == env!("CARGO_PKG_VERSION")
                    && address(&ready.origin).is_ok() =>
            {
                Ok(Self {
                    config: RuntimeConfig {
                        origin: ready.origin,
                        token,
                    },
                    owner: Mutex::new(Some(owner)),
                })
            }
            _ => {
                drop(owner);
                let detail = diagnostics
                    .lock()
                    .map(|value| value.clone())
                    .unwrap_or_default();
                Err(format!(
                    "Local API startup failed; check the runtime and data directory.\n{detail}"
                ))
            }
        }
    }

    pub fn stop(&self) {
        // Take ownership under one short lock. Never hold it during network I/O or waits.
        let owner = self
            .owner
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take();
        let Some(mut owner) = owner else {
            return;
        };
        if let Ok(endpoint) = address(&self.config.origin) {
            if let Ok(mut connection) = TcpStream::connect_timeout(
                &endpoint.parse().expect("validated loopback"),
                Duration::from_secs(1),
            ) {
                let _ = connection.set_write_timeout(Some(Duration::from_secs(1)));
                let _ = write!(connection, "POST /api/internal/shutdown HTTP/1.1\r\nHost: {endpoint}\r\nAuthorization: Bearer {}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", self.config.token);
            }
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if matches!(owner.child.try_wait(), Ok(Some(_))) {
                return;
            }
            thread::sleep(Duration::from_millis(40));
        }
        // RuntimeOwner's fallback closes the job, then kills/reaps Node.
    }
}

impl Drop for Runtime {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn native_owns_authenticated_runtime_and_reaps_it() {
        let directory =
            std::env::temp_dir().join(format!("atris-share-native-{}", random_token().unwrap()));
        let runtime =
            Runtime::launch(None, Some(directory.clone())).expect("real Node API must start");
        let endpoint = address(&runtime.config.origin).unwrap();
        let mut connection = TcpStream::connect(&endpoint).unwrap();
        connection
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        write!(connection, "GET /api/workspace HTTP/1.1\r\nHost: {endpoint}\r\nOrigin: http://127.0.0.1:1438\r\nAuthorization: Bearer {}\r\nConnection: close\r\n\r\n", runtime.config.token).unwrap();
        let mut response = String::new();
        connection.read_to_string(&mut response).unwrap();
        assert!(response.starts_with("HTTP/1.1 200"));
        assert!(response.contains("\"accounts\":[]"));
        assert!(!response.contains(&runtime.config.token));
        drop(connection);
        #[cfg(windows)]
        let process = {
            use std::os::windows::io::AsHandle;
            runtime
                .owner
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .child
                .as_handle()
                .try_clone_to_owned()
                .unwrap()
        };
        runtime.stop();
        runtime.stop(); // Exit events and Drop may both request shutdown.
        #[cfg(windows)]
        windows::assert_exited(&process, Some(0)); // The authenticated graceful path won.
        assert!(TcpStream::connect(&endpoint).is_err());
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn rejects_non_loopback_and_malformed_handshakes() {
        for invalid in [
            "https://127.0.0.1:4",
            "http://localhost:4",
            "http://127.0.0.1:0",
            "http://127.0.0.1:12/path",
            "http://evil.test:4",
        ] {
            assert!(address(invalid).is_err());
        }
    }

    #[test]
    #[cfg(windows)]
    fn normalizes_windows_paths_for_node_esm() {
        assert_eq!(
            node_path(PathBuf::from(r"\\?\C:\Apps\AtrisShare\api.mjs")),
            PathBuf::from(r"C:\Apps\AtrisShare\api.mjs")
        );
        assert_eq!(
            node_path(PathBuf::from(r"\\?\UNC\server\share\api.mjs")),
            PathBuf::from(r"\\server\share\api.mjs")
        );
    }

    #[cfg(windows)]
    mod windows {
        use super::*;
        use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
        use windows_sys::Win32::{
            Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT},
            System::Threading::{
                GetExitCodeProcess, OpenProcess, WaitForSingleObject,
                PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
            },
        };

        const TREE_PREFIX: &str = "ATRIS_SHARE_TEST_TREE ";

        fn tree_command() -> Command {
            let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .ancestors()
                .nth(3)
                .unwrap()
                .to_path_buf();
            let mut command = Command::new(root.join("node_modules/node/bin/node.exe"));
            // Use real Node children/grandchildren, including a detached media-like process.
            let descendant = r#"
                const { spawn } = require('node:child_process');
                const leaf = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
                    { stdio: 'ignore', detached: true });
                console.log('ATRIS_SHARE_TEST_TREE ' + JSON.stringify([process.ppid, process.pid, leaf.pid]));
                if (process.env.ATRIS_SHARE_TEST_DIAGNOSTICS === '1') {
                    // A real runtime may emit diagnostics after its readiness handshake.
                    setImmediate(() => process.stdout.write('runtime diagnostic '.repeat(65536) + '\n'));
                }
                setInterval(() => {}, 1000);
            "#;
            command
                .arg("-e")
                .arg(format!(
                    r#"
                const {{ spawn }} = require('node:child_process');
                spawn(process.execPath, ['-e', {}], {{ stdio: ['ignore', 'inherit', 'inherit'] }});
                setInterval(() => {{}}, 1000);
            "#,
                    serde_json::to_string(descendant).unwrap()
                ))
                .env_remove("NODE_OPTIONS")
                .env_remove("NODE_PATH")
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit());
            command
        }

        fn read_tree(output: impl Read + Send + 'static) -> ([u32; 3], Vec<OwnedHandle>) {
            let (sender, receiver) = mpsc::channel();
            thread::spawn(move || {
                let mut readiness = Some(sender);
                for line in BufReader::new(output).lines().map_while(Result::ok) {
                    if let Some(payload) = line.strip_prefix(TREE_PREFIX) {
                        if let Some(sender) = readiness.take() {
                            let _ = sender.send(serde_json::from_str::<[u32; 3]>(payload));
                        }
                    }
                    // Continue draining until EOF. Node pipe writes are asynchronous on
                    // Windows: dropping the reader after readiness can cause EPIPE and
                    // terminate a descendant before we test the job's kill-on-close.
                }
            });
            let pids = receiver
                .recv_timeout(Duration::from_secs(10))
                .expect("contained Node tree must start")
                .unwrap();
            let handles = pids
                .iter()
                .map(|pid| {
                    let handle = unsafe {
                        OpenProcess(
                            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                            0,
                            *pid,
                        )
                    };
                    assert!(!handle.is_null(), "tree process {pid} must be alive");
                    // SAFETY: OpenProcess returned a new, valid process handle.
                    unsafe { OwnedHandle::from_raw_handle(handle) }
                })
                .collect();
            (pids, handles)
        }

        pub(super) fn assert_exited(process: &OwnedHandle, expected_code: Option<u32>) {
            assert_eq!(
                unsafe { WaitForSingleObject(process.as_raw_handle(), 5000) },
                WAIT_OBJECT_0,
                "owned runtime process survived shutdown"
            );
            if let Some(expected_code) = expected_code {
                let mut code = 0;
                assert_ne!(
                    unsafe { GetExitCodeProcess(process.as_raw_handle(), &mut code) },
                    0
                );
                assert_eq!(code, expected_code);
            }
        }

        #[test]
        fn tree_diagnostics_do_not_terminate_descendants_after_readiness() {
            let mut command = tree_command();
            command.env("ATRIS_SHARE_TEST_DIAGNOSTICS", "1");
            let mut owner = RuntimeOwner::spawn(&mut command).unwrap();
            let (pids, processes) = read_tree(owner.child.stdout.take().unwrap());
            // Closing the reader after the first line can raise EPIPE in the writer.
            // Keep the owner/job open while the descendant flushes a pipe-sized burst.
            assert_eq!(
                unsafe { WaitForSingleObject(processes[1].as_raw_handle(), 1000) },
                WAIT_TIMEOUT,
                "diagnostic writer {} exited while the native owner/job was still alive",
                pids[1]
            );
            drop(owner);
            for process in &processes {
                assert_exited(process, None);
            }
        }

        #[test]
        fn job_closes_descendants_even_after_node_exits() {
            let mut owner = RuntimeOwner::spawn(&mut tree_command()).unwrap();
            let (pids, processes) = read_tree(owner.child.stdout.take().unwrap());
            assert_eq!(pids[0], owner.child.id());
            owner.child.kill().unwrap();
            owner.child.wait().unwrap();
            for (pid, process) in pids[1..].iter().zip(&processes[1..]) {
                assert_eq!(
                    unsafe { WaitForSingleObject(process.as_raw_handle(), 0) },
                    WAIT_TIMEOUT,
                    "descendant {pid} exited before the job was closed"
                );
            }
            drop(owner);
            for process in &processes {
                assert_exited(process, None);
            }
        }

        #[test]
        fn forced_shutdown_releases_mutex_and_kills_tree() {
            let mut owner = RuntimeOwner::spawn(&mut tree_command()).unwrap();
            let (_, processes) = read_tree(owner.child.stdout.take().unwrap());
            let runtime = Arc::new(Runtime {
                config: RuntimeConfig {
                    origin: String::new(),
                    token: String::new(),
                },
                owner: Mutex::new(Some(owner)),
            });
            let stopping_runtime = runtime.clone();
            let stopping = thread::spawn(move || stopping_runtime.stop());
            let deadline = Instant::now() + Duration::from_secs(2);
            loop {
                if runtime.owner.try_lock().is_ok_and(|owner| owner.is_none()) {
                    break;
                }
                assert!(
                    Instant::now() < deadline,
                    "shutdown held the ownership mutex"
                );
                thread::sleep(Duration::from_millis(10));
            }
            let started = Instant::now();
            runtime.stop();
            assert!(started.elapsed() < Duration::from_millis(500));
            stopping.join().unwrap();
            for process in &processes {
                assert_exited(process, None);
            }
        }

        // Run only in a subprocess: the parent deliberately terminates this native owner
        // without Rust destructors, proving kernel kill-on-close rather than Drop cleanup.
        #[test]
        #[ignore = "subprocess fixture for job_kills_tree_when_native_owner_is_terminated"]
        fn crash_owner_fixture() {
            assert_eq!(
                std::env::var("ATRIS_SHARE_JOB_CRASH_FIXTURE").as_deref(),
                Ok("1")
            );
            let mut owner = RuntimeOwner::spawn(&mut tree_command()).unwrap();
            let (pids, _processes) = read_tree(owner.child.stdout.take().unwrap());
            println!("{TREE_PREFIX}{}", serde_json::to_string(&pids).unwrap());
            std::io::stdout().flush().unwrap();
            loop {
                thread::park();
            }
        }

        #[test]
        fn job_kills_tree_when_native_owner_is_terminated() {
            // This guard only kills/reaps the fixture itself; it deliberately has no job.
            struct Fixture(Child);
            impl Drop for Fixture {
                fn drop(&mut self) {
                    let _ = self.0.kill();
                    let _ = self.0.wait();
                }
            }
            let mut fixture = Fixture(
                Command::new(std::env::current_exe().unwrap())
                    .args([
                        "--exact",
                        "runtime::tests::windows::crash_owner_fixture",
                        "--ignored",
                        "--nocapture",
                    ])
                    .env("ATRIS_SHARE_JOB_CRASH_FIXTURE", "1")
                    .stdin(Stdio::null())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::inherit())
                    .spawn()
                    .unwrap(),
            );
            let (_, processes) = read_tree(fixture.0.stdout.take().unwrap());
            fixture.0.kill().unwrap();
            fixture.0.wait().unwrap();
            for process in &processes {
                assert_exited(process, None);
            }
        }
    }
}
