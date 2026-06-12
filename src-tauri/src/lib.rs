use futures_util::SinkExt;
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use sysinfo::System;
use tauri::{Emitter, Manager};
use tokio::net::TcpListener;
use tokio::sync::{broadcast, mpsc};
use tokio_tungstenite::accept_async;
use tokio_tungstenite::tungstenite::Message;

#[cfg(target_os = "windows")]
use std::sync::{mpsc as std_mpsc, Mutex as StdMutex};

#[cfg(target_os = "windows")]
use std::time::Duration;

#[cfg(target_os = "windows")]
use windows::{
    core::{implement, ComInterface, Error as WinError, IUnknown, HRESULT, HSTRING, PCWSTR},
    Win32::{
        Devices::FunctionDiscovery::PKEY_Device_FriendlyName,
        Media::Audio::{
            eCapture, eCommunications, eMultimedia, eRender, ActivateAudioInterfaceAsync,
            IActivateAudioInterfaceAsyncOperation, IActivateAudioInterfaceCompletionHandler,
            IActivateAudioInterfaceCompletionHandler_Impl, IAudioCaptureClient, IAudioClient,
            IMMDevice, IMMDeviceCollection, IMMDeviceEnumerator, MMDeviceEnumerator, DEVICE_STATE_ACTIVE,
            AUDCLNT_BUFFERFLAGS_SILENT,
            AUDCLNT_E_DEVICE_INVALIDATED, AUDCLNT_E_WRONG_ENDPOINT_TYPE, AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_LOOPBACK, AUDIOCLIENT_ACTIVATION_PARAMS,
            AUDIOCLIENT_ACTIVATION_PARAMS_0, AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
            AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS, PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
            VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, WAVEFORMATEX,
        },
        System::Com::{
            CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, STGM_READ,
            StructuredStorage::{PropVariantClear, PROPVARIANT, PROPVARIANT_0, PROPVARIANT_0_0, PROPVARIANT_0_0_0},
            BLOB, CLSCTX_ALL, COINIT_MULTITHREADED,
        },
        System::Variant::{VT_BLOB, VT_LPWSTR},
    },
};

struct AppState {
    capture_tx: broadcast::Sender<Vec<u32>>,
    latest_capture_pids: Arc<Mutex<Vec<u32>>>,
    mic_vad_threshold: Arc<Mutex<f32>>,
    is_mic_running: Arc<Mutex<bool>>,
    mic_boost: Arc<Mutex<f32>>,
    selected_mic_device_id: Arc<Mutex<Option<String>>>,
}

// 定义我们要传给前端的数据格式
#[derive(Serialize)]
struct ProcessInfo {
    pid: u32,
    name: String,
    memory_mb: u64,
}

#[derive(Serialize)]
struct AudioDeviceInfo {
    id: String,
    name: String,
}

// 暴漏给前端 JS 调用的命令：获取活跃进程雷达
#[tauri::command]
fn get_active_processes() -> Vec<ProcessInfo> {
    let mut sys = System::new_all();
    sys.refresh_all();

    let mut grouped: HashMap<String, (u32, u64)> = HashMap::new();

    for (pid, process) in sys.processes() {
        let mut root_pid = *pid;
        let mut cursor_pid = *pid;

        loop {
            let Some(current_proc) = sys.processes().get(&cursor_pid) else {
                break;
            };

            let Some(parent_pid) = current_proc.parent() else {
                break;
            };

            let Some(parent_proc) = sys.processes().get(&parent_pid) else {
                break;
            };

            if parent_proc.name() == current_proc.name() {
                root_pid = parent_pid;
                cursor_pid = parent_pid;
                continue;
            }

            break;
        }

        let name = process.name().to_string();
        let mem_bytes = process.memory();

        let entry = grouped.entry(name).or_insert((root_pid.as_u32(), 0));
        entry.1 = entry.1.saturating_add(mem_bytes);
    }

    let mut process_list: Vec<ProcessInfo> = grouped
        .into_iter()
        .map(|(name, (pid, memory_bytes))| ProcessInfo {
            pid,
            name,
            memory_mb: memory_bytes / 1024 / 1024,
        })
        .filter(|item| item.memory_mb >= 30)
        .collect();

    process_list.sort_by(|a, b| b.memory_mb.cmp(&a.memory_mb));
    process_list
}

#[tauri::command]
async fn start_capture(pid: u32, state: tauri::State<'_, AppState>) -> Result<u32, String> {
    start_capture_multi(vec![pid], state).await
}

#[tauri::command]
async fn start_capture_multi(
    pids: Vec<u32>,
    state: tauri::State<'_, AppState>,
) -> Result<u32, String> {
    let mut normalized = Vec::new();
    for pid in pids {
        if pid == 0 {
            continue;
        }
        if !normalized.contains(&pid) {
            normalized.push(pid);
        }
    }

    if normalized.is_empty() {
        return Err("没有可用的 PID，无法启动采集".into());
    }

    if let Ok(mut guard) = state.latest_capture_pids.lock() {
        *guard = normalized.clone();
    }

    let _ = state.capture_tx.send(normalized);

    query_mix_sample_rate()
}

#[tauri::command]
fn set_mic_vad_threshold(val: f32, state: tauri::State<'_, AppState>) {
    if let Ok(mut guard) = state.mic_vad_threshold.lock() {
        *guard = val;
    }
}

#[tauri::command]
fn set_mic_boost(val: f32, state: tauri::State<'_, AppState>) {
    if let Ok(mut guard) = state.mic_boost.lock() {
        *guard = val;
    }
}

#[tauri::command]
fn toggle_rust_mic(enable: bool, state: tauri::State<'_, AppState>) {
    if let Ok(mut guard) = state.is_mic_running.lock() {
        *guard = enable;
    }
}

#[tauri::command]
fn set_rust_mic_device_id(device_id: String, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let normalized = device_id.trim().to_string();
    let mut guard = state
        .selected_mic_device_id
        .lock()
        .map_err(|_| "selected_mic_device_id 状态锁被污染".to_string())?;

    if normalized.is_empty() || normalized == "default" {
        *guard = None;
    } else {
        *guard = Some(normalized);
    }

    Ok(())
}

#[tauri::command]
#[cfg(target_os = "windows")]
fn list_capture_devices() -> Result<Vec<AudioDeviceInfo>, String> {
    let mut should_uninit = false;
    match unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) } {
        Ok(()) => {
            should_uninit = true;
        }
        Err(e) if e.code() == HRESULT(0x80010106u32 as i32) => {}
        Err(e) => return Err(hr_msg("枚举麦克风时 CoInitializeEx 失败", e.code())),
    }

    let result = (|| -> Result<Vec<AudioDeviceInfo>, String> {
        let enumerator: IMMDeviceEnumerator =
            unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }
                .map_err(|e| hr_msg("创建 IMMDeviceEnumerator 失败", e.code()))?;

        let mut devices = Vec::new();

        // 1) 系统默认麦克风：value 为空字符串，Rust 侧会按默认设备打开。
        if let Ok(default_device) = unsafe { enumerator.GetDefaultAudioEndpoint(eCapture, eMultimedia) } {
            let default_id = get_device_id_string(&default_device).unwrap_or_default();
            let default_name = get_device_friendly_name(&default_device)
                .unwrap_or_else(|_| "系统默认麦克风".to_string());
            devices.push(AudioDeviceInfo {
                id: String::new(),
                name: format!("默认值 - {}{}", default_name, short_device_suffix(&default_id)),
            });
        } else {
            devices.push(AudioDeviceInfo {
                id: String::new(),
                name: "系统默认麦克风".to_string(),
            });
        }

        // 2) 通信默认麦克风：截图里的“通信 - 麦克风 (...)”。
        if let Ok(comm_device) = unsafe { enumerator.GetDefaultAudioEndpoint(eCapture, eCommunications) } {
            let comm_id = get_device_id_string(&comm_device).unwrap_or_default();
            let comm_name = get_device_friendly_name(&comm_device)
                .unwrap_or_else(|_| "通信麦克风".to_string());
            devices.push(AudioDeviceInfo {
                id: "__communications__".to_string(),
                name: format!("通信 - {}{}", comm_name, short_device_suffix(&comm_id)),
            });
        }

        // 3) 所有已启用输入设备。
        let collection: IMMDeviceCollection = unsafe {
            enumerator.EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE)
        }
        .map_err(|e| hr_msg("枚举输入设备失败", e.code()))?;

        let count = unsafe { collection.GetCount() }
            .map_err(|e| hr_msg("获取输入设备数量失败", e.code()))?;

        for i in 0..count {
            let device = unsafe { collection.Item(i) }
                .map_err(|e| hr_msg("读取输入设备失败", e.code()))?;

            let id = get_device_id_string(&device)?;
            let friendly_name = get_device_friendly_name(&device)
                .unwrap_or_else(|_| format!("麦克风 {}", i + 1));

            devices.push(AudioDeviceInfo {
                id: id.clone(),
                name: format!("{}{}", friendly_name, short_device_suffix(&id)),
            });
        }

        Ok(devices)
    })();

    if should_uninit {
        unsafe { CoUninitialize() };
    }

    result
}

