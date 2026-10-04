//! Lightweight status window. The main webview remains the only media/session owner.
use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    WindowEvent,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use tokio::sync::oneshot;

const LABEL: &str = "status-overlay";
const STALE_AFTER: Duration = Duration::from_secs(6);

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct Preferences {
    pub opacity: f64,
    pub toggle_shortcut: String,
    pub edit_shortcut: String,
    pub x: Option<i32>,
    pub y: Option<i32>,
    pub width: f64,
    pub height: f64,
    pub layout: String,
    pub compact_width: f64,
    pub compact_height: f64,
    pub expanded_width: f64,
    pub expanded_height: f64,
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            opacity: 0.7,
            toggle_shortcut: "Ctrl+Alt+Shift+O".into(),
            edit_shortcut: "Ctrl+Alt+O".into(),
            x: None,
            y: None,
            width: 360.0,
            height: 184.0,
            layout: "compact".into(),
            compact_width: 360.0,
            compact_height: 184.0,
            expanded_width: 400.0,
            expanded_height: 500.0,
        }
    }
}
impl Preferences {
    fn normalize(&mut self) {
        self.opacity = finite_clamp(self.opacity, 0.1, 1.0, 0.7);
        if self.layout != "expanded" {
            self.layout = "compact".into();
        }
        let expanded = self.layout == "expanded";
        self.width = finite_clamp(
            self.width,
            if expanded { 340.0 } else { 260.0 },
            if expanded { 640.0 } else { 560.0 },
            360.0,
        );
        self.height = finite_clamp(
            self.height,
            if expanded { 360.0 } else { 140.0 },
            if expanded { 720.0 } else { 300.0 },
            if expanded { 500.0 } else { 184.0 },
        );
        self.compact_width = finite_clamp(self.compact_width, 260.0, 560.0, 360.0);
        self.compact_height = finite_clamp(self.compact_height, 140.0, 300.0, 184.0);
        self.expanded_width = finite_clamp(self.expanded_width, 340.0, 640.0, 400.0);
        self.expanded_height = finite_clamp(self.expanded_height, 360.0, 720.0, 500.0);
    }
    fn change_layout(&mut self, layout: &str) -> Result<(), String> {
        if !matches!(layout, "compact" | "expanded") {
            return Err("未知浮窗布局".into());
        }
        if self.layout == layout {
            return Ok(());
        }
        if self.layout == "expanded" {
            self.expanded_width = self.width;
            self.expanded_height = self.height;
        } else {
            self.compact_width = self.width;
            self.compact_height = self.height;
        }
        self.layout = layout.into();
        (self.width, self.height) = if layout == "expanded" {
            (self.expanded_width, self.expanded_height)
        } else {
            (self.compact_width, self.compact_height)
        };
        self.normalize();
        Ok(())
    }
}
fn finite_clamp(value: f64, min: f64, max: f64, fallback: f64) -> f64 {
    if value.is_finite() {
        value.clamp(min, max)
    } else {
        fallback
    }
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    session: String,
    connected: bool,
    reconnecting: bool,
    channel: String,
    mic_on: bool,
    screen_on: bool,
    app_audio_on: bool,
    speakers: Vec<String>,
    speaker_count: u32,
    network_text: String,
    network_warning: bool,
    theme: String,
    #[serde(default)]
    panel: serde_json::Value,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Packet {
    snapshot: Snapshot,
    sequence: u64,
    fresh: bool,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Status {
    preferences: Preferences,
    visible: bool,
    interactive: bool,
    shortcuts_ready: bool,
    shortcut_error: String,
    version: u64,
}
impl Default for Status {
    fn default() -> Self {
        Self {
            preferences: Preferences::default(),
            visible: false,
            interactive: true,
            shortcuts_ready: false,
            shortcut_error: String::new(),
            version: 0,
        }
    }
}
#[derive(Serialize)]
pub(crate) struct OverlayRead {
    status: Status,
    packet: Option<Packet>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MicRequest {
    id: u64,
    session: String,
    enabled: bool,
    deadline: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ActionRequest {
    #[serde(default)]
    id: u64,
    session: String,
    kind: String,
    #[serde(default)]
    channel_id: String,
    #[serde(default)]
    content: String,
    #[serde(default)]
    identity: String,
    #[serde(default)]
    source: String,
    #[serde(default)]
    value: Option<f64>,
    #[serde(default)]
    deadline: u64,
}
type PendingAction = Option<(u64, oneshot::Sender<Result<(), String>>)>;
#[derive(Default)]
struct Data {
    status: Status,
    packet: Option<Packet>,
    received: Option<Instant>,
    request_seq: u64,
    pending: PendingAction,
}
#[derive(Default)]
pub(crate) struct OverlayState {
    data: Mutex<Data>,
    operation: tokio::sync::Mutex<()>,
    dirty: AtomicBool,
    path: Mutex<Option<PathBuf>>,
}
fn caller(window: &WebviewWindow, main_only: bool) -> Result<(), String> {
    if allowed_caller(window.label(), main_only) {
        Ok(())
    } else {
        Err("此窗口不能操作状态窗".into())
    }
}
fn allowed_caller(label: &str, main_only: bool) -> bool {
    label == "main" || (!main_only && label == LABEL)
}
fn can_request_mic(snapshot: &Snapshot, age: Option<Duration>, session: &str) -> bool {
    snapshot.connected
        && !snapshot.reconnecting
        && snapshot.session == session
        && age.is_some_and(|age| age <= STALE_AFTER)
}
fn err(error: impl std::fmt::Display) -> String {
    error.to_string()
}
fn emit_status(app: &AppHandle) -> Status {
    let status = {
        let state = app.state::<OverlayState>();
        let mut data = state.data.lock().unwrap();
        data.status.version += 1;
        data.status.clone()
    };
    let _ = app.emit_to("main", "overlay-status", &status);
    let _ = app.emit_to(LABEL, "overlay-status", &status);
    status
}
fn save(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<OverlayState>();
    let Some(path) = state.path.lock().unwrap().clone() else {
        return Ok(());
    };
    let prefs = state.data.lock().unwrap().status.preferences.clone();
    std::fs::create_dir_all(path.parent().ok_or("设置路径无效")?).map_err(err)?;
    std::fs::write(path, serde_json::to_vec_pretty(&prefs).map_err(err)?).map_err(err)
}

fn parse_shortcuts(prefs: &Preferences) -> Result<(Shortcut, Shortcut), String> {
    fn parse(value: &str) -> Result<Shortcut, String> {
        if value.len() > 80 || !value.contains('+') {
            return Err("快捷键需包含修饰键，例如 Ctrl+Alt+O".into());
        }
        value
            .parse()
            .map_err(|_| "快捷键格式无效，例如 Ctrl+Alt+O".to_string())
    }
    let show = parse(&prefs.toggle_shortcut)?;
    let edit = parse(&prefs.edit_shortcut)?;
    if show == edit {
        return Err("显示/隐藏与调整模式不能使用相同快捷键".into());
    }
    Ok((show, edit))
}
fn register_shortcuts(app: &AppHandle, prefs: &Preferences) -> Result<(), String> {
    let (show, edit) = parse_shortcuts(prefs)?;
    let register = |key, mode| {
        app.global_shortcut()
            .on_shortcut(key, move |app, _, event| {
                if event.state == ShortcutState::Pressed {
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Err(error) = control(&app, mode).await {
                            let _ = app.emit_to("main", "overlay-error", error);
                        }
                    });
                }
            })
    };
    register(show, "toggle").map_err(|e| format!("显示/隐藏快捷键不可用：{e}"))?;
    if let Err(error) = register(edit, "edit") {
        let _ = app.global_shortcut().unregister(show);
        return Err(format!("调整模式快捷键不可用：{error}"));
    }
    Ok(())
}
fn unregister_shortcuts(app: &AppHandle, prefs: &Preferences) {
    if let Ok((show, edit)) = parse_shortcuts(prefs) {
        let _ = app.global_shortcut().unregister(show);
        let _ = app.global_shortcut().unregister(edit);
    }
}

// Physical screen coordinates may be negative; always leave the complete window reachable.
fn fit_position(x: i32, y: i32, width: u32, height: u32, area: (i32, i32, u32, u32)) -> (i32, i32) {
    let (left, top, w, h) = area;
    let right = (left as i64 + w.saturating_sub(width) as i64)
        .clamp(i32::MIN as i64, i32::MAX as i64) as i32;
    let bottom = (top as i64 + h.saturating_sub(height) as i64)
        .clamp(i32::MIN as i64, i32::MAX as i64) as i32;
    (x.clamp(left, right), y.clamp(top, bottom))
}
fn place(window: &WebviewWindow, prefs: &Preferences, reset: bool) -> Result<(), String> {
    let expanded = prefs.layout == "expanded";
    // Clear the old limits before growing/shrinking across layouts.
    window
        .set_min_size(None::<tauri::LogicalSize<f64>>)
        .map_err(err)?;
    window
        .set_max_size(None::<tauri::LogicalSize<f64>>)
        .map_err(err)?;
    let monitors = window.available_monitors().map_err(err)?;
    let desired = if reset { None } else { prefs.x.zip(prefs.y) };
    let matched = desired.and_then(|(x, y)| {
        monitors
            .iter()
            .find(|m| {
                let a = m.work_area();
                x as i64 >= a.position.x as i64
                    && y as i64 >= a.position.y as i64
                    && (x as i64) < a.position.x as i64 + a.size.width as i64
                    && (y as i64) < a.position.y as i64 + a.size.height as i64
            })
            .cloned()
    });
    let monitor = matched
        .or(window.primary_monitor().map_err(err)?)
        .or_else(|| monitors.first().cloned())
        .ok_or("没有可用显示器")?;
    let area = monitor.work_area();
    let scale = monitor.scale_factor();
    let width = prefs.width.min(area.size.width as f64 / scale);
    let height = prefs.height.min(area.size.height as f64 / scale);
    window
        .set_size(tauri::LogicalSize::new(width, height))
        .map_err(err)?;
    window
        .set_min_size(Some(tauri::LogicalSize::new(
            if expanded {
                340.0_f64.min(width)
            } else {
                260.0_f64.min(width)
            },
            if expanded {
                360.0_f64.min(height)
            } else {
                140.0_f64.min(height)
            },
        )))
        .map_err(err)?;
    window
        .set_max_size(Some(tauri::LogicalSize::new(
            if expanded { 640.0 } else { 560.0 },
            if expanded { 720.0 } else { 300.0 },
        )))
        .map_err(err)?;
    let (x, y) = desired.unwrap_or((area.position.x + 24, area.position.y + 24));
    let (x, y) = fit_position(
        x,
        y,
        (width * scale) as u32,
        (height * scale) as u32,
        (
            area.position.x,
            area.position.y,
            area.size.width,
            area.size.height,
        ),
    );
    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(err)
}
fn ensure_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    if let Some(window) = app.get_webview_window(LABEL) {
        return Ok(window);
    }
    let prefs = app
        .state::<OverlayState>()
        .data
        .lock()
        .unwrap()
        .status
        .preferences
        .clone();
    let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("overlay.html".into()))
        .title("DoNiChannel 队伍浮窗")
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(true)
        .focused(false)
        .visible(false)
        .inner_size(prefs.width, prefs.height)
        .min_inner_size(260.0, 140.0)
        .max_inner_size(640.0, 720.0)
        .build()
        .map_err(err)?;
    if let Err(error) = place(&window, &prefs, false) {
        let _ = window.destroy();
        return Err(error);
    }
    let handle = app.clone();
    let copy = window.clone();
    window.on_window_event(move |event| {
        let state = handle.state::<OverlayState>();
        match event {
            WindowEvent::Moved(position) => {
                let mut data = state.data.lock().unwrap();
                data.status.preferences.x = Some(position.x);
                data.status.preferences.y = Some(position.y);
                state.dirty.store(true, Ordering::Release);
            }
            WindowEvent::Resized(size) => {
                if size.width == 0 || size.height == 0 {
                    return;
                }
                let scale = copy.scale_factor().unwrap_or(1.0);
                let mut data = state.data.lock().unwrap();
                data.status.preferences.width = size.width as f64 / scale;
                data.status.preferences.height = size.height as f64 / scale;
                state.dirty.store(true, Ordering::Release);
            }
            WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let handle = handle.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = control(&handle, "hide").await;
                });
            }
            _ => {}
        }
    });
    Ok(window)
}

