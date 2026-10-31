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
    child: Mutex<Option<Child>>,
}

fn random_token() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|_| "OS random source unavailable")?;
    Ok(bytes.iter().map(|value| format!("{value:02x}")).collect())
}

fn address(origin: &str) -> Result<String, String> {
    let port = origin.strip_prefix("http://127.0.0.1:")
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
        if let Some(unc) = value.strip_prefix(r"\\?\UNC\") { return PathBuf::from(format!(r"\\{unc}")); }
        if let Some(local) = value.strip_prefix(r"\\?\") { return PathBuf::from(local); }
    }
    path
}

impl Runtime {
    pub fn launch(resources: Option<PathBuf>, data_directory: Option<PathBuf>) -> Result<Self, String> {
        let node_name = if cfg!(windows) { "node.exe" } else { "node" };
        let (node, entry) = if tauri::is_dev() {
            let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).ancestors().nth(3).ok_or("Workspace root missing")?.to_path_buf();
            (root.join("node_modules/node/bin").join(node_name), root.join("dist/services/local-api/src/entry.js"))
        } else {
            let directory = resources.ok_or("Runtime resources missing")?.join("runtime");
            (directory.join(node_name), directory.join("api.mjs"))
        };
        if !node.is_file() || !entry.is_file() {
            return Err("Local runtime missing. Run npm ci and npm run build:core before native development.".into());
        }
        let token = random_token()?;
        let mut command = Command::new(node_path(node));
        command.arg(node_path(entry))
            .env("ATRIS_SHARE_RUNTIME_TOKEN", &token)
            .env("ATRIS_SHARE_PARENT_PID", std::process::id().to_string())
            .env_remove("NODE_OPTIONS").env_remove("NODE_PATH")
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        if tauri::is_dev() {
            command.env("ATRIS_SHARE_DEV_ORIGIN", "http://127.0.0.1:1438");
        } else {
            command.env_remove("ATRIS_SHARE_DEV_ORIGIN");
        }
        if let Some(directory) = data_directory {
            command.env("ATRIS_SHARE_DATA_DIR", directory);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000); // CREATE_NO_WINDOW for the Node helper.
        }
        let mut child = command.spawn().map_err(|_| "Could not start local API")?;
        let stdout = child.stdout.take().ok_or("Runtime output unavailable")?;
        let stderr = child.stderr.take().ok_or("Runtime diagnostics unavailable")?;
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
                    if output.len() + redacted.len() > 8000 { output.clear(); }
                    output.push_str(&redacted.chars().take(2000).collect::<String>());
                    output.push('\n');
                }
            }
        });
        let result = receiver.recv_timeout(Duration::from_secs(20))
            .map_err(|_| "Local API did not become ready")
            .and_then(|result| result.map_err(|_| "Invalid local API handshake"));
        match result {
            Ok(ready) if ready.pid == child.id() && ready.version == env!("CARGO_PKG_VERSION") && address(&ready.origin).is_ok() => {
                Ok(Self { config: RuntimeConfig { origin: ready.origin, token }, child: Mutex::new(Some(child)) })
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                let detail = diagnostics.lock().map(|value| value.clone()).unwrap_or_default();
                Err(format!("Local API startup failed; check the runtime and data directory.\n{detail}"))
            }
        }
    }

    pub fn stop(&self) {
        let Ok(mut owned) = self.child.lock() else { return; };
        let Some(mut child) = owned.take() else { return; };
        if let Ok(endpoint) = address(&self.config.origin) {
            if let Ok(mut connection) = TcpStream::connect_timeout(&endpoint.parse().expect("validated loopback"), Duration::from_secs(1)) {
                let _ = connection.set_write_timeout(Some(Duration::from_secs(1)));
                let _ = write!(connection, "POST /api/internal/shutdown HTTP/1.1\r\nHost: {endpoint}\r\nAuthorization: Bearer {}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", self.config.token);
            }
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if matches!(child.try_wait(), Ok(Some(_))) { return; }
            thread::sleep(Duration::from_millis(40));
        }
        let _ = child.kill();
        let _ = child.wait();
    }
}

impl Drop for Runtime {
    fn drop(&mut self) { self.stop(); }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn native_owns_authenticated_runtime_and_reaps_it() {
        let directory = std::env::temp_dir().join(format!("atris-share-native-{}", random_token().unwrap()));
        let runtime = Runtime::launch(None, Some(directory.clone())).expect("real Node API must start");
        let endpoint = address(&runtime.config.origin).unwrap();
        let mut connection = TcpStream::connect(&endpoint).unwrap();
        connection.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        write!(connection, "GET /api/workspace HTTP/1.1\r\nHost: {endpoint}\r\nOrigin: http://127.0.0.1:1438\r\nAuthorization: Bearer {}\r\nConnection: close\r\n\r\n", runtime.config.token).unwrap();
        let mut response = String::new();
        connection.read_to_string(&mut response).unwrap();
        assert!(response.starts_with("HTTP/1.1 200"));
        assert!(response.contains("\"accounts\":[]"));
        assert!(!response.contains(&runtime.config.token));
        drop(connection);
        runtime.stop();
        assert!(TcpStream::connect(&endpoint).is_err());
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn rejects_non_loopback_and_malformed_handshakes() {
        for invalid in ["https://127.0.0.1:4", "http://localhost:4", "http://127.0.0.1:0", "http://127.0.0.1:12/path", "http://evil.test:4"] {
            assert!(address(invalid).is_err());
        }
    }

    #[test]
    #[cfg(windows)]
    fn normalizes_windows_paths_for_node_esm() {
        assert_eq!(node_path(PathBuf::from(r"\\?\C:\Apps\AtrisShare\api.mjs")), PathBuf::from(r"C:\Apps\AtrisShare\api.mjs"));
        assert_eq!(node_path(PathBuf::from(r"\\?\UNC\server\share\api.mjs")), PathBuf::from(r"\\server\share\api.mjs"));
    }
}