#[cfg(target_os = "windows")]
fn get_device_id_string(device: &IMMDevice) -> Result<String, String> {
    let id_ptr = unsafe { device.GetId() }
        .map_err(|e| hr_msg("读取输入设备 ID 失败", e.code()))?;

    let id = unsafe { id_ptr.to_string() }
        .map_err(|e| format!("输入设备 ID 转字符串失败: {e}"))?;

    unsafe {
        CoTaskMemFree(Some(id_ptr.as_ptr() as *const std::ffi::c_void));
    }

    Ok(id)
}

#[cfg(target_os = "windows")]
fn get_device_friendly_name(device: &IMMDevice) -> Result<String, String> {
    let store = unsafe { device.OpenPropertyStore(STGM_READ) }
        .map_err(|e| hr_msg("打开设备属性失败", e.code()))?;

    // windows crate 0.52 的 IPropertyStore::GetValue 是“返回 PROPVARIANT”的写法，
    // 不是 Win32 C API 的“传入 &mut PROPVARIANT”写法。
    let mut prop = unsafe { store.GetValue(&PKEY_Device_FriendlyName) }
        .map_err(|e| hr_msg("读取设备 FriendlyName 失败", e.code()))?;

    let result = (|| -> Result<String, String> {
        let vt = unsafe { prop.Anonymous.Anonymous.vt };
        if vt != VT_LPWSTR {
            return Err(format!("设备 FriendlyName 类型不是 VT_LPWSTR，实际 vt={:?}", vt));
        }

        let name_ptr = unsafe { prop.Anonymous.Anonymous.Anonymous.pwszVal };
        if name_ptr.is_null() {
            return Err("设备 FriendlyName 为空".into());
        }

        let name = unsafe { name_ptr.to_string() }
            .map_err(|e| format!("设备 FriendlyName 转 Rust 字符串失败: {e}"))?;

        Ok(name.trim().to_string())
    })();

    unsafe {
        let _ = PropVariantClear(&mut prop);
    }

    result
}

#[cfg(target_os = "windows")]
fn short_device_suffix(id: &str) -> String {
    if id.is_empty() {
        return String::new();
    }

    // Endpoint ID 很长，界面只显示类似 (35bb:a164) 的短后缀，便于区分同名设备。
    let compact: String = id.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    if compact.len() >= 8 {
        let tail = &compact[compact.len() - 8..];
        format!(" ({}:{})", &tail[..4], &tail[4..])
    } else {
        String::new()
    }
}

#[tauri::command]
#[cfg(not(target_os = "windows"))]
fn list_capture_devices() -> Result<Vec<AudioDeviceInfo>, String> {
    Err("当前平台不支持 Rust 麦克风设备枚举，仅 Windows 可用".into())
}

#[cfg(target_os = "windows")]
fn query_mix_sample_rate() -> Result<u32, String> {
    let mut should_uninit = false;
    match unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) } {
        Ok(()) => {
            should_uninit = true;
        }
        Err(e) if e.code() == HRESULT(0x80010106u32 as i32) => {}
        Err(e) => return Err(hr_msg("查询采样率时 CoInitializeEx 失败", e.code())),
    }

    let result = (|| -> Result<u32, String> {
        let device = get_default_render_device()?;
        let client: IAudioClient = match unsafe { device.Activate(CLSCTX_ALL, None) } {
            Ok(v) => v,
            Err(e) => return Err(hr_msg("查询采样率时 Activate(dummy_client) 失败", e.code())),
        };

        let mix_format_ptr = match unsafe { client.GetMixFormat() } {
            Ok(v) => v,
            Err(e) => return Err(hr_msg("查询采样率时 GetMixFormat 失败", e.code())),
        };

        let sample_rate = unsafe { (*mix_format_ptr).nSamplesPerSec };
        unsafe { CoTaskMemFree(Some(mix_format_ptr as *const std::ffi::c_void)) };
        Ok(sample_rate)
    })();

    if should_uninit {
        unsafe { CoUninitialize() };
    }

    result
}

#[cfg(not(target_os = "windows"))]
fn query_mix_sample_rate() -> Result<u32, String> {
    Err("当前平台不支持采样率查询，仅 Windows 可用".into())
}