async fn control(app: &AppHandle, action: &str) -> Result<Status, String> {
    let state = app.state::<OverlayState>();
    let _operation = state.operation.lock().await;
    let before = state.data.lock().unwrap().status.clone();
    if action == "hide" || (action == "toggle" && before.visible) {
        if let Some(window) = app.get_webview_window(LABEL) {
            window.hide().map_err(err)?;
        }
        state.data.lock().unwrap().status.visible = false;
    } else {
        let interactive = match action {
            "show" | "reset" => true,
            "edit" => !before.visible || !before.interactive,
            "game" | "toggle" => false,
            _ => return Err("未知浮窗操作".into()),
        };
        if !interactive && !before.shortcuts_ready {
            return Err("请先设置可用快捷键，再开启鼠标穿透。也可在主界面找回浮窗。".into());
        }
        let window = ensure_window(app)?;
        if action == "reset" {
            let mut prefs = before.preferences.clone();
            prefs.width = if prefs.layout == "expanded" {
                400.0
            } else {
                360.0
            };
            prefs.height = if prefs.layout == "expanded" {
                500.0
            } else {
                184.0
            };
            place(&window, &prefs, true)?;
        } else if !before.visible {
            place(&window, &before.preferences, false)?;
        }
        // Every mode transition is recoverable from the main window.
        if interactive {
            window.set_ignore_cursor_events(false).map_err(err)?;
            window.set_focusable(true).map_err(err)?;
        } else {
            window.set_ignore_cursor_events(true).map_err(err)?;
            if let Err(error) = window.set_focusable(false) {
                let _ = window.set_ignore_cursor_events(false);
                return Err(err(error));
            }
        }
        window.set_always_on_top(true).map_err(err)?;
        window.show().map_err(err)?;
        let mut data = state.data.lock().unwrap();
        data.status.visible = true;
        data.status.interactive = interactive;
    }
    Ok(emit_status(app))
}

