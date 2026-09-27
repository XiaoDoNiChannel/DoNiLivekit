mod audio;
mod commands;
mod error;
mod state;
mod transport;

use audio::engine::{start_audio_pump, start_mic_pump};
use commands::devices::{
    get_local_audio_instance_id, list_capture_devices, query_mic_sample_rate,
    set_rust_mic_device_id,
};
use commands::microphone::{set_mic_boost, set_mic_vad_threshold, toggle_rust_mic};
use commands::overlay;
use commands::process_audio::{get_active_processes, start_capture, start_capture_multi};
use commands::updater::{check_for_update, install_update};
use state::AppState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if let Err(error) = tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(AppState::new())
        .manage(overlay::OverlayState::default())
        .setup(|app| {
            overlay::init(app.handle());
            let state = app.state::<AppState>();
            let capture_tx = state.capture_tx.clone();
            let latest_capture_pids = state.latest_capture_pids.clone();
            let process_audio_instance_id = state.local_audio_instance_id.clone();
            tauri::async_runtime::spawn(async move {
                start_audio_pump(capture_tx, latest_capture_pids, process_audio_instance_id).await;
            });

            let app_handle = app.handle().clone();
            let mic_sessions = state.mic_sessions.clone();
            let mic_vad_threshold = state.mic_vad_threshold.clone();
            let mic_boost = state.mic_boost.clone();
            let selected_mic_device_id = state.selected_mic_device_id.clone();
            let microphone_instance_id = state.local_audio_instance_id.clone();
            tauri::async_runtime::spawn(async move {
                start_mic_pump(
                    app_handle,
                    mic_sessions,
                    mic_vad_threshold,
                    mic_boost,
                    selected_mic_device_id,
                    microphone_instance_id,
                )
                .await;
            });

            log::info!(target: "donichannel::startup", "local audio services started");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_active_processes,
            start_capture,
            start_capture_multi,
            set_mic_vad_threshold,
            toggle_rust_mic,
            list_capture_devices,
            set_rust_mic_device_id,
            query_mic_sample_rate,
            get_local_audio_instance_id,
            set_mic_boost,
            check_for_update,
            install_update,
            overlay::overlay_read,
            overlay::overlay_control,
            overlay::overlay_preferences,
            overlay::overlay_publish,
            overlay::overlay_mic,
            overlay::overlay_mic_result,
            overlay::overlay_drag,
        ])
        .run(tauri::generate_context!())
    {
        eprintln!("[tauri/run] application failed: {error}");
    }
}