async fn start_audio_pump(
    capture_tx: broadcast::Sender<Vec<u32>>,
    latest_capture_pids: Arc<Mutex<Vec<u32>>>,
) {
    let addr = "127.0.0.1:9001";
    // 建立本地服务
    let listener = match TcpListener::bind(&addr).await {
        Ok(v) => v,
        Err(e) => {
            println!("❌ 无法绑定 9001 端口: {e}");
            return;
        }
    };
    println!("🎧 音频专属高铁已发车，监听端口: {}", addr);

    // 死循环：等待前端大厅来连接
    while let Ok((stream, _)) = listener.accept().await {
        let mut pid_rx = capture_tx.subscribe();
        let latest_capture_pids_ref = latest_capture_pids.clone();
        tokio::spawn(async move {
            let mut ws_stream = match accept_async(stream).await {
                Ok(v) => v,
                Err(e) => {
                    println!("❌ WebSocket 握手失败: {e}");
                    return;
                }
            };
            println!(
                "✅ 前端 JS 已连接音频 WebSocket，等待 start_capture/start_capture_multi 指令..."
            );

            let mut pending_pids: Option<Vec<u32>> = match latest_capture_pids_ref.lock() {
                Ok(guard) if !guard.is_empty() => Some(guard.clone()),
                _ => None,
            };

            loop {
                let pids = if let Some(v) = pending_pids.take() {
                    v
                } else {
                    match pid_rx.recv().await {
                        Ok(v) => v,
                        Err(e) => {
                            println!("⚠️ 接收采集 PID 失败: {e}");
                            break;
                        }
                    }
                };

                if pids.is_empty() {
                    continue;
                }

                println!("🚀 准备启动 WASAPI 多进程捕获, pids={:?}", pids);

                let mut pcm_rxs = Vec::new();
                let mut stop_txs = Vec::new();
                let mut capture_handles = Vec::new();

                for pid in &pids {
                    let (pcm_tx, pcm_rx) = mpsc::channel::<Vec<u8>>(64);
                    let (stop_tx, stop_rx) = std_mpsc::channel::<()>();
                    let capture_pid = *pid;
                    let capture_handle = tokio::task::spawn_blocking(move || {
                        run_capture_for_pid(capture_pid, pcm_tx, stop_rx)
                    });

                    pcm_rxs.push(pcm_rx);
                    stop_txs.push(stop_tx);
                    capture_handles.push(capture_handle);
                }

                let mut closed_flags = vec![false; pcm_rxs.len()];
                let mut pending_samples = vec![VecDeque::<f32>::new(); pcm_rxs.len()];
                const MIX_BLOCK_SAMPLES: usize = 480;

                let mut should_restart = false;
                let mut should_exit = false;

                loop {
                    let mut has_new_data = false;

                    for (index, rx) in pcm_rxs.iter_mut().enumerate() {
                        if closed_flags[index] {
                            continue;
                        }

                        loop {
                            match rx.try_recv() {
                                Ok(chunk) => {
                                    append_f32_samples_from_bytes(
                                        &mut pending_samples[index],
                                        &chunk,
                                    );
                                    has_new_data = true;
                                }
                                Err(mpsc::error::TryRecvError::Empty) => break,
                                Err(mpsc::error::TryRecvError::Disconnected) => {
                                    closed_flags[index] = true;
                                    break;
                                }
                            }
                        }
                    }

                    let active_indices: Vec<usize> = closed_flags
                        .iter()
                        .enumerate()
                        .filter_map(|(idx, closed)| if !*closed { Some(idx) } else { None })
                        .collect();

                    if active_indices.is_empty() {
                        break;
                    }

                    let min_available = active_indices
                        .iter()
                        .map(|idx| pending_samples[*idx].len())
                        .min()
                        .unwrap_or(0);

                    if min_available >= MIX_BLOCK_SAMPLES {
                        let mut mixed_chunk = Vec::with_capacity(MIX_BLOCK_SAMPLES * 4);

                        for _ in 0..MIX_BLOCK_SAMPLES {
                            let mut sum = 0.0f32;
                            let mut count = 0usize;

                            for idx in &active_indices {
                                if let Some(sample) = pending_samples[*idx].pop_front() {
                                    sum += sample;
                                    count += 1;
                                }
                            }

                            let mixed_sample = if count == 0 {
                                0.0
                            } else {
                                (sum / count as f32).clamp(-1.0, 1.0)
                            };
                            mixed_chunk.extend_from_slice(&mixed_sample.to_le_bytes());
                        }

                        if ws_stream
                            .send(Message::Binary(mixed_chunk.into()))
                            .await
                            .is_err()
                        {
                            println!("⚠️ 前端断开连接，停止音频推流");
                            should_exit = true;
                            break;
                        }
                    }

                    if closed_flags.iter().all(|v| *v) {
                        break;
                    }

                    // 非阻塞检查：如果用户再次调用 start_capture/start_capture_multi，立即切换目标 PID 列表。
                    match pid_rx.try_recv() {
                        Ok(new_pids) => {
                            println!("🔁 收到新的 PID 列表指令，切换采集目标: {:?}", new_pids);
                            pending_pids = Some(new_pids);
                            should_restart = true;
                            break;
                        }
                        Err(broadcast::error::TryRecvError::Empty) => {}
                        Err(broadcast::error::TryRecvError::Closed) => {
                            println!("⚠️ PID 控制通道已关闭，停止捕获");
                            should_exit = true;
                            break;
                        }
                        Err(broadcast::error::TryRecvError::Lagged(skipped)) => {
                            println!("⚠️ PID 控制消息积压，跳过 {skipped} 条，仅使用最新 PID 列表");
                        }
                    }

                    if min_available < MIX_BLOCK_SAMPLES && !has_new_data {
                        tokio::time::sleep(std::time::Duration::from_millis(2)).await;
                    }
                }

                for stop_tx in &stop_txs {
                    let _ = stop_tx.send(());
                }

                for handle in capture_handles {
                    match handle.await {
                        Ok(Ok(())) => {}
                        Ok(Err(e)) => println!("⚠️ WASAPI 捕获线程结束: {e}"),
                        Err(e) => println!("⚠️ WASAPI 捕获任务 Join 失败: {e}"),
                    }
                }

                if should_exit {
                    return;
                }

                if should_restart {
                    continue;
                }

                // 当前捕获自然结束后，等待下一次 start_capture(pid)
            }
        });
    }
}

async fn start_mic_pump(
    app_handle: tauri::AppHandle,
    state_running: Arc<Mutex<bool>>,
    state_threshold: Arc<Mutex<f32>>,
    state_boost: Arc<Mutex<f32>>, // 👈 接收增益参数
    selected_mic_device_id: Arc<Mutex<Option<String>>>,
) {
    let addr = "127.0.0.1:9002"; // 🌟 麦克风专属 9002 端口
    let listener = match TcpListener::bind(&addr).await {
        Ok(v) => v,
        Err(e) => {
            println!("❌ 麦克风 9002 端口绑定失败: {}", e);
            return;
        }
    };
    println!("🎙️ 麦克风监听开启，监听端口: {}", addr);

    while let Ok((stream, _)) = listener.accept().await {
        let app_handle_clone = app_handle.clone();
        let running_clone = state_running.clone();
        let threshold_clone = state_threshold.clone();
        let boost_clone = state_boost.clone(); // 👈 核心修复：克隆增益状态
        let selected_mic_device_id_clone = selected_mic_device_id.clone();

        tokio::spawn(async move {
            let mut ws_stream = match accept_async(stream).await {
                Ok(v) => v,
                Err(_) => return,
            };

            let (pcm_tx, mut pcm_rx) = mpsc::channel::<Vec<u8>>(64);

            // 启动 Windows 底层捕获线程
            let app_handle_for_capture = app_handle_clone.clone();
            let app_handle_for_error = app_handle_clone.clone();
            let running_for_capture = running_clone.clone();
            let running_for_cleanup = running_clone.clone();
            let threshold_for_capture = threshold_clone.clone();
            let boost_for_capture = boost_clone.clone();
            let selected_mic_device_id_for_capture = selected_mic_device_id_clone.clone();

            let capture_handle = tokio::task::spawn_blocking(move || {
                run_mic_capture(
                    app_handle_for_capture,
                    running_for_capture,
                    threshold_for_capture,
                    boost_for_capture,
                    selected_mic_device_id_for_capture,
                    pcm_tx,
                )
            });

            // 持续向前端 9002 端口推送处理好的音频流
            while let Some(chunk) = pcm_rx.recv().await {
                if ws_stream.send(Message::Binary(chunk.into())).await.is_err() {
                    println!("⚠️ 前端麦克风 WebSocket 断开，准备停止 Rust 麦克风捕获");
                    break;
                }
            }

            if let Ok(mut guard) = running_for_cleanup.lock() {
                *guard = false;
            }

            match capture_handle.await {
                Ok(Ok(())) => {
                    println!("✅ Rust 麦克风捕获线程已正常结束");
                }
                Ok(Err(e)) => {
                    println!("❌ Rust 麦克风捕获失败: {e}");
                    let _ = app_handle_for_error.emit("mic_error", e);
                }
                Err(e) => {
                    println!("❌ Rust 麦克风线程 Join 失败: {e}");
                    let _ = app_handle_for_error.emit("mic_error", e.to_string());
                }
            }
        });
    }
}

#[cfg(target_os = "windows")]
#[implement(IActivateAudioInterfaceCompletionHandler)]
struct ActivateAudioInterfaceHandler {
    tx: StdMutex<Option<std_mpsc::Sender<Result<IAudioClient, WinError>>>>,
}

#[cfg(target_os = "windows")]
impl ActivateAudioInterfaceHandler {
    fn new(tx: std_mpsc::Sender<Result<IAudioClient, WinError>>) -> Self {
        Self {
            tx: StdMutex::new(Some(tx)),
        }
    }

    fn send_once(&self, value: Result<IAudioClient, WinError>) {
        if let Ok(mut guard) = self.tx.lock() {
            if let Some(tx) = guard.take() {
                let _ = tx.send(value);
            }
        }
    }
}

