use crate::audio::engine::{self, AudioDeviceInfo};
use crate::state::AppState;

#[tauri::command]
pub(crate) fn list_capture_devices() -> Result<Vec<AudioDeviceInfo>, String> {
    engine::list_capture_devices()
}

#[tauri::command]
pub(crate) fn set_rust_mic_device_id(
    device_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    engine::set_rust_mic_device_id(device_id, state)
}

#[tauri::command]
pub(crate) fn query_mic_sample_rate() -> Result<u32, String> {
    engine::query_mic_sample_rate()
}
