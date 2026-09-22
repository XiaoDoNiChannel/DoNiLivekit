# 自动更新系统

## 目标与信任边界

DoNiChannel 默认从用户已经保存或正在使用的 FastAPI 服务器检查更新，不依赖客户端能够访问 GitHub。虚拟局域网允许 HTTP 传输，但安装包必须通过 Tauri updater 签名验证；HTTP 只解决可达性，不替代发布身份校验。

## 客户端流程

1. Vue 初始化完成后读取已保存的 `lk_server_ip`；没有保存值时使用中心服务器 `10.126.126.67:5000`。旧默认地址 `10.126.126.10:5000` 会自动迁移。
2. `features/autoUpdate.js` 异步调用 Tauri `check_for_update(serverBaseUrl)`，不等待它完成，因此不阻塞主界面。
3. Rust 使用 `app.updater_builder().endpoints(...).build().check()` 构造：

   ```text
   {server_base_url}/api/update/{{target}}/{{arch}}/{{current_version}}
   ```

4. 启动、成功连接以及客户端持续运行期间每四小时检查一次。检查结果进入 `updateStore`；网络不可达、超时或接口不存在时状态为 `unavailable`，不弹阻断提示。
5. 有更新时右下角显示版本、更新说明和安装按钮。用户确认后调用 `install_update`；Rust 再次检查并由 Tauri updater 下载、上报进度、验证签名和安装，Windows 安装完成后自动重启。Vue 不接触安装包 URL。

`0.1.1` 是第一版包含上述自动更新链路的客户端。已经安装的 `0.1.0` 不具备检查命令和更新提示，必须手动安装 `0.1.1` 一次；从下一版本开始才能通过客户端内自动更新。

## 服务端流程

FastAPI 从 `DONICHANNEL_DOWNLOADS_DIR`（默认仓库/部署目录下的 `downloads/`）读取 `latest.json`：

- `GET /api/update/{target}/{arch}/{current_version}`：当前版本已是最新、清单缺失或平台产物未部署时返回 204；否则返回 `version`、`url`、`signature`、`notes`、`pub_date`。
- `GET /downloads/{filename}`：同一服务器提供签名 updater bundle。
- 设置 `DONICHANNEL_UPDATE_BASE_URL=https://国内对象存储/路径` 后，清单 URL 会指向该备用源；不设置时指向请求当前 FastAPI 的地址。

部署一个版本时，把 GitHub Release 中的 `latest.json`、Windows 更新安装包（`.exe`、`.msi` 或 `.nsis.zip`）和对应 `.sig` 交给 `Publish-LanUpdate.ps1`。脚本会兼容 `tauri-action v1` 的数字 GitHub asset URL，将清单规范化为真实文件名，再按“安装包优先、清单最后”的顺序发布到服务端 `downloads/`。

也可以在中心服务器仓库根目录运行发布脚本。脚本会验证清单和签名字段，先复制更新包、最后原子替换清单，并检查线上接口：

```powershell
.\scripts\Publish-LanUpdate.ps1 -SourceDirectory "D:\release\v0.2.0"
```

默认发布到仓库的 `downloads/` 并检查 `http://10.126.126.67:5000`。如果打包后的 Python 后端运行在其他目录，使用 `-DestinationDirectory` 指向后端可执行文件旁边的 `downloads`。

## 配置

`src-tauri/tauri.conf.json` 不包含固定服务器 IP。配置只保留：

- updater 公钥；
- `dangerousInsecureTransportProtocol: true`，仅供可信虚拟局域网 HTTP 部署；
- `createUpdaterArtifacts: true`，使 release 构建生成签名更新产物。

更换签名密钥意味着旧客户端无法验证新密钥签名的包。密钥轮换必须先发布一个仍由旧私钥签名、但内置新公钥的过渡版本。

## 清单示例

```json
{
  "version": "0.2.0",
  "notes": "P1 engineering release",
  "pub_date": "2026-09-20T00:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "...",
      "url": "https://github.com/.../DoNiChannel_0.2.0_x64-setup.nsis.zip"
    }
  }
}
```

不要把 `.sig` 文本、私钥或普通 NSIS `.exe` 当成可跳过验证的 updater bundle。