#[cfg(target_os = "windows")]
impl IActivateAudioInterfaceCompletionHandler_Impl for ActivateAudioInterfaceHandler {
    fn ActivateCompleted(
        &self,
        activateoperation: Option<&IActivateAudioInterfaceAsyncOperation>,
    ) -> windows::core::Result<()> {
        let result = (|| -> Result<IAudioClient, WinError> {
            let op = activateoperation.ok_or_else(|| {
                WinError::new(
                    HRESULT(0x80004005u32 as i32),
                    HSTRING::from("activateoperation 为空"),
                )
            })?;

            let mut activate_hr = HRESULT(0);
            let mut activated: Option<IUnknown> = None;
            unsafe { op.GetActivateResult(&mut activate_hr, &mut activated)? };
            activate_hr.ok()?;

            let unknown = activated.ok_or_else(|| {
                WinError::new(
                    HRESULT(0x80004005u32 as i32),
                    HSTRING::from("未返回激活接口"),
                )
            })?;

            unknown.cast::<IAudioClient>()
        })();

        self.send_once(result);
        Ok(())
    }
}

#[cfg(target_os = "windows")]
fn activate_process_loopback_audio_client(pid: u32) -> Result<IAudioClient, String> {
    let activation_params = AUDIOCLIENT_ACTIVATION_PARAMS {
        ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
        Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
            ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                TargetProcessId: pid,
                ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
            },
        },
    };

    let blob = BLOB {
        cbSize: std::mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
        pBlobData: (&activation_params as *const AUDIOCLIENT_ACTIVATION_PARAMS) as *mut u8,
    };

    let prop = PROPVARIANT {
        Anonymous: PROPVARIANT_0 {
            Anonymous: std::mem::ManuallyDrop::new(PROPVARIANT_0_0 {
                vt: VT_BLOB,
                wReserved1: 0,
                wReserved2: 0,
                wReserved3: 0,
                Anonymous: PROPVARIANT_0_0_0 { blob },
            }),
        },
    };

    let (tx, rx) = std_mpsc::channel::<Result<IAudioClient, WinError>>();
    let handler: IActivateAudioInterfaceCompletionHandler =
        ActivateAudioInterfaceHandler::new(tx).into();

    let op = unsafe {
        ActivateAudioInterfaceAsync(
            VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
            &IAudioClient::IID,
            Some(&prop as *const _),
            &handler,
        )
    };

    match op {
        Ok(_) => {}
        Err(e) => return Err(hr_msg("ActivateAudioInterfaceAsync 调用失败", e.code())),
    }

    match rx.recv_timeout(Duration::from_secs(5)) {
        Ok(Ok(client)) => Ok(client),
        Ok(Err(e)) => Err(hr_msg("进程回环接口激活回调失败", e.code())),
        Err(e) => Err(format!("等待进程回环激活回调超时/失败: {e}")),
    }
}

#[cfg(target_os = "windows")]
fn get_default_render_device() -> Result<IMMDevice, String> {
    // 第一步：先拿默认渲染设备 IMMDevice。
    let enumerator: IMMDeviceEnumerator =
        match unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) } {
            Ok(v) => v,
            Err(e) => return Err(hr_msg("创建 IMMDeviceEnumerator 失败", e.code())),
        };

    match unsafe { enumerator.GetDefaultAudioEndpoint(eRender, eMultimedia) } {
        Ok(v) => Ok(v),
        Err(e) => Err(hr_msg("GetDefaultAudioEndpoint 失败", e.code())),
    }
}

#[cfg(target_os = "windows")]
fn activate_process_loopback_client(pid: u32) -> Result<(IAudioClient, *mut WAVEFORMATEX), String> {
    let device = get_default_render_device()?;

    // 第二步：普通模式激活 dummy_client，专门用于获取系统混音格式。
    let dummy_client: IAudioClient = match unsafe { device.Activate(CLSCTX_ALL, None) } {
        Ok(v) => v,
        Err(e) => return Err(hr_msg("普通模式 Activate(dummy_client) 失败", e.code())),
    };

    let mix_format_ptr = match unsafe { dummy_client.GetMixFormat() } {
        Ok(v) => v,
        Err(e) => return Err(hr_msg("dummy_client.GetMixFormat 失败", e.code())),
    };

    // 第三/四步：用官方进程回环虚拟设备路径 + PID 参数激活真正 loopback client。
    let loopback_client = activate_process_loopback_audio_client(pid)?;

    Ok((loopback_client, mix_format_ptr))
}

#[cfg(target_os = "windows")]
fn hr_hex(code: windows::core::HRESULT) -> String {
    format!("0x{:08X}", code.0 as u32)
}

#[cfg(target_os = "windows")]
fn hr_msg(context: &str, code: windows::core::HRESULT) -> String {
    format!("{context}, HRESULT={}", hr_hex(code))
}

#[cfg(target_os = "windows")]
const DEVICE_INVALIDATED_TAG: &str = "__AUDCLNT_E_DEVICE_INVALIDATED__";

#[cfg(target_os = "windows")]
fn device_invalidated_err(context: &str) -> String {
    format!("{DEVICE_INVALIDATED_TAG} {context}")
}

#[cfg(target_os = "windows")]
fn is_device_invalidated_err(err: &str) -> bool {
    err.contains(DEVICE_INVALIDATED_TAG)
}

fn append_f32_samples_from_bytes(queue: &mut VecDeque<f32>, chunk: &[u8]) {
    for bytes in chunk.chunks_exact(4) {
        let sample = f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
        queue.push_back(sample);
    }
}

#[cfg(target_os = "windows")]
fn run_capture_for_pid(
    pid: u32,
    pcm_tx: mpsc::Sender<Vec<u8>>,
    stop_rx: std_mpsc::Receiver<()>,
) -> Result<(), String> {
    // WASAPI/COM 必须在线程内初始化；spawn_blocking 正好给我们一个稳定线程。
    match unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) } {
        Ok(()) => {}
        Err(e) => return Err(hr_msg("CoInitializeEx 失败", e.code())),
    }

    let mut recover_attempt = 0u32;
    let result = loop {
        match stop_rx.try_recv() {
            Ok(_) | Err(std_mpsc::TryRecvError::Disconnected) => break Ok(()),
            Err(std_mpsc::TryRecvError::Empty) => {}
        }

        match run_capture_for_pid_inner(pid, &pcm_tx, &stop_rx) {
            Ok(()) => break Ok(()),
            Err(e) if is_device_invalidated_err(&e) => {
                recover_attempt = recover_attempt.saturating_add(1);
                let backoff_ms = (50u64.saturating_mul(1u64 << recover_attempt.min(5))).min(1000);
                println!(
                    "⚠️ 检测到音频设备失效，准备自动重建捕获会话 (attempt={}, backoff={}ms)",
                    recover_attempt, backoff_ms
                );

                let _ = pcm_tx.blocking_send(vec![0u8; 480 * std::mem::size_of::<f32>()]);

                std::thread::sleep(Duration::from_millis(backoff_ms));
                continue;
            }
            Err(e) => break Err(e),
        }
    };

    unsafe { CoUninitialize() };
    result
}

#[cfg(target_os = "windows")]
fn get_default_capture_device() -> Result<IMMDevice, String> {
    let enumerator: IMMDeviceEnumerator =
        match unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) } {
            Ok(v) => v,
            Err(e) => return Err(hr_msg("创建 IMMDeviceEnumerator 失败", e.code())),
        };
    // 核心区别：这里用 eCapture 拿系统默认麦克风
    match unsafe { enumerator.GetDefaultAudioEndpoint(eCapture, eMultimedia) } {
        Ok(v) => Ok(v),
        Err(e) => Err(hr_msg("获取默认麦克风失败", e.code())),
    }
}

