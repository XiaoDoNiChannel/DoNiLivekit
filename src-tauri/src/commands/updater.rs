use serde::Serialize;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};
use tauri::{AppHandle, Emitter, WebviewWindow};
use tauri_plugin_updater::UpdaterExt;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateCheckResult {
    available: bool,
    version: Option<String>,
    current_version: String,
    notes: Option<String>,
    pub_date: Option<String>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateDownloadProgress {
    phase: &'static str,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    progress_percent: Option<f64>,
}

fn updater(app: &AppHandle) -> Result<tauri_plugin_updater::Updater, String> {
    app.updater_builder()
        .target("windows-x86_64-portable")
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|error| format!("初始化 GitHub 更新器失败: {error}"))
}

#[tauri::command]
pub(crate) async fn check_for_update(app: AppHandle) -> Result<UpdateCheckResult, String> {
    let current_version = app.package_info().version.to_string();
    let update = updater(&app)?
        .check()
        .await
        .map_err(|error| format!("检查更新失败: {error}"))?;

    Ok(match update {
        Some(update) => UpdateCheckResult {
            available: true,
            version: Some(update.version.clone()),
            current_version,
            notes: update.body.clone(),
            pub_date: update.date.map(|date| date.to_string()),
        },
        None => UpdateCheckResult {
            available: false,
            version: None,
            current_version,
            notes: None,
            pub_date: None,
        },
    })
}

#[tauri::command]
pub(crate) async fn install_update(app: AppHandle, window: WebviewWindow) -> Result<bool, String> {
    if window.label() != "main" {
        return Err("只能从主窗口发起更新".into());
    }
    static INSTALLING: AtomicBool = AtomicBool::new(false);
    if INSTALLING.swap(true, Ordering::AcqRel) {
        return Err("更新正在进行中".into());
    }
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            INSTALLING.store(false, Ordering::Release);
        }
    }
    let _reset = Reset;
    let Some(mut update) = updater(&app)?
        .check()
        .await
        .map_err(|error| format!("检查更新失败: {error}"))?
    else {
        return Ok(false);
    };
    // The plugin's check timeout is not carried over to the returned download.
    update.timeout = Some(std::time::Duration::from_secs(180));

    let progress_app = app.clone();
    let downloaded_bytes = Arc::new(AtomicU64::new(0));
    let progress_downloaded_bytes = Arc::clone(&downloaded_bytes);

    let bytes = update
        .download(
            move |chunk_length, content_length| {
                let downloaded_bytes = progress_downloaded_bytes
                    .fetch_add(chunk_length as u64, Ordering::Relaxed)
                    .saturating_add(chunk_length as u64);
                let progress_percent = content_length
                    .filter(|total| *total > 0)
                    .map(|total| (downloaded_bytes as f64 / total as f64 * 100.0).min(100.0));
                let _ = progress_app.emit(
                    "update-download-progress",
                    UpdateDownloadProgress {
                        phase: "downloading",
                        downloaded_bytes,
                        total_bytes: content_length,
                        progress_percent,
                    },
                );
                log::debug!(
                    target: "donichannel::updater",
                    "download chunk={} total={:?}",
                    chunk_length,
                    content_length
                );
            },
            || {},
        )
        .await
        .map_err(|error| format!("下载或验证更新失败: {error}"))?;
    let total = bytes.len() as u64;
    let _ = app.emit(
        "update-download-progress",
        UpdateDownloadProgress {
            phase: "installing",
            downloaded_bytes: total,
            total_bytes: Some(total),
            progress_percent: Some(100.0),
        },
    );
    tauri::async_runtime::spawn_blocking(move || {
        crate::portable_update::prepare(bytes, update.signature)
    })
    .await
    .map_err(|error| error.to_string())??;
    app.exit(0);
    Ok(true)
}
