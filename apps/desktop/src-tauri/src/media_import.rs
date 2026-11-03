use crate::runtime::{Runtime, RuntimeConfig};
use std::{fs::File, path::Path, time::Duration};

fn import(
    config: RuntimeConfig,
    path: String,
    account: String,
    project: String,
) -> Result<serde_json::Value, String> {
    let path = Path::new(&path);
    let extension = path
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !matches!(extension.as_str(), "mp4" | "mov" | "webm" | "mkv") {
        return Err("invalid_media_extension".into());
    }
    let file = File::open(path).map_err(|_| "invalid_media_file")?;
    let metadata = file.metadata().map_err(|_| "invalid_media_file")?;
    if !metadata.is_file() || metadata.len() == 0 {
        return Err("invalid_media_file".into());
    }
    if metadata.len() > 2 * 1024_u64.pow(3) {
        return Err("media_too_large".into());
    }
    let filename = path
        .file_name()
        .and_then(|v| v.to_str())
        .ok_or("invalid_media_filename")?;
    let mut url = reqwest::Url::parse(&format!("{}/api/media/import", config.origin))
        .map_err(|_| "invalid_runtime")?;
    url.query_pairs_mut()
        .append_pair("accountId", &account)
        .append_pair("projectId", &project)
        .append_pair("filename", filename);
    // Stream the selected file to the existing authenticated, context-validating import API.
    // Never expose an arbitrary filesystem read or buffer multi-gigabyte videos in the webview.
    let response = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(120))
        .no_proxy()
        .build()
        .map_err(|_| "connection_failed")?
        .post(url)
        .bearer_auth(config.token)
        .header("Content-Type", "application/octet-stream")
        .body(reqwest::blocking::Body::sized(file, metadata.len()))
        .send()
        .map_err(|_| "connection_failed")?;
    let status = response.status();
    let value: serde_json::Value = response.json().map_err(|_| "operation_failed")?;
    if !status.is_success() {
        return Err(value
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("operation_failed")
            .to_owned());
    }
    Ok(value)
}

#[tauri::command]
pub async fn native_import_media(
    window: tauri::Window,
    runtime: tauri::State<'_, Runtime>,
    path: String,
    account_id: String,
    project_id: String,
) -> Result<serde_json::Value, String> {
    if window.label() != "main" {
        return Err("forbidden".into());
    }
    let config = runtime.config.clone();
    tauri::async_runtime::spawn_blocking(move || import(config, path, account_id, project_id))
        .await
        .map_err(|_| "operation_failed".to_owned())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{BufRead, BufReader, Read, Write},
        net::TcpListener,
        thread,
        time::{SystemTime, UNIX_EPOCH},
    };

    #[test]
    fn streams_file_bytes_with_encoded_name_authentication_and_exact_context() {
        let directory = std::env::temp_dir().join(format!(
            "atris-native-import-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join("video test.MP4");
        let bytes = vec![b'x'; 512 * 1024];
        std::fs::write(&path, &bytes).unwrap();
        let server = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = server.local_addr().unwrap();
        let worker = thread::spawn(move || {
            let (stream, _) = server.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(10)))
                .unwrap();
            let mut reader = BufReader::new(stream);
            let mut headers = String::new();
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" {
                    break;
                }
                headers.push_str(&line);
            }
            assert!(headers.starts_with("POST /api/media/import?accountId=account-a&projectId=project-a&filename=video+test.MP4 HTTP/1.1"));
            assert!(headers
                .to_ascii_lowercase()
                .contains("authorization: bearer controlled-local-session\r\n"));
            assert!(headers
                .to_ascii_lowercase()
                .contains("content-length: 524288\r\n"));
            let mut body = vec![0; bytes.len()];
            reader.read_exact(&mut body).unwrap();
            assert_eq!(body, bytes);
            let body = r#"{"id":"imported-artifact"}"#;
            write!(reader.get_mut(), "HTTP/1.1 201 Created\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
        });
        let config = RuntimeConfig {
            origin: format!("http://{address}"),
            token: "controlled-local-session".into(),
        };
        let result = import(
            config.clone(),
            path.to_string_lossy().into_owned(),
            "account-a".into(),
            "project-a".into(),
        )
        .unwrap();
        worker.join().unwrap();
        assert_eq!(result["id"], "imported-artifact");
        assert_eq!(
            import(
                config.clone(),
                directory.to_string_lossy().into_owned(),
                "a".into(),
                "p".into()
            )
            .unwrap_err(),
            "invalid_media_extension"
        );
        std::fs::write(&path, []).unwrap();
        assert_eq!(
            import(
                config,
                path.to_string_lossy().into_owned(),
                "a".into(),
                "p".into()
            )
            .unwrap_err(),
            "invalid_media_file"
        );
        std::fs::remove_dir_all(directory).unwrap();
    }
}