#[cfg(target_os = "windows")]
fn get_communications_capture_device() -> Result<IMMDevice, String> {
    let enumerator: IMMDeviceEnumerator =
        unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }
            .map_err(|e| hr_msg("创建 IMMDeviceEnumerator 失败", e.code()))?;

    unsafe { enumerator.GetDefaultAudioEndpoint(eCapture, eCommunications) }
        .map_err(|e| hr_msg("获取通信默认麦克风失败", e.code()))
}

#[cfg(target_os = "windows")]
fn get_capture_device_by_id(device_id: &str) -> Result<IMMDevice, String> {
    let enumerator: IMMDeviceEnumerator =
        unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }
            .map_err(|e| hr_msg("创建 IMMDeviceEnumerator 失败", e.code()))?;

    let wide: Vec<u16> = device_id.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe { enumerator.GetDevice(PCWSTR(wide.as_ptr())) }
        .map_err(|e| hr_msg(&format!("根据设备 ID 获取麦克风失败: {device_id}"), e.code()))
}

#[cfg(target_os = "windows")]
fn get_configured_capture_device(
    selected_mic_device_id: &Arc<Mutex<Option<String>>>,
) -> Result<IMMDevice, String> {
    let selected = selected_mic_device_id
        .lock()
        .ok()
        .and_then(|guard| guard.clone());

    match selected {
        Some(device_id) if device_id == "__communications__" => get_communications_capture_device(),
        Some(device_id) if !device_id.trim().is_empty() => get_capture_device_by_id(&device_id),
        _ => get_default_capture_device(),
    }
}

/*#[cfg(target_os = "windows")]  用了Rnnnoise
fn run_mic_capture(
    app_handle: tauri::AppHandle,
    state_running: Arc<Mutex<bool>>,
    state_threshold: Arc<Mutex<f32>>,
    state_boost: Arc<Mutex<f32>>,
    selected_mic_device_id: Arc<Mutex<Option<String>>>,
    pcm_tx: mpsc::Sender<Vec<u8>>,
) -> Result<(), String> {
    let mut should_uninit = false;
    match unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) } {
        Ok(()) => {
            should_uninit = true;
        }
        Err(e) if e.code() == HRESULT(0x80010106u32 as i32) => {
            // RPC_E_CHANGED_MODE: 当前线程已用其他模式初始化过 COM，可继续使用，但不要 CoUninitialize
        }
        Err(e) => {
            return Err(hr_msg("初始化 COM 失败", e.code()));
        }
    }

    let result = (|| -> Result<(), String> {
        let device = get_configured_capture_device(&selected_mic_device_id)?;
        let audio_client: IAudioClient = match unsafe { device.Activate(CLSCTX_ALL, None) } {
            Ok(v) => v,
            Err(e) => return Err(hr_msg("激活麦克风 IAudioClient 失败", e.code())),
        };

        let mix_format_ptr = match unsafe { audio_client.GetMixFormat() } {
            Ok(v) => v,
            Err(e) => return Err(hr_msg("获取麦克风格式失败", e.code())),
        };

        let channels = unsafe { (*mix_format_ptr).nChannels };
        let src_channels = if channels == 0 {
            1usize
        } else {
            channels as usize
        };

        let init_result = unsafe {
            audio_client.Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                0,
                0,
                0,
                mix_format_ptr as *const WAVEFORMATEX,
                None,
            )
        };

        unsafe { CoTaskMemFree(Some(mix_format_ptr as *const std::ffi::c_void)) };

        if let Err(e) = init_result {
            return Err(hr_msg("初始化麦克风失败", e.code()));
        }

        let capture_client: IAudioCaptureClient = match unsafe { audio_client.GetService() } {
            Ok(v) => v,
            Err(e) => return Err(hr_msg("获取麦克风捕获服务失败", e.code())),
        };

        unsafe { audio_client.Start() }.map_err(|e| hr_msg("启动麦克风采集失败", e.code()))?;
        println!("Rust 麦克风接管已启动!");

        // 低延迟软噪声门：避免阈值附近硬切导致“滋滋啦啦/断断续续”。
        // 不做 AI 降噪，只做每个音频块的平滑开关，因此几乎不增加语音延迟。
        let mut gate_gain = 0.0f32;
        const GATE_ATTACK: f32 = 0.65;
        const GATE_RELEASE: f32 = 0.08;
        const GATE_FLOOR: f32 = 0.015;
        const GATE_HYSTERESIS_PERCENT: f32 = 4.0;

        loop {
            // 安全退出检查
            if let Ok(guard) = state_running.lock() {
                if !*guard {
                    break;
                }
            } else {
                break;
            }

            let packet_frames = match unsafe { capture_client.GetNextPacketSize() } {
                Ok(v) => v,
                Err(e) if e.code() == AUDCLNT_E_DEVICE_INVALIDATED => {
                    return Err(device_invalidated_err("GetNextPacketSize: 音频设备失效"));
                }
                Err(e) => {
                    return Err(format!(
                        "GetNextPacketSize 失败, HRESULT={}",
                        hr_hex(e.code())
                    ))
                }
            };

            if packet_frames == 0 {
                std::thread::sleep(Duration::from_millis(2));
                continue;
            }

            let mut data_ptr: *mut u8 = std::ptr::null_mut();
            let mut frames_to_read: u32 = 0;
            let mut flags: u32 = 0;

            let get_buffer_result = unsafe {
                capture_client.GetBuffer(&mut data_ptr, &mut frames_to_read, &mut flags, None, None)
            };

            if let Err(e) = get_buffer_result {
                return Err(if e.code() == AUDCLNT_E_DEVICE_INVALIDATED {
                    device_invalidated_err("GetBuffer: 音频设备失效")
                } else {
                    format!(
                        "IAudioCaptureClient::GetBuffer 失败, HRESULT={}",
                        hr_hex(e.code())
                    )
                });
            }

            let mut should_stop = false;
            let payload: Vec<u8>;
            let output_bytes = (frames_to_read as usize).saturating_mul(std::mem::size_of::<f32>());

            if frames_to_read > 0 {
                if data_ptr.is_null() || (flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0 {
                    payload = vec![0u8; output_bytes];
                } else {
                    let expected_samples = match (frames_to_read as usize).checked_mul(src_channels)
                    {
                        Some(v) => v,
                        None => {
                            if let Err(e) = unsafe { capture_client.ReleaseBuffer(frames_to_read) }
                            {
                                return Err(format!(
                                    "samples 计算溢出时 ReleaseBuffer 失败, HRESULT={}",
                                    hr_hex(e.code())
                                ));
                            }
                            return Err(format!(
                                "检测到异常 samples 大小: frames_to_read={}, channels={}",
                                frames_to_read, src_channels
                            ));
                        }
                    };

                    let f32_slice = unsafe {
                        std::slice::from_raw_parts(data_ptr as *const f32, expected_samples)
                    };
                    let mut mono_samples = Vec::<f32>::with_capacity(frames_to_read as usize);
                    let mut sum_squares = 0.0f32;

                    let boost_multiplier = if let Ok(guard) = state_boost.lock() {
                        *guard
                    } else {
                        1.0
                    };

                    for i in 0..frames_to_read as usize {
                        let frame_start = i * src_channels;
                        let left = f32_slice[frame_start];
                        let right = if src_channels > 1 {
                            f32_slice[frame_start + 1]
                        } else {
                            left
                        };
                        let mut mono = ((left + right) / 2.0) * boost_multiplier;
                        mono = mono.clamp(-1.0, 1.0);

                        sum_squares += mono * mono;
                        mono_samples.push(mono);
                    }

                    let rms = (sum_squares / frames_to_read as f32).sqrt();
                    let db = if rms > 0.0001 {
                        20.0 * rms.log10()
                    } else {
                        -100.0
                    };
                    let volume_percent = ((db + 50.0) * 2.0).clamp(0.0, 100.0) as u32;
                    let _ = app_handle.emit("mic_volume", volume_percent);

                    let threshold = if let Ok(guard) = state_threshold.lock() {
                        *guard
                    } else {
                        0.0
                    };

                    // 软门限 + 滞回：
                    // - 音量超过阈值时快速打开；
                    // - 音量略低于阈值时不马上关闭；
                    // - 真正低于关闭阈值时缓慢释放，避免断续噪声。
                    let open_threshold = threshold;
                    let close_threshold = (threshold - GATE_HYSTERESIS_PERCENT).max(0.0);
                    let volume = volume_percent as f32;
                    let should_open = volume >= open_threshold
                        || (gate_gain > GATE_FLOOR && volume >= close_threshold);

                    let target_gain = if should_open { 1.0 } else { 0.0 };
                    let coeff = if target_gain > gate_gain {
                        GATE_ATTACK
                    } else {
                        GATE_RELEASE
                    };
                    gate_gain += (target_gain - gate_gain) * coeff;

                    if gate_gain < GATE_FLOOR {
                        payload = vec![0u8; output_bytes];
                    } else {
                        let mut gated_data = Vec::<u8>::with_capacity(output_bytes);
                        for sample in mono_samples {
                            let gated = (sample * gate_gain).clamp(-1.0, 1.0);
                            gated_data.extend_from_slice(&gated.to_le_bytes());
                        }
                        payload = gated_data;
                    }
                }

                if pcm_tx.blocking_send(payload).is_err() {
                    should_stop = true;
                }
            }

            if let Err(e) = unsafe { capture_client.ReleaseBuffer(frames_to_read) } {
                return Err(hr_msg("释放麦克风 Buffer 失败", e.code()));
            }

            if should_stop {
                break;
            }

            let next_packet_frames = match unsafe { capture_client.GetNextPacketSize() } {
                Ok(v) => v,
                Err(e) if e.code() == AUDCLNT_E_DEVICE_INVALIDATED => {
                    return Err(device_invalidated_err(
                        "GetNextPacketSize(循环): 音频设备失效",
                    ));
                }
                Err(e) => {
                    return Err(format!(
                        "GetNextPacketSize(循环) 失败, HRESULT={}",
                        hr_hex(e.code())
                    ))
                }
            };

            if next_packet_frames == 0 {
                std::thread::sleep(Duration::from_millis(2));
            }
        }

        if let Err(e) = unsafe { audio_client.Stop() } {
            println!("⚠️ audio_client.Stop() 失败: {}", hr_hex(e.code()));
        }

        Ok(())
    })();

    if should_uninit {
        unsafe { CoUninitialize() };
    }

    result
}
*/

