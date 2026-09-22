# P1 重构记录

## 范围

本阶段只处理工程结构、更新、依赖、测试、日志、迁移和 CI/CD。没有重新实现 P0 Presence/人数同步/音频稳定性，没有加入鉴权、CSP、CORS 改造、Redis、微服务或 P2 产品功能。

## 兼容性承诺

- Tauri command 名称与参数保持不变，并新增 `check_for_update`、`install_update`。
- 本地音频仍使用 `127.0.0.1:9001` 与 `127.0.0.1:9002`。
- WASAPI、RNNoise、VAD、增益、limiter、PCM Float32 格式和 P0 generation/cancellation 行为不变。
- REST/WebSocket URL、Presence epoch/seq/snapshot/diff/TTL 和 Chat 字段保持兼容。
- `python main.py` 仍是后端启动方式。

## 主要变更

- Rust `lib.rs` 缩减为 Tauri 装配；命令、状态、DSP、帧队列、transport 分层。
- FastAPI 移入 `server/` 包，配置、lifespan、迁移、仓储、实时协议和更新 API 分层。
- `schema_version` 当前为 3；旧数据库迁移前使用 SQLite backup API 生成可恢复副本。
- 动态更新端点来自当前服务器配置，Tauri 负责下载/签名验证/安装。
- `livekit-client` 由 npm lockfile 管理并随 Vite bundle 分发。
- 增加 Windows CI 和 tag release workflow。
- 删除已确认没有 import 的根级 Vue 重复组件和重复 `components/messageRenderer.js`；保留 `legacy/client.js` 与 `ui/pcm-worker.js` 兼容入口。

## 测试覆盖

- Rust：PCM little-endian round-trip、partial buffer、limiter、VAD、队列过载、会话 generation/cancellation、动态 updater endpoint。
- Python：旧库备份/迁移/数据保留、Presence snapshot/diff/seq、旧连接隔离、TTL 清理、Chat history/reaction、rooms API、更新 204/清单/下载。
- 前端：Presence 有序协议、成员权威合并、PCM ring buffer、更新地址/跳过/可用/失败状态。

所有数据库测试使用临时目录。完整命令见 README。
