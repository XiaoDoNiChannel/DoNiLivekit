//! Windows cannot overwrite a running executable. A temporary copy of this app
//! waits for the original process, replaces its file and starts the new version.
//! No shell commands or installer are involved; the helper checks the signature
//! again before touching the installed executable.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{self, Write},
    path::{Component, Path, PathBuf},
    process::Command,
    thread,
    time::{Duration, Instant},
};

const APPLY: &str = "--donichannel-apply-update";
const CLEANUP: &str = "--donichannel-update-cleanup";
const PREFIX: &str = ".donichannel-update-";
const CONFIG: &str = include_str!("../tauri.conf.json");

#[derive(Serialize, Deserialize)]
struct Job {
    target_name: String,
    parent_pid: u32,
    signature: String,
}

fn single_name(name: &str) -> bool {
    let mut components = Path::new(name).components();
    matches!(components.next(), Some(Component::Normal(_)))
        && components.next().is_none()
        && !name.contains(['/', '\\', ':'])
}

fn verify(bytes: &[u8], signature: &str) -> Result<(), String> {
    let config: serde_json::Value = serde_json::from_str(CONFIG).map_err(|e| e.to_string())?;
    let key = config["plugins"]["updater"]["pubkey"]
        .as_str()
        .ok_or("缺少更新公钥")?;
    verify_with_key(bytes, signature, key)
}

fn verify_with_key(bytes: &[u8], signature: &str, key: &str) -> Result<(), String> {
    let decode = |text: &str| -> Result<String, String> {
        String::from_utf8(STANDARD.decode(text.trim()).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())
    };
    let key = minisign_verify::PublicKey::decode(&decode(key)?).map_err(|e| e.to_string())?;
    let signature =
        minisign_verify::Signature::decode(&decode(signature)?).map_err(|e| e.to_string())?;
    key.verify(bytes, &signature, true)
        .map_err(|e| e.to_string())
}

fn validate_exe(bytes: &[u8]) -> Result<(), String> {
    // Reject a JSON/HTML response or a non-x64 executable before shutting down.
    if bytes.get(..2) != Some(b"MZ") {
        return Err("下载文件不是 Windows EXE".into());
    }
    let offset = bytes.get(0x3c..0x40).ok_or("EXE 文件头不完整")?;
    let pe = u32::from_le_bytes(offset.try_into().unwrap()) as usize;
    let header = pe.checked_add(6).and_then(|end| bytes.get(pe..end));
    if header != Some(&b"PE\0\0\x64\x86"[..]) {
        return Err("下载文件不是 Windows x64 EXE".into());
    }
    Ok(())
}

fn write_synced(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

/// Called only with the bytes returned by Tauri's signature-verifying download.
pub(crate) fn prepare(bytes: Vec<u8>, signature: String) -> Result<(), String> {
    validate_exe(&bytes)?;
    verify(&bytes, &signature)?;
    let target = std::env::current_exe()
        .and_then(fs::canonicalize)
        .map_err(|e| e.to_string())?;
    let parent = target.parent().ok_or("无法确定程序目录")?;
    let target_name = target
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("程序文件名无效")?;
    let stage = tempfile::Builder::new().prefix(PREFIX).tempdir_in(parent).map_err(|e| {
        format!("程序目录不可写，请将 EXE 移到自己的文件夹后重试（不要放在 Program Files 或只读目录）：{e}")
    })?;
    let job = Job {
        target_name: target_name.into(),
        parent_pid: std::process::id(),
        signature,
    };
    write_synced(&stage.path().join("next.exe"), &bytes).map_err(|e| e.to_string())?;
    write_synced(
        &stage.path().join("job.json"),
        &serde_json::to_vec(&job).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let helper = stage.path().join("helper.exe");
    fs::copy(&target, &helper).map_err(|e| format!("创建更新助手失败：{e}"))?;
    let mut child = Command::new(helper)
        .arg(APPLY)
        .spawn()
        .map_err(|e| format!("启动更新助手失败：{e}"))?;
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        if stage.path().join("ready").is_file() {
            // The helper owns cleanup from here. Keep the old app alive until it
            // has opened a real process handle and verified the staged bytes.
            let _ = stage.keep();
            return Ok(());
        }
        if child.try_wait().map_err(|e| e.to_string())?.is_some() {
            let details = fs::read_to_string(stage.path().join("error.txt")).unwrap_or_default();
            return Err(format!("更新助手未就绪，当前程序未被修改：{details}"));
        }
        thread::sleep(Duration::from_millis(100));
    }
    let _ = child.kill();
    let _ = child.wait();
    Err("更新助手启动超时，当前程序未被修改，请重试或从群文件下载 EXE".into())
}

fn target_for(stage: &Path, job: &Job) -> Result<PathBuf, String> {
    if !single_name(&job.target_name) || !job.target_name.to_ascii_lowercase().ends_with(".exe") {
        return Err("更新目标文件名无效".into());
    }
    if !stage
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.starts_with(PREFIX))
    {
        return Err("更新临时目录无效".into());
    }
    let target = stage
        .parent()
        .ok_or("更新目录没有父目录")?
        .join(&job.target_name);
    if fs::symlink_metadata(&target)
        .map_err(|e| e.to_string())?
        .file_type()
        .is_symlink()
    {
        return Err("不支持替换符号链接，请直接运行原始 EXE".into());
    }
    Ok(target)
}