#[cfg(target_os = "windows")]
fn run_mic_capture(
    app_handle: tauri::AppHandle,
    state_running: Arc<Mutex<bool>>,
    state_threshold: Arc<Mutex<f32>>,
    state_boost: Arc<Mutex<f32>>,
    selected_mic_device_id: Arc<Mutex<Option<String>>>,
    pcm_tx: mpsc::Sender<Vec<u8>>,
) -> Result<(), String> {
    let mut should_uninit = false;
    match unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) } {
        Ok(()) => {
            should_uninit = true;
        }
        Err(e) if e.code() == HRESULT(0x80010106u32 as i32) => {
            // RPC_E_CHANGED_MODE: 已初始化
        }
        Err(e) => return Err(hr_msg("初始化 COM 失败", e.code())),
    }

    let result = (|| -> Result<(), String> {
        let device = get_configured_capture_device(&selected_mic_device_id)?;
        let audio_client: IAudioClient = match unsafe { device.Activate(CLSCTX_ALL, None) } {
            Ok(v) => v,
            Err(e) => return Err(hr_msg("激活麦克风 IAudioClient 失败", e.code())),
        };

        // 🌟 魔法核心：无论麦克风原生支持什么采样率和通道，强制要求 Windows 吐出 48kHz 单声道
        const WAVE_FORMAT_IEEE_FLOAT: u16 = 3;
        const AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM: u32 = 0x80000000;
        const AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY: u32 = 0x08000000;

        let capture_format = WAVEFORMATEX {
            wFormatTag: WAVE_FORMAT_IEEE_FLOAT,
            nChannels: 1,
            nSamplesPerSec: 48000,
            nAvgBytesPerSec: 48000 * 4,
            nBlockAlign: 4,
            wBitsPerSample: 32,
            cbSize: 0,
        };

        let init_result = unsafe {
            audio_client.Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
                0,
                0,
                &capture_format as *const WAVEFORMATEX,
                None,
            )
        };

        if let Err(e) = init_result {
            return Err(hr_msg("麦克风自动重采样初始化失败", e.code()));
        }

        let capture_client: IAudioCaptureClient = match unsafe { audio_client.GetService() } {
            Ok(v) => v,
            Err(e) => return Err(hr_msg("获取麦克风捕获服务失败", e.code())),
        };

        unsafe { audio_client.Start() }.map_err(|e| hr_msg("启动麦克风采集失败", e.code()))?;
        println!("🎙️ 麦克风已启动: 强制 48kHz 单声道 + RNNoise 神经网络降噪接管!");

        // 🌟 初始化神经网络降噪器 和 样本缓冲区
        let mut denoise = nnnoiseless::DenoiseState::new();
        let mut sample_buffer: Vec<f32> = Vec::with_capacity(1024);

        // 🌟 保留你极其优秀的滞回平滑包络逻辑
        let mut gate_gain = 0.0f32;
        const GATE_ATTACK: f32 = 0.65;
        const GATE_RELEASE: f32 = 0.08;
        const GATE_FLOOR: f32 = 0.015;
        const GATE_HYSTERESIS_PERCENT: f32 = 4.0; 

        loop {
            if let Ok(guard) = state_running.lock() {
                if !*guard {
                    break;
                }
            } else {
                break;
            }

            let packet_frames = match unsafe { capture_client.GetNextPacketSize() } {
                Ok(v) => v,
                Err(e) if e.code() == AUDCLNT_E_DEVICE_INVALIDATED => {
                    return Err(device_invalidated_err("GetNextPacketSize: 音频设备失效"));
                }
                Err(e) => {
                    return Err(format!("GetNextPacketSize 失败, HRESULT={}", hr_hex(e.code())))
                }
            };

            if packet_frames == 0 {
                std::thread::sleep(Duration::from_millis(2));
                continue;
            }

            let mut data_ptr: *mut u8 = std::ptr::null_mut();
            let mut frames_to_read: u32 = 0;
            let mut flags: u32 = 0;

            if let Err(e) = unsafe {
                capture_client.GetBuffer(&mut data_ptr, &mut frames_to_read, &mut flags, None, None)
            } {
                return Err(format!("GetBuffer 失败, HRESULT={}", hr_hex(e.code())));
            }

            let mut should_stop = false;

            if frames_to_read > 0 {
                // 1. 提取原始数据，绝对不要在这里应用增益！
                if !data_ptr.is_null() && (flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) == 0 {
                    let f32_slice = unsafe {
                        std::slice::from_raw_parts(data_ptr as *const f32, frames_to_read as usize)
                    };
                    for &sample in f32_slice {
                        // 只做基本限幅防止溢出，保留原汁原味给 AI
                        sample_buffer.push(sample.clamp(-1.0, 1.0));
                    }
                } else {
                    // 🌟 修复底层陷阱：不用绝对的 0.0，而是注入极其微弱的交变信号 (-100dB)
                    // 防止输入纯 0 导致 RNN 内部能量评估崩溃除以零
                    let mut flip = false;
                    for _ in 0..frames_to_read {
                        let dither = if flip { 1e-6 } else { -1e-6 };
                        flip = !flip;
                        sample_buffer.push(dither);
                    }
                }

                    while sample_buffer.len() >= 480 {
                    let mut in_frame = [0.0f32; 480];
                    // 🌟 核心修复 1：量纲转换
                    // 将 WASAPI 的 [-1.0, 1.0] 放大到 RNNoise 要求的 [-32768.0, 32767.0] 量级
                    for i in 0..480 {
                        in_frame[i] = sample_buffer[i] * 32768.0;
                    }
                    sample_buffer.drain(0..480);

                    // 🧠 核心修复 2：AI 如今终于能听到正常声强的数据了
                    let mut out_frame = [0.0f32; 480];
                    let mut vad_prob = denoise.process_frame(&mut out_frame, &in_frame);
                    if vad_prob.is_nan() { vad_prob = 0.0; } 

                    // 🔊 核心修复 3：将 AI 吐出的数据除以 32768.0，还原回系统标准的 [-1.0, 1.0]
                    let boost_multiplier = if let Ok(guard) = state_boost.lock() { *guard } else { 1.0 };
                    let mut sum_squares = 0.0f32;
                    
                    for x in out_frame.iter_mut() {
                        if x.is_nan() || !x.is_finite() { *x = 0.0; }
                        *x = (*x / 32768.0 * boost_multiplier).clamp(-1.0, 1.0);
                        sum_squares += (*x) * (*x);
                    }

                    // 📊 计算音量推给绿条（依然基于合法的 [-1.0, 1.0] 体系）
                    let rms = (sum_squares / 480.0).sqrt();
                    let db = if rms > 0.0001 { 20.0 * rms.log10() } else { -100.0 };
                    let volume_percent = ((db + 50.0) * 2.0).clamp(0.0, 100.0) as u32;

                    let _ = app_handle.emit("mic_volume", volume_percent);

                    // ==========================================
                    // 🛡️ 物理滞回门限 + AI 概率双重锁
                    // ==========================================
                    let threshold = if let Ok(guard) = state_threshold.lock() { *guard } else { 0.0 };
                    let close_threshold = (threshold - GATE_HYSTERESIS_PERCENT).max(0.0);
                    let volume = volume_percent as f32;

                    let volume_ok = volume >= threshold
                        || (gate_gain > GATE_FLOOR && volume >= close_threshold);

                    // 此时 vad_prob 终于能正确反映人声概率了
                    let is_voice = vad_prob > 0.15; 
                    let should_open = volume_ok && (is_voice || gate_gain > GATE_FLOOR);

                    let target_gain = if should_open { 1.0 } else { 0.0 };
                    let coeff = if target_gain > gate_gain { GATE_ATTACK } else { GATE_RELEASE };
                    gate_gain += (target_gain - gate_gain) * coeff;

                    let payload = if gate_gain < GATE_FLOOR {
                        vec![0u8; 480 * 4] 
                    } else {
                        let mut gated_data = Vec::with_capacity(480 * 4);
                        for x in out_frame {
                            let gated = (x * gate_gain).clamp(-1.0, 1.0);
                            gated_data.extend_from_slice(&gated.to_le_bytes());
                        }
                        gated_data
                    };

                    // 非阻塞发送
                    match pcm_tx.try_send(payload) {
                        Ok(()) => {} // 发送成功
                        Err(tokio::sync::mpsc::error::TrySendError::Full(_)) => {
                            // 通道满了，直接丢弃当前帧，绝不阻塞采集线程
                        }
                        Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => {
                            // 只有前端 WebSocket 真正断开时，才停止采集
                            should_stop = true;
                            break;
                        }
                    }
                }
            }

            if let Err(e) = unsafe { capture_client.ReleaseBuffer(frames_to_read) } {
                return Err(hr_msg("释放麦克风 Buffer 失败", e.code()));
            }

            if should_stop {
                break;
            }
        }

        let _ = unsafe { audio_client.Stop() };
        Ok(())
    })();

    if should_uninit {
        unsafe { CoUninitialize() };
    }

    result
}

