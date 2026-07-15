//! `xpair pair-accept` pairing-accept trigger.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::Path;
use std::process::ExitCode;

use crate::config;

pub fn run(args: &[String]) -> ExitCode {
    let fingerprint = match parse_args(args) {
        Ok(fingerprint) => fingerprint,
        Err(message) => {
            eprintln!("{message}");
            return ExitCode::from(2);
        }
    };

    let host_dir = match config::default_rp_dir() {
        Ok(path) => path,
        Err(error) => {
            eprintln!("pair-accept: {error}");
            return ExitCode::from(1);
        }
    };
    let status_path = host_dir.join("pairing-status.json");
    let status = match fs::read_to_string(&status_path) {
        Ok(status) => status,
        Err(error) => {
            eprintln!("pair-accept: no pending pairing request (phase=unavailable): {error}");
            return ExitCode::from(1);
        }
    };

    let phase = scan_string_field(&status, "phase").unwrap_or_default();
    let request = request_fields(&status);
    let id = request.and_then(|request| scan_string_field(request, "id"));
    let status_fingerprint =
        request.and_then(|request| scan_string_field(request, "keyFingerprint"));

    let (id, status_fingerprint) = match (id, status_fingerprint) {
        (Some(id), Some(status_fingerprint))
            if phase == "incoming" && !id.is_empty() && !status_fingerprint.is_empty() =>
        {
            (id, status_fingerprint)
        }
        _ => {
            eprintln!("pair-accept: no pending pairing request (phase={phase})");
            return ExitCode::from(1);
        }
    };

    if let Some(fingerprint) = fingerprint.as_deref() {
        if fingerprint != status_fingerprint {
            eprintln!(
                "pair-accept: fingerprint mismatch (status={status_fingerprint}, supplied={fingerprint})"
            );
            return ExitCode::from(1);
        }
    }

    let trigger = host_dir.join("pair-accept.request");
    let payload = format!("{{\"id\":\"{id}\",\"keyFingerprint\":\"{status_fingerprint}\"}}");
    if let Err(error) = write_atomic(&trigger, payload.as_bytes()) {
        eprintln!("pair-accept: failed to write trigger: {error}");
        return ExitCode::from(1);
    }

    println!("pair-accept: wrote trigger for {id} ({status_fingerprint})");
    ExitCode::SUCCESS
}

fn parse_args(args: &[String]) -> Result<Option<String>, String> {
    match args {
        [] => Ok(None),
        [flag, fingerprint] if flag == "--fingerprint" && !fingerprint.is_empty() => {
            Ok(Some(fingerprint.clone()))
        }
        [flag, _] if flag == "--fingerprint" => {
            Err("pair-accept: --fingerprint requires a value".to_string())
        }
        [flag] if flag == "--fingerprint" => {
            Err("pair-accept: --fingerprint requires a value".to_string())
        }
        [other, ..] => Err(format!("pair-accept: unknown arg: {other}")),
    }
}

// ponytail: known-format field scan, not a general JSON parser
fn scan_string_field(text: &str, key: &str) -> Option<String> {
    let needle = format!("\"{key}\":\"");
    let value = text.split_once(&needle)?.1;
    Some(value.split_once('"')?.0.to_string())
}

fn request_fields(status: &str) -> Option<&str> {
    let request = &status[status.find("\"request\"")?..];
    let object = &request[request.find('{')? + 1..];
    Some(&object[..object.find('}')?])
}

fn write_atomic(path: &Path, contents: &[u8]) -> io::Result<()> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let temp = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name().unwrap_or_default().to_string_lossy(),
        std::process::id()
    ));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        set_mode_0600(&file)?;
        file.write_all(contents)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

#[cfg(unix)]
fn set_mode_0600(file: &File) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    file.set_permissions(fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn set_mode_0600(_file: &File) -> io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scan_string_field_reads_nested_pairing_request_fields() {
        let status = r#"{"phase":"incoming","request":{"id":"request-123","keyFingerprint":"SHA256:abc","name":"Ada"},"id":"top-level-id"}"#;
        let request = request_fields(status).unwrap();

        assert_eq!(
            scan_string_field(request, "id"),
            Some("request-123".to_string())
        );
        assert_eq!(
            scan_string_field(request, "keyFingerprint"),
            Some("SHA256:abc".to_string())
        );
        assert_eq!(scan_string_field(request, "missing"), None);
    }
}
