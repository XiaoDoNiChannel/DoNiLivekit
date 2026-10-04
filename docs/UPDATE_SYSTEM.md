# 免安装 EXE 自动更新

## 分发与依赖

Windows x64 发布文件是 `DoNiChannel.exe`，直接运行，不生成 NSIS/MSI 安装程序。界面资源嵌入 EXE；用户配置和 WebView 数据仍位于原用户数据目录。免安装不代表免依赖：目标电脑需要 WebView2 Runtime。程序目录必须可写，建议使用用户自己的文件夹，避免 Program Files、只读介质和受限共享盘。

## 更新频道

客户端在启动、连接成功和每四小时异步检查：

```text
https://github.com/XiaoDoNiChannel/DoNiLivekit/releases/latest/download/latest-portable.json
```

只查询 `windows-x86_64-portable` 平台。清单和二进制通过 HTTPS 获取，继续沿用现有 Tauri 公私钥签名。GitHub Draft 和 Prerelease 不进入稳定频道，必须正式 Publish release。关闭提示只在本次会话忽略该版本。

```json
{
  "version": "0.1.5",
  "notes": "免安装版",
  "pub_date": "2026-10-03T00:00:00Z",
  "platforms": {
    "windows-x86_64-portable": {
      "signature": "Tauri signer 生成的 Base64 签名文本",
      "url": "https://github.com/XiaoDoNiChannel/DoNiLivekit/releases/download/v0.1.5/DoNiChannel.exe"
    }
  }
}
```

## 客户端更新

1. 点击“更新并重启”，Rust 重新检查清单，用 Tauri `download()` 下载并验证签名。不会调用按安装器处理 EXE 的 `install()`。
2. 校验 Windows x64 PE 文件头，在当前 EXE 同目录创建随机 `.donichannel-update-*` 临时目录，写入新版二进制和任务数据。目录不可写会显示错误，当前程序保持运行。
3. 复制当前程序为临时 `helper.exe`，通过内部启动参数进入更新助手模式，不创建界面、音频服务或安装向导。路径使用进程参数和文件 API，不拼接 shell 命令。
4. 助手再次校验暂存 EXE 的签名，持有旧进程句柄并报告就绪。主程序收到就绪信号后退出。
5. 助手等待旧进程退出（最多 60 秒），将旧文件重命名为 `previous.exe`，移入新版并启动。原文件名和位置保持不变。
6. 文件替换或进程启动失败时尝试恢复旧文件并重启旧版，保留 `error.txt` 和剩余备份，显示错误。新进程启动后清理已知临时文件。此回退不检测新版界面启动后的业务故障。

整个过程不请求管理员权限、不修改签名密钥。群文件兜底提示保留：GitHub 下载超时后，关闭程序，手动下载和替换 EXE 即可。

## 首次迁移

0.1.4 及此前的安装版使用 `latest.json` 和安装器流程，必须手动下载首个免安装版一次。不要把普通 EXE 写入旧清单，也不要把免安装清单复制给旧中心服务器更新接口。首次使用新 EXE 后，后续版本才走新的更新频道。

应用标识保持 `com.r.donichannel`，设置沿用原用户数据目录。用户需关闭旧程序，保存新 EXE 到可写目录并直接运行；原快捷方式仍指向旧安装目录，需要重新创建。更换签名密钥仍会破坏旧客户端验证能力，必须备份并继续使用当前发布私钥。

## 发布

`RELEASE_CLIENT.cmd` 的 GitHub 模式创建标签后触发工作流。`Build-PortableRelease.ps1` 先检查签名密钥一致性，再构建 x64 EXE、对最终字节签名并生成清单。Release 需要三份文件：`DoNiChannel.exe`、`DoNiChannel.exe.sig`、`latest-portable.json`。群文件只分发 EXE。工作流拒绝覆盖已公开的 Release。

首次正式发布前，在 Windows 测试机用两个已签名版本测试更新和重启，覆盖中文/空格路径、被占用文件、不可写目录和设置保留。Tauri 更新器的下载与安装 API 参考：[官方文档](https://v2.tauri.app/plugin/updater/)。