pub(crate) fn init(app: &AppHandle) {
    let state = app.state::<OverlayState>();
    if let Ok(dir) = app.path().app_config_dir() {
        let path = dir.join("status-overlay.json");
        if let Ok(bytes) = std::fs::read(&path) {
            if let Ok(mut prefs) = serde_json::from_slice::<Preferences>(&bytes) {
                prefs.normalize();
                state.data.lock().unwrap().status.preferences = prefs;
            }
        }
        *state.path.lock().unwrap() = Some(path);
    }
    let prefs = state.data.lock().unwrap().status.preferences.clone();
    let result = register_shortcuts(app, &prefs);
    {
        let mut data = state.data.lock().unwrap();
        data.status.shortcuts_ready = result.is_ok();
        data.status.shortcut_error = result.err().unwrap_or_default();
    }
    // Native heartbeat requests continue while the main window is minimized.
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(2));
        loop {
            interval.tick().await;
            let state = handle.state::<OverlayState>();
            if state.dirty.swap(false, Ordering::AcqRel) {
                if let Err(error) = save(&handle) {
                    let _ = handle.emit_to(
                        "main",
                        "overlay-error",
                        format!("浮窗设置保存失败：{error}"),
                    );
                }
            }
            let visible = state.data.lock().unwrap().status.visible;
            if visible {
                let _ = handle.emit_to("main", "overlay-poll", ());
            }
        }
    });
    if let Some(main) = app.get_webview_window("main") {
        let handle = app.clone();
        main.on_window_event(move |event| match event {
            WindowEvent::CloseRequested { .. } => {
                let _ = save(&handle);
            }
            WindowEvent::Destroyed => handle.exit(0),
            _ => {}
        });
    }
}