fn replace_and_launch(
    stage: &Path,
    target: &Path,
    launch: impl FnOnce() -> io::Result<()>,
) -> io::Result<()> {
    let backup = stage.join("previous.exe");
    if backup.exists() {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "previous.exe already exists; preserving recovery copy",
        ));
    }
    // Rename on the same volume keeps a complete old binary for rollback.
    fs::rename(target, &backup)?;
    if let Err(error) = fs::rename(stage.join("next.exe"), target) {
        fs::rename(&backup, target)?;
        return Err(error);
    }
    if let Err(error) = launch() {
        fs::rename(target, stage.join("next.exe"))?;
        fs::rename(&backup, target)?;
        return Err(error);
    }
    Ok(())
}

#[cfg(windows)]
fn apply(stage: &Path) -> Result<(), String> {
    use windows::Win32::{
        Foundation::{CloseHandle, WAIT_OBJECT_0},
        System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE},
    };
    let job: Job =
        serde_json::from_slice(&fs::read(stage.join("job.json")).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    let target = target_for(stage, &job)?;
    let bytes = fs::read(stage.join("next.exe")).map_err(|e| e.to_string())?;
    validate_exe(&bytes)?;
    verify(&bytes, &job.signature)?;
    let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, job.parent_pid) }
        .map_err(|e| e.to_string())?;
    let ready = write_synced(&stage.join("ready"), b"ready");
    if let Err(error) = ready {
        unsafe {
            let _ = CloseHandle(handle);
        }
        return Err(error.to_string());
    }
    let waited = unsafe { WaitForSingleObject(handle, 60_000) };
    unsafe {
        let _ = CloseHandle(handle);
    }
    if waited != WAIT_OBJECT_0 {
        return Err("等待原程序退出超时，EXE 未被替换".into());
    }
    // Give scanners a brief chance to release the old image, without ever
    // deleting it. A persistent lock leaves the original file intact.
    let deadline = Instant::now() + Duration::from_secs(5);
    let result = loop {
        let result = replace_and_launch(stage, &target, || {
            Command::new(&target)
                .arg(CLEANUP)
                .arg(stage.file_name().unwrap())
                .current_dir(target.parent().unwrap())
                .spawn()
                .map(|_| ())
        });
        match result {
            Err(ref e)
                if e.kind() == io::ErrorKind::PermissionDenied && Instant::now() < deadline =>
            {
                thread::sleep(Duration::from_millis(250));
            }
            result => break result,
        }
    };
    if let Err(error) = result {
        // On failure the previous binary is restored when possible. Keep the
        // backup and error log for recovery instead of removing either version.
        if target.exists() && !stage.join("previous.exe").exists() {
            let _ = Command::new(&target)
                .current_dir(target.parent().unwrap())
                .spawn();
        }
        return Err(format!(
            "替换或启动失败：{error}。旧程序备份（如有）位于 {}",
            stage.display()
        ));
    }
    Ok(())
}

// Only delete known update files in a validated adjacent directory. Never
// recursively remove a caller-supplied directory or follow directory links.
fn cleanup(stage: &Path) {
    if fs::symlink_metadata(stage)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(true)
    {
        return;
    }
    for _ in 0..30 {
        for name in ["helper.exe", "previous.exe", "job.json", "ready"] {
            let _ = fs::remove_file(stage.join(name));
        }
        if fs::remove_dir(stage).is_ok() {
            return;
        }
        thread::sleep(Duration::from_millis(200));
    }
}

