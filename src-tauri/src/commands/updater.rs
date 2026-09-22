use serde::Serialize;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};
use tauri::{AppHandle, Emitter};
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

fn endpoint(server_base_url: &str) -> Result<tauri::Url, String> {
    let base = server_base_url.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err("更新服务器地址为空".to_string());
    }
    let url = format!("{base}/api/update/{{{{target}}}}/{{{{arch}}}}/{{{{current_version}}}}");
    url.parse::<tauri::Url>()
        .map_err(|error| format!("更新服务器地址无效: {error}"))
}

fn updater(
    app: &AppHandle,
    server_base_url: &str,
) -> Result<tauri_plugin_updater::Updater, String> {
    app.updater_builder()
        .endpoints(vec![endpoint(server_base_url)?])
        .map_err(|error| format!("配置动态更新地址失败: {error}"))?
        .build()
        .map_err(|error| format!("初始化更新器失败: {error}"))
}

#[tauri::command]
pub(crate) async fn check_for_update(
    app: AppHandle,
    server_base_url: String,
) -> Result<UpdateCheckResult, String> {
    let current_version = app.package_info().version.to_string();
    let update = updater(&app, &server_base_url)?
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
pub(crate) async fn install_update(
    app: AppHandle,
    server_base_url: String,
) -> Result<bool, String> {
    let Some(update) = updater(&app, &server_base_url)?
        .check()
        .await
        .map_err(|error| format!("检查更新失败: {error}"))?
    else {
        return Ok(false);
    };

    let progress_app = app.clone();
    let installing_app = app.clone();
    let downloaded_bytes = Arc::new(AtomicU64::new(0));
    let progress_downloaded_bytes = Arc::clone(&downloaded_bytes);
    let installing_downloaded_bytes = Arc::clone(&downloaded_bytes);

    update
        .download_and_install(
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
            move || {
                let downloaded_bytes = installing_downloaded_bytes.load(Ordering::Relaxed);
                let _ = installing_app.emit(
                    "update-download-progress",
                    UpdateDownloadProgress {
                        phase: "installing",
                        downloaded_bytes,
                        total_bytes: Some(downloaded_bytes),
                        progress_percent: Some(100.0),
                    },
                );
                log::info!(target: "donichannel::updater", "download complete; installing");
            },
        )
        .await
        .map_err(|error| format!("下载或安装更新失败: {error}"))?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_keeps_runtime_server_and_tauri_placeholders() {
        let url = endpoint("http://192.168.1.20:5000/").expect("valid endpoint");
        assert_eq!(
            url.as_str(),
            "http://192.168.1.20:5000/api/update/%7B%7Btarget%7D%7D/%7B%7Barch%7D%7D/%7B%7Bcurrent_version%7D%7D"
        );
    }
}
