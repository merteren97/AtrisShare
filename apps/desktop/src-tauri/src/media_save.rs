use crate::runtime::{Runtime, RuntimeConfig};
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::Path,
    time::Duration,
};
use tauri_plugin_dialog::DialogExt;

fn valid_id(id: &str) -> bool {
    id.len() == 36
        && id.chars().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                c == '-'
            } else {
                c.is_ascii_hexdigit()
            }
        })
}

fn save(
    config: RuntimeConfig,
    app: tauri::AppHandle,
    artifact: String,
    account: String,
    project: String,
    filename: String,
) -> Result<bool, String> {
    if !valid_id(&artifact) || !valid_id(&account) || !valid_id(&project) {
        return Err("invalid_input".into());
    }
    let filename: String = filename
        .chars()
        .filter(|c| c.is_alphanumeric() || "-_. ".contains(*c))
        .take(120)
        .collect();
    let selected = app
        .dialog()
        .file()
        .add_filter("MP4 video", &["mp4"])
        .set_file_name(if filename.is_empty() {
            "sequence.mp4"
        } else {
            &filename
        })
        .blocking_save_file();
    let Some(selected) = selected else {
        return Ok(false);
    };
    let path = selected.into_path().map_err(|_| "invalid_save_path")?;
    let mut url = reqwest::Url::parse(&format!(
        "{}/api/media/{}/download",
        config.origin, artifact
    ))
    .map_err(|_| "invalid_runtime")?;
    url.query_pairs_mut()
        .append_pair("accountId", &account)
        .append_pair("projectId", &project);
    let mut response = reqwest::blocking::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(1800))
        .build()
        .map_err(|_| "connection_failed")?
        .get(url)
        .bearer_auth(config.token)
        .send()
        .map_err(|_| "connection_failed")?;
    if !response.status().is_success() {
        return Err("media_save_failed".into());
    }
    let expected = response
        .content_length()
        .filter(|n| *n > 0 && *n <= 2 * 1024_u64.pow(3))
        .ok_or("media_size_limit")?;
    write_stream(&mut response, &path, expected)?;
    Ok(true)
}

fn write_stream(input: &mut impl Read, path: &Path, expected: u64) -> Result<(), String> {
    if expected == 0 || expected > 2 * 1024_u64.pow(3) {
        return Err("media_size_limit".into());
    }
    let mut nonce = [0u8; 16];
    getrandom::getrandom(&mut nonce).map_err(|_| "operation_failed")?;
    let temporary = path.with_file_name(format!(
        ".atris-save-{}.partial",
        nonce.iter().map(|b| format!("{b:02x}")).collect::<String>()
    ));
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|_| "media_save_failed")?;
    let result = (|| -> Result<(), String> {
        let mut buffer = [0u8; 65536];
        let mut written = 0u64;
        loop {
            let count = input.read(&mut buffer).map_err(|_| "media_save_failed")?;
            if count == 0 {
                break;
            }
            written += count as u64;
            if written > expected {
                return Err("media_size_limit".into());
            }
            output
                .write_all(&buffer[..count])
                .map_err(|_| "media_save_failed")?;
        }
        if written != expected {
            return Err("media_save_failed".into());
        }
        output.sync_all().map_err(|_| "media_save_failed")?;
        Ok(())
    })();
    drop(output);
    let result = result
        .and_then(|_| fs::rename(&temporary, path).map_err(|_| "media_save_failed".to_owned()));
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    #[test]
    fn streaming_save_replaces_only_after_complete_bytes_and_removes_failed_partials() {
        let path = std::env::temp_dir().join(format!(
            "atris-save-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&path).unwrap();
        let output = path.join("chosen.mp4");
        fs::write(&output, b"existing user file").unwrap();
        assert_eq!(
            write_stream(&mut Cursor::new(b"truncated"), &output, 100).unwrap_err(),
            "media_save_failed"
        );
        assert_eq!(fs::read(&output).unwrap(), b"existing user file");
        assert_eq!(
            write_stream(&mut Cursor::new(b"too long"), &output, 2).unwrap_err(),
            "media_size_limit"
        );
        assert_eq!(
            write_stream(&mut Cursor::new(b""), &output, 2 * 1024_u64.pow(3) + 1).unwrap_err(),
            "media_size_limit"
        );
        struct BoundedReader {
            remaining: usize,
        }
        impl Read for BoundedReader {
            fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
                assert!(buffer.len() <= 65536);
                let n = self.remaining.min(buffer.len());
                buffer[..n].fill(42);
                self.remaining -= n;
                Ok(n)
            }
        }
        let size = 1024 * 1024;
        write_stream(&mut BoundedReader { remaining: size }, &output, size as u64).unwrap();
        assert_eq!(fs::metadata(&output).unwrap().len(), size as u64);
        assert_eq!(fs::read_dir(&path).unwrap().count(), 1);
        fs::remove_dir_all(path).unwrap();
    }
    #[test]
    fn ids_cannot_inject_a_url_path_or_scope() {
        assert!(valid_id("aabbccdd-1234-4567-89ab-123456789abc"));
        for id in ["../secret", "x?token=secret", "0000/escape", ""] {
            assert!(!valid_id(id));
        }
    }
}

#[tauri::command]
pub async fn native_save_media(
    window: tauri::Window,
    app: tauri::AppHandle,
    runtime: tauri::State<'_, Runtime>,
    artifact_id: String,
    account_id: String,
    project_id: String,
    filename: String,
) -> Result<bool, String> {
    if window.label() != "main" {
        return Err("forbidden".into());
    }
    let config = runtime.config.clone();
    tauri::async_runtime::spawn_blocking(move || {
        save(config, app, artifact_id, account_id, project_id, filename)
    })
    .await
    .map_err(|_| "operation_failed".to_owned())?
}