#[tauri::command]
pub(crate) fn overlay_read(app: AppHandle, window: WebviewWindow) -> Result<OverlayRead, String> {
    caller(&window, false)?;
    let state = app.state::<OverlayState>();
    let data = state.data.lock().unwrap();
    let packet = data.packet.clone().map(|mut packet| {
        packet.fresh = data
            .received
            .is_some_and(|time| time.elapsed() <= STALE_AFTER);
        packet
    });
    Ok(OverlayRead {
        status: data.status.clone(),
        packet,
    })
}
#[tauri::command]
pub(crate) async fn overlay_control(
    app: AppHandle,
    window: WebviewWindow,
    action: String,
) -> Result<Status, String> {
    caller(&window, false)?;
    control(&app, &action).await
}
#[tauri::command]
pub(crate) async fn overlay_preferences(
    app: AppHandle,
    window: WebviewWindow,
    opacity: Option<f64>,
    toggle_shortcut: Option<String>,
    edit_shortcut: Option<String>,
    layout: Option<String>,
) -> Result<Status, String> {
    caller(&window, false)?;
    let state = app.state::<OverlayState>();
    let _operation = state.operation.lock().await;
    let old = state.data.lock().unwrap().status.clone();
    let mut next = old.preferences.clone();
    if let Some(ref layout) = layout {
        next.change_layout(layout)?;
    }
    if let Some(opacity) = opacity {
        next.opacity = finite_clamp(opacity, 0.1, 1.0, 0.7);
    }
    let changing_shortcuts = toggle_shortcut.is_some() || edit_shortcut.is_some();
    if changing_shortcuts {
        caller(&window, true)?;
        if let Some(value) = toggle_shortcut {
            next.toggle_shortcut = value;
        }
        if let Some(value) = edit_shortcut {
            next.edit_shortcut = value;
        }
        parse_shortcuts(&next)?;
        if old.shortcuts_ready {
            unregister_shortcuts(&app, &old.preferences);
        }
        if let Err(error) = register_shortcuts(&app, &next) {
            let recovered =
                old.shortcuts_ready && register_shortcuts(&app, &old.preferences).is_ok();
            {
                let mut data = state.data.lock().unwrap();
                data.status.shortcuts_ready = recovered;
                data.status.shortcut_error = error.clone();
            }
            if !recovered {
                if let Some(window) = app.get_webview_window(LABEL) {
                    let _ = window.set_ignore_cursor_events(false);
                    let _ = window.set_focusable(true);
                }
                state.data.lock().unwrap().status.interactive = true;
            }
            emit_status(&app);
            return Err(error);
        }
    }
    if layout.is_some() {
        if let Some(overlay) = app.get_webview_window(LABEL) {
            place(&overlay, &next, false)?;
        }
    }
    {
        let mut data = state.data.lock().unwrap();
        data.status.preferences = next;
        if changing_shortcuts {
            data.status.shortcuts_ready = true;
            data.status.shortcut_error.clear();
        }
    }
    state.dirty.store(true, Ordering::Release);
    Ok(emit_status(&app))
}
#[tauri::command]
pub(crate) fn overlay_publish(
    app: AppHandle,
    window: WebviewWindow,
    mut snapshot: Snapshot,
) -> Result<(), String> {
    caller(&window, true)?;
    snapshot.speakers.truncate(3);
    if serde_json::to_vec(&snapshot.panel).map_err(err)?.len() > 512_000 {
        return Err("浮窗消息数据过长".into());
    }
    if snapshot.session.len() > 160
        || snapshot.channel.len() > 300
        || snapshot.speakers.iter().any(|s| s.len() > 300)
    {
        return Err("状态数据过长".into());
    }
    let packet = {
        let state = app.state::<OverlayState>();
        let mut data = state.data.lock().unwrap();
        let sequence = data.packet.as_ref().map_or(1, |p| p.sequence + 1);
        let packet = Packet {
            snapshot,
            sequence,
            fresh: true,
        };
        data.received = Some(Instant::now());
        data.packet = Some(packet.clone());
        packet
    };
    let _ = app.emit_to(LABEL, "overlay-snapshot", packet);
    Ok(())
}
#[tauri::command]
pub(crate) async fn overlay_mic(
    app: AppHandle,
    window: WebviewWindow,
    session: String,
    enabled: bool,
) -> Result<(), String> {
    caller(&window, false)?;
    let (tx, rx) = oneshot::channel();
    let id = {
        let state = app.state::<OverlayState>();
        let mut data = state.data.lock().unwrap();
        if data.pending.is_some() {
            return Err("麦克风操作尚未完成".into());
        }
        if window.label() == LABEL && (!data.status.visible || !data.status.interactive) {
            return Err("请先进入浮窗调整模式".into());
        }
        let packet = data.packet.as_ref().ok_or("尚未收到通话状态")?;
        if !can_request_mic(
            &packet.snapshot,
            data.received.map(|t| t.elapsed()),
            &session,
        ) {
            return Err("通话状态已变化，请等待状态更新".into());
        }
        data.request_seq += 1;
        let id = data.request_seq;
        data.pending = Some((id, tx));
        id
    };
    let deadline = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
        + 5000;
    let result = match app.emit_to(
        "main",
        "overlay-mic-request",
        MicRequest {
            id,
            session,
            enabled,
            deadline,
        },
    ) {
        Ok(()) => match tokio::time::timeout(Duration::from_secs(5), rx).await {
            Ok(Ok(result)) => result,
            _ => Err("主界面未及时确认操作，请检查当前麦克风状态".into()),
        },
        Err(error) => Err(err(error)),
    };
    let state = app.state::<OverlayState>();
    let mut data = state.data.lock().unwrap();
    if data
        .pending
        .as_ref()
        .is_some_and(|(pending, _)| *pending == id)
    {
        data.pending = None;
    }
    result
}
#[tauri::command]
pub(crate) fn overlay_mic_result(
    app: AppHandle,
    window: WebviewWindow,
    id: u64,
    error: Option<String>,
) -> Result<(), String> {
    caller(&window, true)?;
    let state = app.state::<OverlayState>();
    let mut data = state.data.lock().unwrap();
    if data
        .pending
        .as_ref()
        .is_some_and(|(pending, _)| *pending == id)
    {
        if let Some((_, sender)) = data.pending.take() {
            let _ = sender.send(error.map_or(Ok(()), Err));
        }
    }
    Ok(())
}
#[tauri::command]
pub(crate) async fn overlay_action(
    app: AppHandle,
    window: WebviewWindow,
    mut request: ActionRequest,
) -> Result<(), String> {
    caller(&window, false)?;
    let (tx, rx) = oneshot::channel();
    {
        let state = app.state::<OverlayState>();
        let mut data = state.data.lock().unwrap();
        if data.pending.is_some() {
            return Err("浮窗操作尚未完成".into());
        }
        if window.label() == LABEL && (!data.status.visible || !data.status.interactive) {
            return Err("请先进入浮窗调整模式".into());
        }
        let packet = data.packet.as_ref().ok_or("尚未收到浮窗状态")?;
        if !data
            .received
            .is_some_and(|time| time.elapsed() <= STALE_AFTER)
            || packet.snapshot.session != request.session
        {
            return Err("浮窗状态已变化，请等待更新".into());
        }
        validate_action(&packet.snapshot, &request)?;
        data.request_seq += 1;
        request.id = data.request_seq;
        data.pending = Some((request.id, tx));
    }
    request.deadline = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
        + 8000;
    let id = request.id;
    let result = match app.emit_to("main", "overlay-action-request", request) {
        Ok(()) => match tokio::time::timeout(Duration::from_secs(8), rx).await {
            Ok(Ok(result)) => result,
            _ => Err("操作确认超时，请先检查消息或语音状态，避免重复操作".into()),
        },
        Err(error) => Err(err(error)),
    };
    let state = app.state::<OverlayState>();
    let mut data = state.data.lock().unwrap();
    if data
        .pending
        .as_ref()
        .is_some_and(|(pending, _)| *pending == id)
    {
        data.pending = None;
    }
    result
}
fn validate_action(snapshot: &Snapshot, request: &ActionRequest) -> Result<(), String> {
    match request.kind.as_str() {
        "chat" | "read" => {
            if request.channel_id.is_empty()
                || snapshot.panel["chatChannelId"].as_str() != Some(request.channel_id.as_str())
            {
                return Err("聊天频道已变化".into());
            }
            if request.kind == "chat"
                && (request.content.trim().is_empty()
                    || request.content.chars().count() > 2000
                    || snapshot.panel["chatConnected"].as_bool() != Some(true))
            {
                return Err("消息为空、过长或聊天未连接".into());
            }
        }
        "volume" => {
            if !snapshot.connected
                || snapshot.reconnecting
                || !matches!(request.source.as_str(), "mic" | "appaudio")
                || !request
                    .value
                    .is_some_and(|v| v.is_finite() && (0.0..=300.0).contains(&v))
                || !snapshot.panel["members"].as_array().is_some_and(|rows| {
                    rows.iter().any(|row| {
                        row["self"].as_bool() == Some(false)
                            && row["volumeIdentity"].as_str() == Some(request.identity.as_str())
                    })
                })
            {
                return Err("成员或音量状态已变化".into());
            }
        }
        _ => return Err("未知浮窗操作".into()),
    }
    Ok(())
}
#[tauri::command]
pub(crate) fn overlay_action_result(
    app: AppHandle,
    window: WebviewWindow,
    id: u64,
    error: Option<String>,
) -> Result<(), String> {
    overlay_mic_result(app, window, id, error)
}
#[tauri::command]
pub(crate) fn overlay_drag(window: WebviewWindow) -> Result<(), String> {
    if window.label() != LABEL {
        return Err("只能拖动状态窗".into());
    }
    window.start_dragging().map_err(err)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn layouts_remember_separate_sizes_and_reject_unknown_modes() {
        let mut prefs = Preferences::default();
        prefs.width = 380.0;
        prefs.height = 190.0;
        prefs.change_layout("expanded").unwrap();
        assert_eq!((prefs.width, prefs.height), (400.0, 500.0));
        prefs.width = 450.0;
        prefs.height = 600.0;
        prefs.change_layout("compact").unwrap();
        assert_eq!((prefs.width, prefs.height), (380.0, 190.0));
        prefs.change_layout("expanded").unwrap();
        assert_eq!((prefs.width, prefs.height), (450.0, 600.0));
        assert!(prefs.change_layout("unknown").is_err());
        let mut restored: Preferences =
            serde_json::from_str(&serde_json::to_string(&prefs).unwrap()).unwrap();
        restored.normalize();
        assert_eq!(restored.layout, "expanded");
        assert_eq!(restored.height, 600.0);
    }
    #[test]
    fn team_actions_validate_channel_content_and_member_before_forwarding() {
        let mut snapshot = Snapshot {
            connected: true,
            panel: serde_json::json!({"chatChannelId":"a", "chatConnected":true,
            "members":[{"volumeIdentity":"u1", "self":false}]}),
            ..Snapshot::default()
        };
        let mut request: ActionRequest = serde_json::from_value(
            serde_json::json!({"session":"s", "kind":"chat", "channelId":"a", "content":"hello"}),
        )
        .unwrap();
        assert!(validate_action(&snapshot, &request).is_ok());
        request.channel_id = "b".into();
        assert!(validate_action(&snapshot, &request).is_err());
        request.channel_id = "a".into();
        request.content = "x".repeat(2001);
        assert!(validate_action(&snapshot, &request).is_err());
        request.kind = "volume".into();
        request.identity = "u1".into();
        request.source = "mic".into();
        request.value = Some(0.0);
        assert!(validate_action(&snapshot, &request).is_ok());
        request.value = Some(301.0);
        assert!(validate_action(&snapshot, &request).is_err());
        request.value = Some(100.0);
        snapshot.reconnecting = true;
        assert!(validate_action(&snapshot, &request).is_err());
        snapshot.reconnecting = false;
        snapshot.panel["members"][0]["self"] = serde_json::json!(true);
        assert!(validate_action(&snapshot, &request).is_err());
    }
    #[test]
    fn removed_monitor_position_is_clamped_back_to_work_area() {
        assert_eq!(
            fit_position(5000, -100, 320, 164, (0, 40, 1920, 1040)),
            (1600, 40)
        );
        assert_eq!(
            fit_position(-1800, 500, 320, 164, (-1920, 0, 1920, 1080)),
            (-1800, 500)
        );
        assert_eq!(fit_position(900, 900, 560, 300, (0, 0, 320, 240)), (0, 0));
    }
    #[test]
    fn old_or_partial_preferences_get_safe_defaults_and_bounds() {
        let mut prefs: Preferences =
            serde_json::from_str(r#"{"opacity":-4,"width":99999,"height":1}"#).unwrap();
        prefs.normalize();
        assert_eq!(prefs.opacity, 0.1);
        assert_eq!(prefs.width, 560.0);
        assert_eq!(prefs.height, 140.0);
        assert!(parse_shortcuts(&prefs).is_ok());
        assert_eq!(finite_clamp(f64::NAN, 0.1, 1.0, 0.7), 0.7);
    }
    #[test]
    fn shortcut_validation_rejects_duplicates_and_invalid_bindings() {
        let mut prefs = Preferences::default();
        prefs.edit_shortcut = prefs.toggle_shortcut.clone();
        assert!(parse_shortcuts(&prefs).is_err());
        prefs.edit_shortcut = "O".into();
        assert!(parse_shortcuts(&prefs).is_err());
        prefs.edit_shortcut = "Ctrl+NotAKey".into();
        assert!(parse_shortcuts(&prefs).is_err());
    }
    #[test]
    fn only_main_can_publish_state_and_acknowledge_media_actions() {
        assert!(allowed_caller("main", true));
        assert!(!allowed_caller(LABEL, true));
        assert!(allowed_caller(LABEL, false));
        assert!(!allowed_caller("unknown", false));
    }
    #[test]
    fn microphone_actions_require_a_fresh_connected_matching_session() {
        let mut snapshot = Snapshot {
            session: "a".into(),
            connected: true,
            ..Snapshot::default()
        };
        assert!(can_request_mic(
            &snapshot,
            Some(Duration::from_secs(1)),
            "a"
        ));
        assert!(!can_request_mic(
            &snapshot,
            Some(Duration::from_secs(7)),
            "a"
        ));
        assert!(!can_request_mic(&snapshot, None, "a"));
        assert!(!can_request_mic(&snapshot, Some(Duration::ZERO), "b"));
        snapshot.reconnecting = true;
        assert!(!can_request_mic(&snapshot, Some(Duration::ZERO), "a"));
        snapshot.reconnecting = false;
        snapshot.connected = false;
        assert!(!can_request_mic(&snapshot, Some(Duration::ZERO), "a"));
    }
}
