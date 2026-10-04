use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::PathBuf,
    str::FromStr,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

const MAX_BYTES: usize = 5 * 1024 * 1024;
const MAX_CLIPS: usize = 64;
#[derive(Default)]
pub(crate) struct SoundboardState {
    files: Mutex<()>,
    bindings: Mutex<HashMap<String, Shortcut>>,
}
#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Clip {
    id: String,
    name: String,
}
const SEEDS: &[(&str, &[u8])] = &[
    (
        "打你吗的打",
        include_bytes!("../../resources/soundboard/1.mp3"),
    ),
    ("哦选择", include_bytes!("../../resources/soundboard/2.mp3")),
    (
        "哦选择加速",
        include_bytes!("../../resources/soundboard/3.mp3"),
    ),
    (
        "太tm白痴了",
        include_bytes!("../../resources/soundboard/4.mp3"),
    ),
    (
        "我退役了我不打了",
        include_bytes!("../../resources/soundboard/5.mp3"),
    ),
    (
        "再一再而不再三",
        include_bytes!("../../resources/soundboard/6.mp3"),
    ),
    (
        "嘴巴为什么要念这一句",
        include_bytes!("../../resources/soundboard/7.mp3"),
    ),
    ("addbdg", include_bytes!("../../resources/soundboard/8.mp3")),
];
fn caller(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("一键喊话只能由主窗口操作".into())
    }
}
fn err(e: impl std::fmt::Display) -> String {
    format!("soundboard：{e}")
}
fn directory(app: &AppHandle) -> Result<PathBuf, String> {
    let path = app.path().app_data_dir().map_err(err)?.join("soundboard");
    std::fs::create_dir_all(&path).map_err(err)?;
    Ok(path)
}
fn save(path: &std::path::Path, clips: &[Clip]) -> Result<(), String> {
    use std::io::Write;
    let mut file = tempfile::NamedTempFile::new_in(path).map_err(err)?;
    file.write_all(&serde_json::to_vec(clips).map_err(err)?)
        .map_err(err)?;
    file.as_file().sync_all().map_err(err)?;
    file.persist(path.join("library.json")).map_err(err)?;
    Ok(())
}
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() < 80
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'.')
        && !id.contains("..")
}
fn library(path: &std::path::Path) -> Result<Vec<Clip>, String> {
    let manifest = path.join("library.json");
    if manifest.exists() {
        let clips: Vec<Clip> =
            serde_json::from_slice(&std::fs::read(manifest).map_err(err)?).map_err(err)?;
        if clips.len() > MAX_CLIPS || clips.iter().any(|c| !valid_id(&c.id)) {
            return Err("音频库记录无效".into());
        }
        return Ok(clips);
    }
    let mut clips = Vec::new();
    for (i, (name, data)) in SEEDS.iter().enumerate() {
        let id = format!("seed-{}.mp3", i + 1);
        std::fs::write(path.join(&id), data).map_err(err)?;
        clips.push(Clip {
            id,
            name: name.to_string(),
        });
    }
    save(path, &clips)?;
    Ok(clips)
}
#[tauri::command]
pub(crate) fn soundboard_list(app: AppHandle, window: WebviewWindow) -> Result<Vec<Clip>, String> {
    caller(&window)?;
    let state = app.state::<SoundboardState>();
    let _guard = state.files.lock().map_err(err)?;
    library(&directory(&app)?)
}
#[tauri::command]
pub(crate) fn soundboard_read(
    app: AppHandle,
    window: WebviewWindow,
    id: String,
) -> Result<String, String> {
    caller(&window)?;
    let state = app.state::<SoundboardState>();
    let _guard = state.files.lock().map_err(err)?;
    let path = directory(&app)?;
    if !library(&path)?.iter().any(|c| c.id == id) {
        return Err("音频不存在".into());
    }
    let file = path.join(id);
    if std::fs::metadata(&file).map_err(err)?.len() > MAX_BYTES as u64 {
        return Err("音频超过 5 MB".into());
    }
    Ok(STANDARD.encode(std::fs::read(file).map_err(err)?))
}
#[tauri::command]
pub(crate) fn soundboard_import(
    app: AppHandle,
    window: WebviewWindow,
    name: String,
    data: String,
    extension: String,
) -> Result<Clip, String> {
    caller(&window)?;
    if !["mp3", "wav", "ogg"].contains(&extension.as_str()) || data.len() > MAX_BYTES * 4 / 3 + 4 {
        return Err("请导入 5 MB 以内的 MP3、WAV 或 OGG".into());
    }
    let bytes = STANDARD.decode(data).map_err(err)?;
    if bytes.is_empty() || bytes.len() > MAX_BYTES {
        return Err("音频大小无效".into());
    }
    let state = app.state::<SoundboardState>();
    let _guard = state.files.lock().map_err(err)?;
    let path = directory(&app)?;
    let mut clips = library(&path)?;
    if clips.len() >= MAX_CLIPS {
        return Err("最多保存 64 段音频，请先删除一些".into());
    }
    let id = format!(
        "clip-{}.{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(err)?
            .as_nanos(),
        extension
    );
    let clip = Clip {
        id,
        name: name.trim().chars().take(80).collect(),
    };
    std::fs::write(path.join(&clip.id), bytes).map_err(err)?;
    clips.push(clip.clone());
    if let Err(error) = save(&path, &clips) {
        let _ = std::fs::remove_file(path.join(&clip.id));
        return Err(error);
    }
    Ok(clip)
}
#[tauri::command]
pub(crate) fn soundboard_remove(
    app: AppHandle,
    window: WebviewWindow,
    id: String,
) -> Result<(), String> {
    caller(&window)?;
    let state = app.state::<SoundboardState>();
    let _guard = state.files.lock().map_err(err)?;
    let path = directory(&app)?;
    let mut clips = library(&path)?;
    if !clips.iter().any(|c| c.id == id) {
        return Err("音频不存在".into());
    }
    clips.retain(|c| c.id != id);
    save(&path, &clips)?;
    let _ = std::fs::remove_file(path.join(id));
    Ok(())
}
fn parse_shortcut(value: &str) -> Result<Shortcut, String> {
    if value.len() > 80 || (!value.contains('+') && !(1..=24).any(|n| value == format!("F{n}"))) {
        return Err("请选择组合键或 F1–F24 功能键".into());
    }
    Shortcut::from_str(value).map_err(|e| format!("快捷键无效：{e}"))
}
fn register(app: &AppHandle, shortcut: Shortcut, id: String) -> Result<(), String> {
    if app.global_shortcut().is_registered(shortcut) {
        return Err("快捷键已被本应用其他功能占用".into());
    }
    let held = Arc::new(AtomicBool::new(false));
    app.global_shortcut()
        .on_shortcut(shortcut, move |app, _, event| {
            if event.state == ShortcutState::Released {
                held.store(false, Ordering::Relaxed);
            } else if !held.swap(true, Ordering::Relaxed) {
                let _ = app.emit_to("main", "soundboard-trigger", &id);
            }
        })
        .map_err(|e| format!("快捷键被占用或无法注册：{e}"))
}
#[tauri::command]
pub(crate) fn soundboard_bind(
    app: AppHandle,
    window: WebviewWindow,
    id: String,
    shortcut: String,
) -> Result<(), String> {
    caller(&window)?;
    let state = app.state::<SoundboardState>();
    if id != "_stop" {
        let _guard = state.files.lock().map_err(err)?;
        if !library(&directory(&app)?)?.iter().any(|c| c.id == id) {
            return Err("音频不存在".into());
        }
    }
    let next = if shortcut.is_empty() {
        None
    } else {
        Some(parse_shortcut(&shortcut)?)
    };
    let mut bindings = state.bindings.lock().map_err(err)?;
    let old = bindings.get(&id).copied();
    if old == next {
        return Ok(());
    }
    // Register the replacement first: failure leaves the previous shortcut intact.
    if let Some(key) = next {
        register(&app, key, id.clone())?;
    }
    if let Some(key) = old {
        if let Err(error) = app.global_shortcut().unregister(key) {
            if let Some(key) = next {
                let _ = app.global_shortcut().unregister(key);
            }
            return Err(err(error));
        }
    }
    bindings.remove(&id);
    if let Some(key) = next {
        bindings.insert(id, key);
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_paths_and_unmodified_typing_keys() {
        for id in ["../x", "C:/x", "a\\b", "..", ""] {
            assert!(!valid_id(id));
        }
        assert!(valid_id("seed-1.mp3"));
        assert!(parse_shortcut("A").is_err());
        assert!(parse_shortcut("Ctrl+Alt+Digit1").is_ok());
        assert!(parse_shortcut("F8").is_ok());
    }
    #[test]
    fn seeds_once_and_preserves_deletions() {
        let dir = tempfile::tempdir().unwrap();
        let mut clips = library(dir.path()).unwrap();
        assert_eq!(clips.len(), 8);
        clips.remove(0);
        save(dir.path(), &clips).unwrap();
        assert_eq!(library(dir.path()).unwrap().len(), 7);
        assert!(dir.path().join("seed-2.mp3").exists());
    }
}