#[cfg(target_os = "windows")]
fn run_capture_for_pid_inner(
    pid: u32,
    pcm_tx: &mpsc::Sender<Vec<u8>>,
    stop_rx: &std_mpsc::Receiver<()>,
) -> Result<(), String> {
    let (audio_client, mix_format_ptr) = activate_process_loopback_client(pid)?;

    let sample_rate = unsafe { (*mix_format_ptr).nSamplesPerSec };
    let channels = unsafe { (*mix_format_ptr).nChannels };
    let bits_per_sample = unsafe { (*mix_format_ptr).wBitsPerSample };
    let format_tag = unsafe { (*mix_format_ptr).wFormatTag };
    println!(
        "🎛️ WASAPI MixFormat: sampleRate={}Hz, channels={}, bitsPerSample={}, formatTag=0x{:04X}",
        sample_rate, channels, bits_per_sample, format_tag
    );

    // 进程回环激活的客户端初始化时使用 LOOPBACK 标志。
    let src_channels = if channels == 0 {
        1usize
    } else {
        channels as usize
    };

    let init_result = unsafe {
        audio_client.Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_LOOPBACK,
            0,
            0,
            mix_format_ptr as *const WAVEFORMATEX,
            None,
        )
    };

    // GetMixFormat 返回的内存由 COM 分配，必须释放。
    unsafe { CoTaskMemFree(Some(mix_format_ptr as *const std::ffi::c_void)) };

    match init_result {
        Ok(()) => {}
        Err(e) => return Err(hr_msg("IAudioClient::Initialize 失败", e.code())),
    }

    let capture_client: IAudioCaptureClient = match unsafe { audio_client.GetService() } {
        Ok(v) => v,
        Err(e) if e.code() == AUDCLNT_E_WRONG_ENDPOINT_TYPE => {
            return Err(format!(
                "GetService<IAudioCaptureClient> 失败: WRONG_ENDPOINT_TYPE ({}). 通常表示拿到的不是捕获端 IAudioClient，请检查进程回环激活链路",
                hr_hex(e.code())
            ));
        }
        Err(e) => return Err(hr_msg("GetService<IAudioCaptureClient> 失败", e.code())),
    };

    match unsafe { audio_client.Start() } {
        Ok(()) => {}
        Err(e) => return Err(hr_msg("IAudioClient::Start 失败", e.code())),
    }

    loop {
        // 来自前端的新 PID 会通过异步层发送 stop 信号进来。
        match stop_rx.try_recv() {
            Ok(_) | Err(std_mpsc::TryRecvError::Disconnected) => {
                break;
            }
            Err(std_mpsc::TryRecvError::Empty) => {}
        }

        let mut packet_frames = match unsafe { capture_client.GetNextPacketSize() } {
            Ok(v) => v,
            Err(e) if e.code() == AUDCLNT_E_DEVICE_INVALIDATED => {
                return Err(device_invalidated_err("GetNextPacketSize: 音频设备失效"));
            }
            Err(e) => {
                return Err(format!(
                    "GetNextPacketSize 失败, HRESULT={}",
                    hr_hex(e.code())
                ))
            }
        };

        if packet_frames == 0 {
            std::thread::sleep(Duration::from_millis(2));
            continue;
        }

        while packet_frames > 0 {
            let mut data_ptr: *mut u8 = std::ptr::null_mut();
            let mut frames_to_read: u32 = 0;
            let mut flags: u32 = 0;

            match unsafe {
                capture_client.GetBuffer(&mut data_ptr, &mut frames_to_read, &mut flags, None, None)
            } {
                Ok(()) => {}
                Err(e) if e.code() == AUDCLNT_E_DEVICE_INVALIDATED => {
                    return Err(device_invalidated_err("GetBuffer: 音频设备失效"));
                }
                Err(e) => {
                    return Err(format!(
                        "IAudioCaptureClient::GetBuffer 失败, HRESULT={}",
                        hr_hex(e.code())
                    ))
                }
            }

            // 防御 1：frames==0 时不做任何切片读取，按规范归还空缓冲后继续。
            if frames_to_read == 0 {
                if let Err(e) = unsafe { capture_client.ReleaseBuffer(0) } {
                    return Err(hr_msg(
                        "IAudioCaptureClient::ReleaseBuffer(0) 失败",
                        e.code(),
                    ));
                }

                packet_frames = match unsafe { capture_client.GetNextPacketSize() } {
                    Ok(v) => v,
                    Err(e) if e.code() == AUDCLNT_E_DEVICE_INVALIDATED => {
                        return Err(device_invalidated_err(
                            "GetNextPacketSize(循环): 音频设备失效",
                        ));
                    }
                    Err(e) => {
                        return Err(format!(
                            "GetNextPacketSize(循环) 失败, HRESULT={}",
                            hr_hex(e.code())
                        ))
                    }
                };
                continue;
            }

            let output_bytes = (frames_to_read as usize).saturating_mul(std::mem::size_of::<f32>());

            // 防御 2：静音包或空指针包严禁 from_raw_parts，直接填零维持时间轴。
            let payload = if data_ptr.is_null()
                || (flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0
            {
                vec![0u8; output_bytes]
            } else {
                let expected_samples = match (frames_to_read as usize).checked_mul(src_channels) {
                    Some(v) => v,
                    None => {
                        if let Err(e) = unsafe { capture_client.ReleaseBuffer(frames_to_read) } {
                            return Err(format!(
                                "samples 计算溢出时 ReleaseBuffer 失败, HRESULT={}",
                                hr_hex(e.code())
                            ));
                        }
                        return Err(format!(
                            "检测到异常 samples 大小: frames_to_read={}, channels={}",
                            frames_to_read, src_channels
                        ));
                    }
                };

                let f32_slice =
                    unsafe { std::slice::from_raw_parts(data_ptr as *const f32, expected_samples) };

                let mut mono_data = Vec::<u8>::with_capacity(output_bytes);

                for i in 0..frames_to_read as usize {
                    let frame_start = i * src_channels;
                    let left = f32_slice[frame_start];
                    let right = if src_channels > 1 {
                        f32_slice[frame_start + 1]
                    } else {
                        left
                    };
                    let mono = (left + right) / 2.0;
                    mono_data.extend_from_slice(&mono.to_le_bytes());
                }

                mono_data
            };

            // 无论数据分支如何，都必须归还缓冲。
            if let Err(e) = unsafe { capture_client.ReleaseBuffer(frames_to_read) } {
                return Err(format!(
                    "IAudioCaptureClient::ReleaseBuffer 失败, HRESULT={}",
                    hr_hex(e.code())
                ));
            }

            if pcm_tx.blocking_send(payload).is_err() {
                break;
            }

            packet_frames = match unsafe { capture_client.GetNextPacketSize() } {
                Ok(v) => v,
                Err(e) if e.code() == AUDCLNT_E_DEVICE_INVALIDATED => {
                    return Err(device_invalidated_err(
                        "GetNextPacketSize(循环): 音频设备失效",
                    ));
                }
                Err(e) => {
                    return Err(format!(
                        "GetNextPacketSize(循环) 失败, HRESULT={}",
                        hr_hex(e.code())
                    ))
                }
            };
        }
    }

    let _ = unsafe { audio_client.Stop() };
    Ok(())
}


