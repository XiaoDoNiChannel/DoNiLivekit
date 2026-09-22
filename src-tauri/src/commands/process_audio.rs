use crate::audio::engine::{self, ProcessInfo};
use crate::state::AppState;

#[tauri::command]
pub(crate) fn get_active_processes() -> Vec<ProcessInfo> {
    engine::get_active_processes()
}

#[tauri::command]
pub(crate) async fn start_capture(
    pid: u32,
    state: tauri::State<'_, AppState>,
) -> Result<u32, String> {
    engine::start_capture(pid, state).await
}

#[tauri::command]
pub(crate) async fn start_capture_multi(
    pids: Vec<u32>,
    state: tauri::State<'_, AppState>,
) -> Result<u32, String> {
    engine::start_capture_multi(pids, state).await
}