pub(crate) fn handle_startup() -> bool {
    let mut args = std::env::args_os().skip(1);
    let Some(mode) = args.next() else {
        return false;
    };
    if mode == APPLY {
        #[cfg(windows)]
        if let Ok(exe) = std::env::current_exe().and_then(fs::canonicalize) {
            if let Some(stage) = exe.parent() {
                if let Err(error) = apply(stage) {
                    let _ = fs::write(stage.join("error.txt"), &error);
                    // Before readiness the live app displays the error itself.
                    if stage.join("ready").exists() {
                        use windows::{
                            core::HSTRING,
                            Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK},
                        };
                        unsafe {
                            MessageBoxW(
                                None,
                                &HSTRING::from(error),
                                &HSTRING::from("DoNiChannel 更新失败"),
                                MB_OK | MB_ICONERROR,
                            );
                        }
                    }
                }
            }
        }
        return true;
    }
    if mode == CLEANUP {
        if let (Some(name), Ok(exe)) = (
            args.next(),
            std::env::current_exe().and_then(fs::canonicalize),
        ) {
            if let Some(name) = name
                .to_str()
                .filter(|n| single_name(n) && n.starts_with(PREFIX))
            {
                if let Some(parent) = exe.parent() {
                    let stage = parent.join(name);
                    thread::spawn(move || cleanup(&stage));
                }
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signature_verification_accepts_original_and_rejects_tampering_or_wrong_key() {
        // Public test vector from minisign-verify 0.2.5 (MIT licensed).
        let key = STANDARD.encode("untrusted comment: minisign public key E7620F1842B4E81F\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3");
        let signature = STANDARD.encode(concat!(
            "untrusted comment: signature from minisign secret key\n",
            "RWQf6LRCGA9i59SLOFxz6NxvASXDJeRtuZykwQepbDEGt87ig1BNpWaVWuNrm73YiIiJbq71Wi+dP9eKL8OC351vwIasSSbXxwA=\n",
            "trusted comment: timestamp:1555779966\tfile:test\n",
            "QtKMXWyYcwdpZAlPF7tE2ENJkRd1ujvKjlj1m9RtHTBnZPa5WKU5uWRs5GoP5M/VqE81QFuMKI5k/SfNQUaOAA=="
        ));
        assert!(verify_with_key(b"test", &signature, &key).is_ok());
        assert!(verify_with_key(b"Test", &signature, &key).is_err());
        assert!(verify(b"test", &signature).is_err());
    }

    #[test]
    #[cfg(windows)]
    fn locked_executable_is_left_intact() {
        use std::os::windows::fs::OpenOptionsExt;
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("豆泥 客户端.exe");
        fs::write(&target, b"old").unwrap();
        fs::write(dir.path().join("next.exe"), b"new").unwrap();
        let lock = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&target)
            .unwrap();
        assert!(replace_and_launch(dir.path(), &target, || panic!("must not launch")).is_err());
        drop(lock);
        assert_eq!(fs::read(&target).unwrap(), b"old");
        assert_eq!(fs::read(dir.path().join("next.exe")).unwrap(), b"new");
        assert!(!dir.path().join("previous.exe").exists());
    }

    #[test]
    fn recovery_copy_is_never_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("app.exe");
        fs::write(&target, b"current").unwrap();
        fs::write(dir.path().join("previous.exe"), b"recovery").unwrap();
        fs::write(dir.path().join("next.exe"), b"new").unwrap();
        assert!(replace_and_launch(dir.path(), &target, || panic!("must not launch")).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"current");
        assert_eq!(
            fs::read(dir.path().join("previous.exe")).unwrap(),
            b"recovery"
        );
    }

    #[test]
    fn target_names_cannot_escape_the_program_directory() {
        for name in [
            "../app.exe",
            "..\\app.exe",
            "C:\\app.exe",
            "app.exe:stream",
            "",
            ".",
        ] {
            assert!(!single_name(name), "{name}");
        }
        assert!(single_name("豆泥 便携版.exe"));
    }

    #[test]
    fn bad_downloads_and_signatures_are_rejected() {
        assert!(validate_exe(b"{\"url\":\"asset\"}").is_err());
        assert!(verify(b"untrusted", "not a signature").is_err());
        let mut image = vec![0u8; 256];
        image[..2].copy_from_slice(b"MZ");
        image[0x3c..0x40].copy_from_slice(&128u32.to_le_bytes());
        image[128..134].copy_from_slice(b"PE\0\0\x64\x86");
        assert!(validate_exe(&image).is_ok());
        image[132] = 0;
        assert!(validate_exe(&image).is_err());
    }

    #[test]
    fn successful_swap_retains_a_recoverable_old_binary() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("app.exe");
        fs::write(&target, b"old").unwrap();
        fs::write(dir.path().join("next.exe"), b"new").unwrap();
        replace_and_launch(dir.path(), &target, || Ok(())).unwrap();
        assert_eq!(fs::read(target).unwrap(), b"new");
        assert_eq!(fs::read(dir.path().join("previous.exe")).unwrap(), b"old");
    }

    #[test]
    fn failed_replacement_or_restart_restores_the_original() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("app.exe");
        fs::write(&target, b"old").unwrap();
        assert!(replace_and_launch(dir.path(), &target, || Ok(())).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"old");
        fs::write(dir.path().join("next.exe"), b"new").unwrap();
        assert!(
            replace_and_launch(dir.path(), &target, || Err(io::Error::other(
                "cannot start"
            )))
            .is_err()
        );
        assert_eq!(fs::read(target).unwrap(), b"old");
        assert_eq!(fs::read(dir.path().join("next.exe")).unwrap(), b"new");
    }
}