#[cfg(not(target_os = "windows"))]
fn run_capture_for_pid(
    _pid: u32,
    _pcm_tx: mpsc::Sender<Vec<u8>>,
    _stop_rx: std::sync::mpsc::Receiver<()>,
) -> Result<(), String> {
    Err("当前平台不支持 WASAPI 进程回环捕获，仅 Windows 可用".into())
}

/*#[tauri::command]    这一段是原本的查询麦克风采样率的指令实现
#[cfg(target_os = "windows")]
fn query_mic_sample_rate(state: tauri::State<'_, AppState>) -> Result<u32, String> {
    let mut should_uninit = false;
    match unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) } {
        Ok(()) => {
            should_uninit = true;
        }
        Err(e) if e.code() == HRESULT(0x80010106u32 as i32) => {}
        Err(e) => return Err(hr_msg("查询麦克风采样率时 CoInitialize 失败", e.code())),
    }

    let result = (|| -> Result<u32, String> {
        let device = get_configured_capture_device(&state.selected_mic_device_id)?;
        let client: IAudioClient = match unsafe { device.Activate(CLSCTX_ALL, None) } {
            Ok(v) => v,
            Err(e) => return Err(hr_msg("查询麦克风采样率时 Activate 失败", e.code())),
        };

        let mix_format_ptr = match unsafe { client.GetMixFormat() } {
            Ok(v) => v,
            Err(e) => return Err(hr_msg("查询麦克风采样率时 GetMixFormat 失败", e.code())),
        };

        let sample_rate = unsafe { (*mix_format_ptr).nSamplesPerSec };
        unsafe { CoTaskMemFree(Some(mix_format_ptr as *const std::ffi::c_void)) };
        Ok(sample_rate)
    })();

    if should_uninit {
        unsafe { CoUninitialize() };
    }
    result
}*/

#[tauri::command]
fn query_mic_sample_rate() -> Result<u32, String> {
    // 🌟 直接向前端锁定 48000Hz (配合 AI 降噪)
    Ok(48000)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let (capture_tx, _) = broadcast::channel::<Vec<u32>>(32);
    let latest_capture_pids = Arc::new(Mutex::new(Vec::<u32>::new()));

    // 初始化麦克风状态
    let mic_vad_threshold = Arc::new(Mutex::new(20.0f32));
    let is_mic_running = Arc::new(Mutex::new(false));
    let mic_boost = Arc::new(Mutex::new(5.0f32)); // 默认 5.0 倍放大
    let selected_mic_device_id = Arc::new(Mutex::new(None::<String>));

    if let Err(e) = tauri::Builder::default()
        .manage(AppState {
            capture_tx: capture_tx.clone(),
            latest_capture_pids: latest_capture_pids.clone(),
            mic_vad_threshold: mic_vad_threshold.clone(),
            is_mic_running: is_mic_running.clone(),
            mic_boost: mic_boost.clone(), // 👈 挂载到状态机
            selected_mic_device_id: selected_mic_device_id.clone(),
        })
        .setup(|app| {
            let ws_capture_tx = app.state::<AppState>().capture_tx.clone();
            let ws_latest_pids = app.state::<AppState>().latest_capture_pids.clone();

            // 启动应用音频共享服务 (9001)
            tauri::async_runtime::spawn(async {
                start_audio_pump(ws_capture_tx, ws_latest_pids).await;
            });

            // 🌟 启动麦克风采集服务 (9002)
            let app_handle = app.handle().clone();
            let state_running = app.state::<AppState>().is_mic_running.clone();
            let state_threshold = app.state::<AppState>().mic_vad_threshold.clone();
            let state_boost = app.state::<AppState>().mic_boost.clone();
            let selected_mic_device_id = app.state::<AppState>().selected_mic_device_id.clone();
            tauri::async_runtime::spawn(async move {
                start_mic_pump(
                    app_handle,
                    state_running,
                    state_threshold,
                    state_boost,
                    selected_mic_device_id,
                )
                .await;
            });

            Ok(())
        })
        // 🌟 记得在这里注册我们新加的指令
        .invoke_handler(tauri::generate_handler![
            get_active_processes,
            start_capture,
            start_capture_multi,
            set_mic_vad_threshold,
            toggle_rust_mic,
            list_capture_devices,
            set_rust_mic_device_id,
            query_mic_sample_rate, // 👈 重点：这里必须补上逗号！
            set_mic_boost          // 👈 新增的增益指令
        ])
        .run(tauri::generate_context!())
    {
        println!("❌ tauri 运行失败: {e}");
    }
}
