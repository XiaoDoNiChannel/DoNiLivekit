use crate::audio::engine;
use crate::state::AppState;

#[tauri::command]
pub(crate) fn set_mic_vad_threshold(val: f32, state: tauri::State<'_, AppState>) {
    engine::set_mic_vad_threshold(val, state);
}

#[tauri::command]
pub(crate) fn set_mic_boost(val: f32, state: tauri::State<'_, AppState>) {
    engine::set_mic_boost(val, state);
}

#[tauri::command]
pub(crate) fn toggle_rust_mic(
    enable: bool,
    state: tauri::State<'_, AppState>,
) -> Result<u64, String> {
    engine::toggle_rust_mic(enable, state)
}
