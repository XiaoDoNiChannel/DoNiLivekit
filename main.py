"""
DoNiChannel 后端入口（FastAPI 版）。

职责：
1. 提供 LiveKit token。
2. 管理语音频道列表。
3. 提供 Presence WebSocket，用于实时同步"谁在线、谁在哪个语音频道"。
4. 兼容旧客户端的 /api/rooms 轮询接口。
5. 聊天消息持久化（SQLite）+ 历史记录拉取。
6. Reaction 实时同步（旧 REST + Presence 广播兼容路径，后续迁移到 Chat WebSocket）。
7. 用户资料广播（头像颜色、emoji，让其他客户端渲染正确头像）。
8. 提供 Chat WebSocket 基础通道，用于后续聊天消息/Reaction 的独立实时链路。

注意：
- LiveKit 负责音频、屏幕共享、Track 订阅。
- Presence WebSocket 负责大厅在线状态、频道成员状态；聊天消息/Reaction 保留旧兼容路径，新的实时聊天链路走 /ws/chat。
- Rust 9001/9002 本地音频采集不经过这里。
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import sqlite3
import sys
import time
import uuid
from dataclasses import dataclass, field
from typing import Dict, List, Optional

import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Body, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Body, Query, UploadFile, File, Header, Form
from livekit.api import (
    LiveKitAPI,
    AccessToken,
    VideoGrants,
    ListRoomsRequest,
    ListParticipantsRequest,
)


# ============================================================
# 基础配置
# ============================================================

def get_base_dir() -> str:
    """
    返回后端运行目录。

    普通运行时：返回 main.py 所在目录。
    PyInstaller 打包后：返回 exe 所在目录。
    """
    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))


BASE_DIR = get_base_dir()
DB_PATH = os.path.join(BASE_DIR, "rooms.db")

UI_DIST_DIR = os.path.join(BASE_DIR, "ui", "dist")
UI_SRC_DIR = os.path.join(BASE_DIR, "ui")
UI_DIR = UI_DIST_DIR if os.path.exists(UI_DIST_DIR) else UI_SRC_DIR

API_KEY = os.environ.get("LIVEKIT_API_KEY", "devkey")
API_SECRET = os.environ.get("LIVEKIT_API_SECRET", "secret")
LIVEKIT_URL = os.environ.get("LIVEKIT_URL", "http://127.0.0.1:7880")

DEFAULT_ROOMS = ["day0", "day1", "day2"]
DEFAULT_ROOM_NAME = "team-meeting-room"

# 每个频道最多保留的消息条数（超出时删除最旧的）
CHAT_MAX_MESSAGES_PER_CHANNEL = 500

UPLOADS_DIR = os.path.join(BASE_DIR, "uploads")
MAX_AVATAR_UPLOAD_BYTES = 10 * 1024 * 1024
ALLOWED_AVATAR_MIME_TYPES = {"image/png", "image/jpeg", "image/webp", "image/gif"}
ALLOWED_AVATAR_EXTENSIONS = {"png", "jpg", "jpeg", "webp", "gif"}

# 聊天图片上传：原图保存，前端只负责显示缩略尺寸。后续可增加服务端缩略图。
MAX_CHAT_IMAGE_UPLOAD_BYTES = 20 * 1024 * 1024
ALLOWED_CHAT_IMAGE_MIME_TYPES = {"image/png", "image/jpeg", "image/webp", "image/gif"}
ALLOWED_CHAT_IMAGE_EXTENSIONS = {"png", "jpg", "jpeg", "webp", "gif"}

AVATAR_HISTORY_LIMIT_PER_USER = 12
# 设置 DONICHANNEL_ADMIN_TOKEN 后，清空全部聊天记录必须带 X-Admin-Token 或 adminToken。
CHAT_ADMIN_TOKEN = os.environ.get("DONICHANNEL_ADMIN_TOKEN", "").strip()

app = FastAPI(title="DoNiChannel Backend", version="1.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ============================================================
# SQLite 存储
# ============================================================

os.makedirs(UPLOADS_DIR, exist_ok=True)
app.mount("/uploads", StaticFiles(directory=UPLOADS_DIR), name="uploads")

def get_db_conn() -> sqlite3.Connection:
    """创建 SQLite 连接。"""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def _table_columns(conn: sqlite3.Connection, table_name: str) -> set[str]:
    """读取表字段集合，用于轻量迁移。"""
    rows = conn.execute(f"PRAGMA table_info({table_name})").fetchall()
    return {row["name"] for row in rows}


def _ensure_column(conn: sqlite3.Connection, table_name: str, column_name: str, column_ddl: str) -> None:
    """字段不存在时追加字段，兼容旧 rooms.db。"""
    if column_name not in _table_columns(conn, table_name):
        conn.execute(f"ALTER TABLE {table_name} ADD COLUMN {column_name} {column_ddl}")


def _require_admin_token(admin_token: Optional[str], x_admin_token: Optional[str]) -> None:
    """高风险管理操作的最小保护。"""
    provided = (x_admin_token or admin_token or "").strip()
    if not CHAT_ADMIN_TOKEN:
        raise HTTPException(
            status_code=403,
            detail="服务端未设置 DONICHANNEL_ADMIN_TOKEN，禁止清空全部聊天记录",
        )
    if provided != CHAT_ADMIN_TOKEN:
        raise HTTPException(status_code=403, detail="管理员令牌无效")


def init_db() -> None:
    """初始化语音频道表、聊天消息表、用户资料缓存表。"""
    conn = get_db_conn()
    try:
        # 语音频道表（原有）
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS rooms (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                room_name TEXT NOT NULL UNIQUE
            )
            """
        )

        count = conn.execute("SELECT COUNT(*) AS cnt FROM rooms").fetchone()["cnt"]
        if count == 0:
            conn.executemany(
                "INSERT OR IGNORE INTO rooms (room_name) VALUES (?)",
                [(name,) for name in DEFAULT_ROOMS],
            )

        # 聊天消息表（新增）
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS chat_messages (
                id          TEXT PRIMARY KEY,
                channel_id  TEXT NOT NULL,
                sender_id   TEXT NOT NULL,
                sender_name TEXT NOT NULL,
                sender_color TEXT NOT NULL DEFAULT '#5865f2',
                sender_preset TEXT NOT NULL DEFAULT '',
                content     TEXT NOT NULL,
                timestamp   INTEGER NOT NULL,
                reactions   TEXT NOT NULL DEFAULT '{}',
                sender_avatar_url TEXT NOT NULL DEFAULT ''
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_chat_channel_ts ON chat_messages (channel_id, timestamp)"
        )

        # 用户资料缓存表（新增）—— 让其他客户端能看到发送者的头像颜色/emoji
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS user_profiles (
                identity     TEXT PRIMARY KEY,
                user_id      TEXT NOT NULL DEFAULT '',
                display_name TEXT NOT NULL,
                avatar_color TEXT NOT NULL DEFAULT '#5865f2',
                avatar_preset TEXT NOT NULL DEFAULT '',
                avatar_url    TEXT NOT NULL DEFAULT '',
                status_text   TEXT NOT NULL DEFAULT '在线',
                updated_at   INTEGER NOT NULL DEFAULT 0
            )
            """
        )

        # 用户头像历史表：按 userId 保存最近头像记录，便于在客户端回选历史头像。
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS user_avatar_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL,
                avatar_url TEXT NOT NULL,
                filename TEXT NOT NULL,
                content_type TEXT NOT NULL DEFAULT '',
                size_bytes INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL DEFAULT 0
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_avatar_history_user_created ON user_avatar_history (user_id, created_at DESC)"
        )

        # 兼容旧 rooms.db：CREATE TABLE IF NOT EXISTS 不会自动补字段。
        _ensure_column(conn, "chat_messages", "sender_avatar_url", "TEXT NOT NULL DEFAULT ''")
        _ensure_column(conn, "user_profiles", "user_id", "TEXT NOT NULL DEFAULT ''")
        _ensure_column(conn, "user_profiles", "avatar_url", "TEXT NOT NULL DEFAULT ''")
        _ensure_column(conn, "user_profiles", "status_text", "TEXT NOT NULL DEFAULT '在线'")

        conn.commit()
    finally:
        conn.close()


def get_all_rooms_from_db() -> List[str]:
    """从 SQLite 读取全部语音频道。"""
    conn = get_db_conn()
    try:
        rows = conn.execute("SELECT room_name FROM rooms ORDER BY id ASC").fetchall()
        return [row["room_name"] for row in rows]
    finally:
        conn.close()


def add_room_to_db(room_name: str) -> None:
    """新增语音频道。"""
    conn = get_db_conn()
    try:
        conn.execute(
            "INSERT OR IGNORE INTO rooms (room_name) VALUES (?)",
            (room_name,),
        )
        conn.commit()
    finally:
        conn.close()


# ── 聊天消息 CRUD ──────────────────────────────────────────────

def db_save_message(msg: dict) -> None:
    """写入一条聊天消息，并裁剪超出上限的旧消息。"""
    conn = get_db_conn()
    try:
        conn.execute(
            """
            INSERT OR REPLACE INTO chat_messages
                (id, channel_id, sender_id, sender_name, sender_color, sender_preset, content, timestamp, reactions, sender_avatar_url)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                msg["id"],
                msg["channelId"],
                msg["senderId"],
                msg["senderName"],
                msg.get("senderColor", "#5865f2"),
                msg.get("senderPreset", ""),
                msg["content"],
                msg["timestamp"],
                json.dumps(msg.get("reactions", {}), ensure_ascii=False),
                msg.get("senderAvatarUrl", ""),
            ),
        )

        # 裁剪：只保留最新 CHAT_MAX_MESSAGES_PER_CHANNEL 条
        conn.execute(
            """
            DELETE FROM chat_messages
            WHERE channel_id = ?
              AND id NOT IN (
                  SELECT id FROM chat_messages
                  WHERE channel_id = ?
                  ORDER BY timestamp DESC
                  LIMIT ?
              )
            """,
            (msg["channelId"], msg["channelId"], CHAT_MAX_MESSAGES_PER_CHANNEL),
        )

        conn.commit()
    finally:
        conn.close()


def db_get_history(channel_id: str, limit: int = 50, before_ts: Optional[int] = None) -> List[dict]:
    """
    拉取频道聊天历史，按时间戳升序返回（最新在末尾，和前端显示一致）。

    before_ts: 用于分页，只返回该时间戳之前的消息。
    """
    conn = get_db_conn()
    try:
        if before_ts is not None:
            rows = conn.execute(
                """
                SELECT m.*, p.avatar_color as current_color, p.avatar_preset as current_preset, p.avatar_url as current_url
                FROM chat_messages m
                LEFT JOIN user_profiles p ON m.sender_id = p.identity
                WHERE m.channel_id = ? AND m.timestamp < ?
                ORDER BY m.timestamp DESC
                LIMIT ?
                """,
                (channel_id, before_ts, limit),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT m.*, p.avatar_color as current_color, p.avatar_preset as current_preset, p.avatar_url as current_url
                FROM chat_messages m
                LEFT JOIN user_profiles p ON m.sender_id = p.identity
                WHERE m.channel_id = ?
                ORDER BY m.timestamp DESC
                LIMIT ?
                """,
                (channel_id, limit),
            ).fetchall()

        # DESC 查询后反转为 ASC（旧消息在前）
        result = []
        for row in reversed(rows):
            current_color = row["current_color"] if "current_color" in row.keys() else None
            current_preset = row["current_preset"] if "current_preset" in row.keys() else None
            current_url = row["current_url"] if "current_url" in row.keys() else None
            
            result.append({
                "id": row["id"],
                "channelId": row["channel_id"],
                "senderId": row["sender_id"],
                "senderName": row["sender_name"],
                "senderColor": current_color if current_color else row["sender_color"],
                "senderPreset": current_preset if current_preset is not None else row["sender_preset"],
                "senderAvatarUrl": current_url if current_url else (row["sender_avatar_url"] if "sender_avatar_url" in row.keys() else ""),
                "content": row["content"],
                "timestamp": row["timestamp"],
                "reactions": json.loads(row["reactions"] or "{}"),
                "isSelf": False,  # 服务端不知道 isSelf，客户端自己判断
            })
        return result
    finally:
        conn.close()


def db_update_reactions(message_id: str, reactions: dict) -> None:
    """更新一条消息的 reactions 字段。"""
    conn = get_db_conn()
    try:
        conn.execute(
            "UPDATE chat_messages SET reactions = ? WHERE id = ?",
            (json.dumps(reactions, ensure_ascii=False), message_id),
        )
        conn.commit()
    finally:
        conn.close()


def db_get_message(message_id: str) -> Optional[dict]:
    """按 ID 查单条消息。"""
    conn = get_db_conn()
    try:
        row = conn.execute(
            "SELECT * FROM chat_messages WHERE id = ?", (message_id,)
        ).fetchone()
        if not row:
            return None
        return {
            "id": row["id"],
            "channelId": row["channel_id"],
            "reactions": json.loads(row["reactions"] or "{}"),
        }
    finally:
        conn.close()


# ── 用户资料缓存 ────────────────────────────────────────────────

def db_upsert_profile(
    identity: str,
    display_name: str,
    avatar_color: str,
    avatar_preset: str,
    avatar_url: str = "",
    status_text: str = "在线",
    user_id: Optional[str] = None,
) -> None:
    """
    更新/插入用户资料缓存。

    identity 当前阶段作为资料主键使用；新客户端会传 userId，
    因此历史消息 senderId=userId 能稳定 join 到头像资料。
    """
    clean_identity = (identity or user_id or "").strip()
    if not clean_identity:
        return

    clean_user_id = (user_id or clean_identity).strip()
    clean_name = (display_name or "未命名用户").strip()[:24] or "未命名用户"
    clean_status = (status_text or "在线").strip()[:32] or "在线"

    conn = get_db_conn()
    try:
        conn.execute(
            """
            INSERT INTO user_profiles
                (identity, user_id, display_name, avatar_color, avatar_preset, avatar_url, status_text, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(identity) DO UPDATE SET
                user_id       = excluded.user_id,
                display_name  = excluded.display_name,
                avatar_color  = excluded.avatar_color,
                avatar_preset = excluded.avatar_preset,
                avatar_url    = excluded.avatar_url,
                status_text   = excluded.status_text,
                updated_at    = excluded.updated_at
            """,
            (
                clean_identity,
                clean_user_id,
                clean_name,
                avatar_color or "#5865f2",
                avatar_preset or "",
                avatar_url or "",
                clean_status,
                int(time.time() * 1000),
            ),
        )
        conn.commit()
    finally:
        conn.close()


def db_get_profile(identity: str) -> Optional[dict]:
    """按 identity/userId 读取用户资料缓存。"""
    clean_identity = (identity or "").strip()
    if not clean_identity:
        return None

    conn = get_db_conn()
    try:
        row = conn.execute(
            "SELECT * FROM user_profiles WHERE identity = ? OR user_id = ? LIMIT 1",
            (clean_identity, clean_identity),
        ).fetchone()
        if not row:
            return None
        row_keys = row.keys()
        user_id = row["user_id"] if "user_id" in row_keys and row["user_id"] else row["identity"]
        return {
            "identity": row["identity"],
            "userId": user_id,
            "displayName": row["display_name"],
            "avatarColor": row["avatar_color"],
            "avatarPreset": row["avatar_preset"],
            "avatarUrl": row["avatar_url"] if "avatar_url" in row_keys else "",
            "statusText": row["status_text"] if "status_text" in row_keys else "在线",
            "updatedAt": row["updated_at"],
        }
    finally:
        conn.close()


init_db()


# ============================================================
# LiveKit token / rooms 兼容接口
# ============================================================

def build_token(user_name: str, room_name: str, identity: Optional[str] = None) -> str:
    """
    生成 LiveKit 连接 token。

    identity 是 LiveKit 内部唯一身份。
    display name 使用用户输入的 user_name。
    """
    clean_user = (user_name or "访客").strip() or "访客"
    clean_room = (room_name or DEFAULT_ROOM_NAME).strip() or DEFAULT_ROOM_NAME
    livekit_identity = identity or f"{clean_user}-{uuid.uuid4().hex[:8]}"

    token = (
        AccessToken(API_KEY, API_SECRET)
        .with_identity(livekit_identity)
        .with_name(clean_user)
        .with_grants(
            VideoGrants(
                room_join=True,
                room=clean_room,
            )
        )
    )
    return token.to_jwt()


async def list_livekit_rooms_and_participants() -> dict:
    """
    从 LiveKit 查询当前活跃房间和房间内成员。

    这是旧客户端 /api/rooms 轮询的兼容数据源。
    新客户端实时成员状态应走 /ws/presence。
    """
    result = {}

    async with LiveKitAPI(LIVEKIT_URL, API_KEY, API_SECRET) as lkapi:
        try:
            rooms_resp = await lkapi.room.list_rooms(ListRoomsRequest())
            for room in rooms_resp.rooms:
                parts_resp = await lkapi.room.list_participants(
                    ListParticipantsRequest(room=room.name)
                )
                result[room.name] = [
                    participant.name if participant.name else participant.identity
                    for participant in parts_resp.participants
                ]
        except Exception as error:
            print(f"[rooms] 获取 LiveKit 房间成员失败: {error}")

    return result


# ============================================================
# Presence 状态管理
# ============================================================

@dataclass
class PresenceParticipant:
    """Presence 层在线用户状态（含头像信息）。

    identity：当前 LiveKit / Presence 兼容身份。
    user_id：长期用户身份。
    connection_id：本次客户端连接身份。
    """
    identity: str
    display_name: str
    user_id: str = ""
    connection_id: str = ""
    current_channel: Optional[str] = None
    avatar_color: str = "#5865f2"
    avatar_preset: str = ""
    avatar_url: str = ""
    status_text: str = "在线"


class PresenceManager:
    """
    管理大厅在线状态、语音频道成员状态。

    Phase 3 起：PresenceManager 不再负责聊天消息和 Reaction 广播；
    聊天实时通信由 ChatManager / /ws/chat 负责。
    """

    def __init__(self) -> None:
        self.active_connections: Dict[str, WebSocket] = {}
        self.participants: Dict[str, PresenceParticipant] = {}
        self.lock = asyncio.Lock()

    def build_snapshot(self) -> dict:
        """构建完整 Presence 快照（含头像字段）。"""
        room_names = get_all_rooms_from_db()

        channels = []
        for room_name in room_names:
            members = [
                {
                    "identity": participant.identity,
                    "userId": participant.user_id or participant.identity,
                    "connectionId": participant.connection_id or participant.identity,
                    "displayName": participant.display_name,
                    "avatarColor": participant.avatar_color,
                    "avatarPreset": participant.avatar_preset,
                    "avatarUrl": participant.avatar_url,
                    "statusText": participant.status_text,
                }
                for participant in self.participants.values()
                if participant.current_channel == room_name
            ]

            channels.append(
                {
                    "id": room_name,
                    "name": room_name,
                    "type": "voice",
                    "members": members,
                }
            )

        participants = {
            identity: {
                "identity": participant.identity,
                "userId": participant.user_id or participant.identity,
                "connectionId": participant.connection_id or participant.identity,
                "displayName": participant.display_name,
                "currentChannel": participant.current_channel,
                "avatarColor": participant.avatar_color,
                "avatarPreset": participant.avatar_preset,
                "avatarUrl": participant.avatar_url,
                "statusText": participant.status_text,
            }
            for identity, participant in self.participants.items()
        }

        return {
            "type": "presence_snapshot",
            "channels": channels,
            "participants": participants,
        }

    async def connect(
        self,
        websocket: WebSocket,
        identity: str,
        display_name: str,
        avatar_color: str = "#5865f2",
        avatar_preset: str = "",
        avatar_url: str = "",
        status_text: str = "在线",
        user_id: str = "",
        connection_id: str = "",
    ) -> bool:
        """
        注册 Presence WebSocket 连接。

        修复点：
        - 同一 identity 重连时，新连接替换旧连接。
        - 旧连接断开时不能误删新连接。
        - accept 后、发送 snapshot 前客户端可能已经断开，必须捕获异常。
        """
        try:
            await websocket.accept()
        except Exception as error:
            print(f"[presence] WebSocket accept 失败: identity={identity}, error={error}")
            return False

        old_websocket = None
        was_online = False
        old_channel = None

        async with self.lock:
            old_websocket = self.active_connections.get(identity)
            old_participant = self.participants.get(identity)

            if old_participant:
                was_online = True
                old_channel = old_participant.current_channel

            self.active_connections[identity] = websocket
            self.participants[identity] = PresenceParticipant(
                identity=identity,
                display_name=display_name,
                user_id=user_id or identity,
                connection_id=connection_id or identity,
                current_channel=old_channel,
                avatar_color=avatar_color,
                avatar_preset=avatar_preset,
                avatar_url=avatar_url,
                status_text=status_text or "在线",
            )

        # 持久化用户资料（供历史消息渲染使用）
        db_upsert_profile(user_id or identity, display_name, avatar_color, avatar_preset, avatar_url, status_text=status_text or "在线", user_id=user_id or identity)

        if old_websocket and old_websocket is not websocket:
            try:
                await old_websocket.close(code=4000)
            except Exception:
                pass

        try:
            await websocket.send_text(
                json.dumps(self.build_snapshot(), ensure_ascii=False)
            )
        except Exception as error:
            print(
                f"[presence] 发送初始快照失败，按正常断开处理: "
                f"identity={identity}, error={error}"
            )
            await self.disconnect(identity, websocket)
            return False

        if not was_online:
            await self.broadcast(
                {
                    "type": "participant_online",
                    "participant": {
                        "identity": identity,
                        "userId": user_id or identity,
                        "connectionId": connection_id or identity,
                        "displayName": display_name,
                        "currentChannel": old_channel,
                        "avatarColor": avatar_color,
                        "avatarPreset": avatar_preset,
                        "avatarUrl": avatar_url,
                        "statusText": status_text or "在线",
                    },
                },
                exclude_identity=identity,
            )

        return True

    async def disconnect(self, identity: str, websocket: Optional[WebSocket] = None) -> None:
        """
        注销 Presence 连接。

        如果断开的是旧连接，而 active_connections[identity] 已经是新连接，
        则直接忽略，不能误删新连接。
        """
        async with self.lock:
            current_websocket = self.active_connections.get(identity)

            if websocket is not None and current_websocket is not websocket:
                return

            participant = self.participants.pop(identity, None)
            self.active_connections.pop(identity, None)

        if participant:
            await self.broadcast(
                {
                    "type": "participant_offline",
                    "identity": participant.identity,
                    "userId": participant.user_id or participant.identity,
                    "connectionId": participant.connection_id or participant.identity,
                    "displayName": participant.display_name,
                    "from": participant.current_channel,
                }
            )

    async def move_to_channel(self, identity: str, channel_id: Optional[str]) -> None:
        """把用户移动到指定语音频道。"""
        clean_channel = (channel_id or "").strip() or None

        if clean_channel is not None and clean_channel not in get_all_rooms_from_db():
            raise ValueError(f"频道不存在: {clean_channel}")

        async with self.lock:
            participant = self.participants.get(identity)
            if not participant:
                raise ValueError(f"Presence 用户不存在: {identity}")

            old_channel = participant.current_channel
            participant.current_channel = clean_channel

            payload = {
                "type": "participant_moved",
                "identity": participant.identity,
                "userId": participant.user_id or participant.identity,
                "connectionId": participant.connection_id or participant.identity,
                "displayName": participant.display_name,
                "from": old_channel,
                "to": clean_channel,
                "avatarColor": participant.avatar_color,
                "avatarPreset": participant.avatar_preset,
                "avatarUrl": participant.avatar_url,
                "statusText": participant.status_text,
            }

        await self.broadcast(payload)

    async def update_profile(
        self,
        identity: str,
        avatar_color: str,
        avatar_preset: str,
        avatar_url: str,
        display_name: Optional[str] = None,
        status_text: str = "在线",
    ) -> None:
        """更新用户资料，并广播给其他人。"""
        async with self.lock:
            participant = self.participants.get(identity)
            if not participant:
                return
            if display_name:
                participant.display_name = display_name.strip()[:24] or participant.display_name
            participant.avatar_color = avatar_color or "#5865f2"
            participant.avatar_preset = avatar_preset or ""
            participant.avatar_url = avatar_url or ""
            participant.status_text = (status_text or participant.status_text or "在线").strip()[:32] or "在线"

        db_upsert_profile(
            participant.user_id or identity,
            participant.display_name,
            participant.avatar_color,
            participant.avatar_preset,
            participant.avatar_url,
            status_text=participant.status_text,
            user_id=participant.user_id or identity,
        )

        await self.broadcast(
            {
                "type": "profile_updated",
                "identity": identity,
                "userId": participant.user_id or identity,
                "connectionId": participant.connection_id or identity,
                "displayName": participant.display_name,
                "avatarColor": participant.avatar_color,
                "avatarPreset": participant.avatar_preset,
                "avatarUrl": participant.avatar_url,
                "statusText": participant.status_text,
            },
            exclude_identity=identity,
        )

    async def broadcast_room_created(self, room_name: str) -> None:
        """频道创建后广播完整快照。"""
        await self.broadcast(self.build_snapshot())

    async def send_to(self, identity: str, payload: dict) -> bool:
        """向指定用户发送 Presence 消息；失败则清理连接。"""
        websocket = self.active_connections.get(identity)
        if not websocket:
            return False

        try:
            await websocket.send_text(json.dumps(payload, ensure_ascii=False))
            return True
        except Exception as error:
            print(f"[presence] 向客户端发送消息失败，清理连接: identity={identity}, error={error}")
            await self.disconnect(identity, websocket)
            return False

    async def broadcast(self, payload: dict, exclude_identity: Optional[str] = None) -> None:
        """
        向所有在线 Presence 客户端广播消息。

        发送失败时，带具体 websocket 清理，避免旧连接失败误删新连接。
        """
        message = json.dumps(payload, ensure_ascii=False)
        dead_connections = []

        for identity, websocket in list(self.active_connections.items()):
            if exclude_identity and identity == exclude_identity:
                continue

            try:
                await websocket.send_text(message)
            except Exception:
                dead_connections.append((identity, websocket))

        for identity, websocket in dead_connections:
            await self.disconnect(identity, websocket)


@dataclass
class ChatConnection:
    """Chat WebSocket 连接状态。"""
    connection_id: str
    user_id: str
    identity: str
    display_name: str
    avatar_color: str = "#5865f2"
    avatar_preset: str = ""
    avatar_url: str = ""
    status_text: str = "在线"
    current_channel: Optional[str] = None
    websocket: WebSocket = field(repr=False, default=None)


class ChatManager:
    """
    独立聊天 WebSocket 管理器（Phase 1）。

    当前阶段只建立独立 /ws/chat 通道、维护订阅频道、支持 ping/pong。
    后续 Phase 2 再把消息发送和 Reaction 从 REST/Presence 迁移到这里。
    """

    def __init__(self) -> None:
        self.active_connections: Dict[str, ChatConnection] = {}
        self.lock = asyncio.Lock()

    async def connect(
        self,
        websocket: WebSocket,
        *,
        connection_id: str,
        user_id: str,
        identity: str,
        display_name: str,
        avatar_color: str = "#5865f2",
        avatar_preset: str = "",
        avatar_url: str = "",
        status_text: str = "在线",
    ) -> bool:
        try:
            await websocket.accept()
        except Exception as error:
            print(f"[chat] WebSocket accept 失败: connectionId={connection_id}, error={error}")
            return False

        old_websocket = None
        async with self.lock:
            old_conn = self.active_connections.get(connection_id)
            old_websocket = old_conn.websocket if old_conn else None
            self.active_connections[connection_id] = ChatConnection(
                connection_id=connection_id,
                user_id=user_id,
                identity=identity,
                display_name=display_name,
                avatar_color=avatar_color or "#5865f2",
                avatar_preset=avatar_preset or "",
                avatar_url=avatar_url or "",
                status_text=status_text or "在线",
                current_channel=old_conn.current_channel if old_conn else None,
                websocket=websocket,
            )

        if old_websocket and old_websocket is not websocket:
            try:
                await old_websocket.close(code=4001)
            except Exception:
                pass

        await self.send_to_connection(
            connection_id,
            {
                "type": "chat_connected",
                "connectionId": connection_id,
                "userId": user_id,
                "identity": identity,
                "displayName": display_name,
                "avatarColor": avatar_color or "#5865f2",
                "avatarPreset": avatar_preset or "",
                "avatarUrl": avatar_url or "",
                "statusText": status_text or "在线",
            },
            websocket=websocket,
        )
        print(f"[chat] connected userId={user_id} connectionId={connection_id} identity={identity}")
        return True

    async def disconnect(self, connection_id: str, websocket: Optional[WebSocket] = None) -> None:
        async with self.lock:
            current = self.active_connections.get(connection_id)
            if websocket is not None and current and current.websocket is not websocket:
                return
            conn = self.active_connections.pop(connection_id, None)

        if conn:
            print(f"[chat] disconnected userId={conn.user_id} connectionId={connection_id} channel={conn.current_channel}")

    async def send_to_connection(self, connection_id: str, payload: dict, websocket: Optional[WebSocket] = None) -> bool:
        conn = self.active_connections.get(connection_id)
        target_ws = websocket or (conn.websocket if conn else None)
        if not target_ws:
            return False

        try:
            await target_ws.send_text(json.dumps(payload, ensure_ascii=False))
            return True
        except Exception as error:
            print(f"[chat] 发送消息失败，清理连接: connectionId={connection_id}, error={error}")
            await self.disconnect(connection_id, target_ws)
            return False

    async def subscribe_channel(self, connection_id: str, channel_id: Optional[str]) -> None:
        clean_channel = (channel_id or "").strip() or None

        if clean_channel is not None and clean_channel not in get_all_rooms_from_db():
            raise ValueError(f"频道不存在: {clean_channel}")

        async with self.lock:
            conn = self.active_connections.get(connection_id)
            if not conn:
                raise ValueError(f"Chat 连接不存在: {connection_id}")
            conn.current_channel = clean_channel

        await self.send_to_connection(
            connection_id,
            {
                "type": "chat_subscribed",
                "channelId": clean_channel,
            },
        )
        print(f"[chat] subscribed connectionId={connection_id} channel={clean_channel}")

    async def handle_send_message(self, connection_id: str, body: dict) -> None:
        """处理 Chat WebSocket 发送消息：保存 SQLite、ACK、按频道广播。"""
        async with self.lock:
            conn = self.active_connections.get(connection_id)

        if not conn:
            raise ValueError(f"Chat 连接不存在: {connection_id}")

        channel_id = str(body.get("channelId") or conn.current_channel or "").strip()
        content = str(body.get("content") or "").strip()
        client_message_id = str(body.get("clientMessageId") or body.get("id") or "").strip()

        if not channel_id:
            raise ValueError("channelId 不能为空")
        if channel_id not in get_all_rooms_from_db():
            raise ValueError(f"频道不存在: {channel_id}")
        if not content:
            raise ValueError("消息内容不能为空")
        if len(content) > 4000:
            raise ValueError("消息过长，最多 4000 字符")

        message_id = client_message_id or f"msg_{uuid.uuid4().hex}"
        timestamp = int(time.time() * 1000)

        msg = {
            "id": message_id,
            "clientMessageId": client_message_id or message_id,
            "serverMessageId": message_id,
            "channelId": channel_id,
            "senderId": conn.user_id,
            "senderUserId": conn.user_id,
            "senderIdentity": conn.identity,
            "senderName": conn.display_name,
            "senderColor": str(body.get("senderColor") or conn.avatar_color or "#5865f2"),
            "senderPreset": str(body.get("senderPreset") if body.get("senderPreset") is not None else conn.avatar_preset or ""),
            "senderAvatarUrl": str(body.get("senderAvatarUrl") if body.get("senderAvatarUrl") is not None else conn.avatar_url or ""),
            "content": content,
            "timestamp": timestamp,
            "reactions": {},
            "isSelf": False,
        }

        # 保存发送者资料，方便历史消息渲染头像。
        db_upsert_profile(conn.user_id, conn.display_name, msg["senderColor"], msg["senderPreset"], msg["senderAvatarUrl"], status_text=conn.status_text, user_id=conn.user_id)
        db_save_message(msg)

        await self.send_to_connection(
            connection_id,
            {
                "type": "message_ack",
                "clientMessageId": client_message_id or message_id,
                "serverMessageId": message_id,
                "messageId": message_id,
                "channelId": channel_id,
                "status": "ok",
            },
        )

        await self.broadcast_to_channel(
            channel_id,
            {
                "type": "message_created",
                "message": msg,
            },
        )

        # Phase 3：聊天消息只走 Chat WebSocket，不再通过 Presence 广播。

        print(f"[chat] message_created channel={channel_id} id={message_id} from={conn.user_id} online={self.get_connection_count()}")

    async def handle_toggle_reaction(self, connection_id: str, body: dict) -> None:
        """处理 Chat WebSocket Reaction/Pin：更新 SQLite、ACK、按频道广播。"""
        async with self.lock:
            conn = self.active_connections.get(connection_id)

        if not conn:
            raise ValueError(f"Chat 连接不存在: {connection_id}")

        message_id = str(body.get("messageId") or "").strip()
        emoji = str(body.get("emoji") or "").strip()
        fallback_channel_id = str(body.get("channelId") or conn.current_channel or "").strip()

        if not message_id or not emoji:
            raise ValueError("messageId / emoji 不能为空")

        msg = db_get_message(message_id)
        if not msg:
            raise ValueError("消息不存在")

        channel_id = msg.get("channelId") or fallback_channel_id
        reactions = msg["reactions"]
        if emoji not in reactions:
            reactions[emoji] = []

        if conn.user_id in reactions[emoji]:
            reactions[emoji].remove(conn.user_id)
            if not reactions[emoji]:
                del reactions[emoji]
            action = "removed"
        else:
            reactions[emoji].append(conn.user_id)
            action = "added"

        db_update_reactions(message_id, reactions)

        await self.send_to_connection(
            connection_id,
            {
                "type": "reaction_ack",
                "messageId": message_id,
                "channelId": channel_id,
                "emoji": emoji,
                "action": action,
                "status": "ok",
                "reactions": reactions,
            },
        )

        reaction_payload = {
            "type": "reaction_updated",
            "messageId": message_id,
            "channelId": channel_id,
            "emoji": emoji,
            "senderId": conn.user_id,
            "senderUserId": conn.user_id,
            "senderIdentity": conn.identity,
            "action": action,
            "reactions": reactions,
        }
        await self.broadcast_to_channel(channel_id, reaction_payload)

        # Phase 3：Reaction 只走 Chat WebSocket，不再通过 Presence 广播。

        print(f"[chat] reaction_updated channel={channel_id} message={message_id} emoji={emoji} action={action} from={conn.user_id}")

    async def broadcast_to_channel(self, channel_id: str, payload: dict, exclude_connection_id: Optional[str] = None) -> None:
        """Phase 2 使用：只向订阅指定频道的 Chat 客户端广播。"""
        message = json.dumps(payload, ensure_ascii=False)
        dead_connections = []

        for connection_id, conn in list(self.active_connections.items()):
            if exclude_connection_id and connection_id == exclude_connection_id:
                continue
            if conn.current_channel != channel_id:
                continue
            try:
                await conn.websocket.send_text(message)
            except Exception:
                dead_connections.append((connection_id, conn.websocket))

        for connection_id, websocket in dead_connections:
            await self.disconnect(connection_id, websocket)

    def get_connection_count(self) -> int:
        return len(self.active_connections)


presence_manager = PresenceManager()
chat_manager = ChatManager()


# ============================================================
# HTTP API
# ============================================================

@app.get("/")
async def index():
    """返回前端入口文件。"""
    index_path = os.path.join(UI_DIR, "index.html")
    if not os.path.exists(index_path):
        raise HTTPException(status_code=404, detail=f"未找到前端入口文件: {index_path}")
    return FileResponse(index_path)


@app.get("/api/get_token")
@app.get("/token")
async def get_token(
    user: str = "访客",
    room: str = DEFAULT_ROOM_NAME,
    identity: Optional[str] = None,
):
    """获取 LiveKit token。"""
    token_jwt = build_token(user_name=user, room_name=room, identity=identity)
    return {"token": token_jwt, "room": room}


@app.get("/api/rooms")
async def get_rooms():
    """
    获取频道列表和当前频道成员。

    旧客户端兼容：participants 从 LiveKit 查询。
    新客户端实时成员状态走 Presence WebSocket。
    """
    db_rooms = get_all_rooms_from_db()
    livekit_map = {}

    try:
        livekit_map = await list_livekit_rooms_and_participants()
    except Exception as error:
        print(f"[rooms] LiveKit room sync failed: {error}")

    merged_names = []
    seen = set()
    for name in db_rooms + list(livekit_map.keys()):
        if name in seen:
            continue
        seen.add(name)
        merged_names.append(name)

    payload = [
        {
            "name": name,
            "participants": livekit_map.get(name, []),
        }
        for name in merged_names
    ]

    return JSONResponse(payload)


@app.post("/api/rooms")
async def create_room(body: dict = Body(default_factory=dict)):
    """创建语音频道。"""
    room_name = str(body.get("name") or body.get("room_name") or "").strip()

    if not room_name:
        raise HTTPException(status_code=400, detail="房间名不能为空")
    if len(room_name) > 64:
        raise HTTPException(status_code=400, detail="房间名过长，最多 64 个字符")

    add_room_to_db(room_name)
    await presence_manager.broadcast_room_created(room_name)
    return {"ok": True, "name": room_name}


# ── 聊天 REST 接口 ──────────────────────────────────────────────

@app.delete("/api/chat/history")
async def clear_chat_history(
    channel: Optional[str] = Query(None, description="频道 ID，不传则清空全部"),
    adminToken: Optional[str] = Query(None, description="管理员令牌；清空全部记录时必填"),
    x_admin_token: Optional[str] = Header(None, alias="X-Admin-Token"),
):
    """清空聊天记录。

    安全策略：
    - 指定 channel：保留原有行为，方便现有 UI 清频道记录。
    - 不指定 channel：属于高风险全量删除，必须设置并提供 DONICHANNEL_ADMIN_TOKEN。
    """
    if not channel:
        _require_admin_token(adminToken, x_admin_token)

    conn = get_db_conn()
    try:
        if channel:
            conn.execute("DELETE FROM chat_messages WHERE channel_id = ?", (channel,))
        else:
            conn.execute("DELETE FROM chat_messages")
        conn.commit()
        return JSONResponse({"ok": True, "channel": channel or "all"})
    finally:
        conn.close()


@app.get("/api/chat/history")
async def get_chat_history(
    channel: str = Query(..., description="频道 ID"),
    limit: int = Query(50, ge=1, le=200, description="返回条数"),
    before: Optional[int] = Query(None, description="时间戳分页（毫秒），只返回此时间之前的消息"),
):
    """
    拉取频道聊天历史记录。

    加入频道时调用一次，获取最近 N 条消息。
    支持通过 before 参数向上翻页（加载更早的消息）。
    """
    messages = db_get_history(channel, limit=limit, before_ts=before)
    return JSONResponse({"messages": messages, "channelId": channel})


@app.post("/api/chat/message")
async def post_chat_message(body: dict = Body(default_factory=dict)):
    """
    接收客户端发送的聊天消息，持久化并通过 Presence WebSocket 广播给所有人。

    前端在发送 LiveKit DataChannel 的同时，也 POST 到这里存档。
    """
    channel_id = str(body.get("channelId") or "").strip()
    sender_id = str(body.get("senderId") or "").strip()
    sender_name = str(body.get("senderName") or "未知用户").strip()
    content = str(body.get("content") or "").strip()

    if not channel_id:
        raise HTTPException(status_code=400, detail="channelId 不能为空")
    if not content:
        raise HTTPException(status_code=400, detail="消息内容不能为空")
    if len(content) > 4000:
        raise HTTPException(status_code=400, detail="消息过长，最多 4000 字符")

    msg = {
        "id": body.get("id") or f"msg_{uuid.uuid4().hex}",
        "channelId": channel_id,
        "senderId": sender_id,
        "senderName": sender_name,
        "senderColor": str(body.get("senderColor") or "#5865f2"),
        "senderPreset": str(body.get("senderPreset") or ""),
        "senderAvatarUrl": str(body.get("senderAvatarUrl") or ""),
        "content": content,
        "timestamp": body.get("timestamp") or int(time.time() * 1000),
        "reactions": {},
        "isSelf": False,
    }

    # 持久化
    db_save_message(msg)

    # Phase 3：REST 发送接口仅保留为兼容/调试入口，只持久化，不再通过 Presence 广播。
    # 新客户端实时发送应走 /ws/chat。
    return JSONResponse({"ok": True, "id": msg["id"], "realtime": "chat_ws_required"})


@app.post("/api/chat/reaction")
async def post_reaction(body: dict = Body(default_factory=dict)):
    """
    添加或取消 Reaction，并广播给所有在线成员。

    body: { messageId, emoji, senderId, channelId }
    """
    message_id = str(body.get("messageId") or "").strip()
    emoji = str(body.get("emoji") or "").strip()
    sender_id = str(body.get("senderId") or "").strip()
    channel_id = str(body.get("channelId") or "").strip()

    if not message_id or not emoji or not sender_id:
        raise HTTPException(status_code=400, detail="messageId / emoji / senderId 不能为空")

    # 读取当前 reactions
    msg = db_get_message(message_id)
    if not msg:
        raise HTTPException(status_code=404, detail="消息不存在")

    reactions = msg["reactions"]
    if emoji not in reactions:
        reactions[emoji] = []

    if sender_id in reactions[emoji]:
        reactions[emoji].remove(sender_id)
        if not reactions[emoji]:
            del reactions[emoji]
        action = "removed"
    else:
        reactions[emoji].append(sender_id)
        action = "added"

    # 持久化
    db_update_reactions(message_id, reactions)

    # Phase 3：REST Reaction 接口仅保留为兼容/调试入口，只持久化，不再通过 Presence 广播。
    # 新客户端实时 Reaction 应走 /ws/chat。
    return JSONResponse({"ok": True, "action": action, "reactions": reactions, "realtime": "chat_ws_required"})





def _safe_chat_channel_dir(channel_id: str) -> str:
    """把频道名转成安全目录名，聊天图片按频道分目录保存。"""
    value = re.sub(r"[^a-zA-Z0-9_-]", "_", str(channel_id or "lobby")).strip("_")
    return (value or "lobby")[:80]


def _upload_ext_from_mime(filename_orig: str, content_type: str, allowed_exts: set[str]) -> str:
    """根据原文件名和 MIME 推断安全扩展名。"""
    ext = filename_orig.rsplit(".", 1)[-1].lower() if "." in filename_orig else ""
    mime_default_ext = {
        "image/png": "png",
        "image/jpeg": "jpg",
        "image/webp": "webp",
        "image/gif": "gif",
    }.get(content_type, "png")
    if ext not in allowed_exts:
        ext = mime_default_ext
    return ext

def _safe_avatar_user_dir(user_id: str) -> str:
    """把 userId 转成安全目录名，保证每个用户的头像文件放在独立子目录。"""
    value = re.sub(r"[^a-zA-Z0-9_-]", "_", str(user_id or "anonymous")).strip("_")
    return (value or "anonymous")[:80]


def _avatar_file_path_from_url(avatar_url: str) -> Optional[str]:
    """只允许删除 /uploads/avatars/... 下的头像文件，避免误删其他路径。"""
    url = str(avatar_url or "")
    prefix = "/uploads/avatars/"
    if not url.startswith(prefix):
        return None
    rel = url[len("/uploads/"):]
    path = os.path.abspath(os.path.join(UPLOADS_DIR, rel))
    uploads_abs = os.path.abspath(UPLOADS_DIR)
    if not path.startswith(uploads_abs):
        return None
    return path


def db_add_avatar_history(user_id: str, avatar_url: str, filename: str, content_type: str, size_bytes: int) -> None:
    """记录用户头像历史，并按用户保留最近 N 个头像文件。"""
    user_id = str(user_id or "").strip()
    if not user_id or not avatar_url:
        return

    conn = get_db_conn()
    stale_rows = []
    try:
        now_ms = int(time.time() * 1000)
        conn.execute(
            """
            INSERT INTO user_avatar_history
                (user_id, avatar_url, filename, content_type, size_bytes, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (user_id, avatar_url, filename, content_type or "", int(size_bytes or 0), now_ms),
        )

        stale_rows = conn.execute(
            """
            SELECT id, avatar_url FROM user_avatar_history
            WHERE user_id = ?
            ORDER BY created_at DESC, id DESC
            LIMIT -1 OFFSET ?
            """,
            (user_id, AVATAR_HISTORY_LIMIT_PER_USER),
        ).fetchall()

        if stale_rows:
            ids = [int(row["id"]) for row in stale_rows]
            placeholders = ",".join("?" for _ in ids)
            conn.execute(f"DELETE FROM user_avatar_history WHERE id IN ({placeholders})", ids)
        conn.commit()
    finally:
        conn.close()

    # 数据库提交后再删磁盘旧文件；失败不影响主流程。
    for row in stale_rows:
        path = _avatar_file_path_from_url(row["avatar_url"])
        if not path:
            continue
        try:
            if os.path.exists(path):
                os.remove(path)
        except OSError:
            pass


def db_get_avatar_history(user_id: str, limit: int = AVATAR_HISTORY_LIMIT_PER_USER) -> List[dict]:
    user_id = str(user_id or "").strip()
    if not user_id:
        return []
    limit = max(1, min(int(limit or AVATAR_HISTORY_LIMIT_PER_USER), AVATAR_HISTORY_LIMIT_PER_USER))
    conn = get_db_conn()
    try:
        rows = conn.execute(
            """
            SELECT avatar_url, filename, content_type, size_bytes, created_at
            FROM user_avatar_history
            WHERE user_id = ?
            ORDER BY created_at DESC, id DESC
            LIMIT ?
            """,
            (user_id, limit),
        ).fetchall()
        return [
            {
                "avatarUrl": row["avatar_url"],
                "filename": row["filename"],
                "contentType": row["content_type"],
                "sizeBytes": row["size_bytes"],
                "createdAt": row["created_at"],
            }
            for row in rows
        ]
    finally:
        conn.close()

@app.get("/api/user/profile")
async def get_user_profile(
    userId: Optional[str] = Query(None),
    identity: Optional[str] = Query(None),
):
    """查询某个用户的资料缓存（优先 userId，兼容 identity）。"""
    key = (userId or identity or "").strip()
    if not key:
        raise HTTPException(status_code=400, detail="userId 或 identity 不能为空")
    profile = db_get_profile(key)
    if not profile:
        raise HTTPException(status_code=404, detail="用户不存在")
    return JSONResponse(profile)


@app.post("/api/user/profile")
async def save_user_profile(body: dict = Body(default_factory=dict)):
    """保存当前用户资料。

    新客户端按 userId 持久化 displayName/avatar/status，Presence 负责实时广播。
    """
    user_id = str(body.get("userId") or body.get("identity") or "").strip()
    if not user_id:
        raise HTTPException(status_code=400, detail="userId 不能为空")

    display_name = str(body.get("displayName") or "未命名用户").strip()[:24] or "未命名用户"
    avatar_color = str(body.get("avatarColor") or "#5865f2").strip()[:32] or "#5865f2"
    avatar_preset = str(body.get("avatarPreset") or "").strip()[:16]
    avatar_url = str(body.get("avatarUrl") or "").strip()[:512]
    status_text = str(body.get("statusText") or "在线").strip()[:32] or "在线"

    db_upsert_profile(
        user_id,
        display_name,
        avatar_color,
        avatar_preset,
        avatar_url,
        status_text=status_text,
        user_id=user_id,
    )
    profile = db_get_profile(user_id)
    return JSONResponse({"ok": True, "profile": profile})


@app.get("/api/user/avatar-history")
async def get_user_avatar_history(userId: str = Query(...), limit: int = Query(12)):
    """查询某个用户最近上传过的头像。"""
    user_id = str(userId or "").strip()
    if not user_id:
        raise HTTPException(status_code=400, detail="userId 不能为空")
    return JSONResponse({"ok": True, "userId": user_id, "items": db_get_avatar_history(user_id, limit)})


@app.post("/api/upload/avatar")
async def upload_avatar(file: UploadFile = File(...), userId: Optional[str] = Form(None)):
    """上传自定义头像，返回可访问的 URL。

    前端会优先上传已经裁剪/压缩后的头像；GIF 为了保留动图，允许原样上传。
    若传入 userId，则头像文件会放在 uploads/avatars/<userId>/ 下，并写入该用户的头像历史。
    """
    content_type = (file.content_type or "").lower().split(";")[0].strip()
    if content_type not in ALLOWED_AVATAR_MIME_TYPES:
        raise HTTPException(status_code=400, detail="只允许上传 png/jpg/jpeg/webp/gif 图片")

    filename_orig = file.filename or ""
    ext = filename_orig.rsplit(".", 1)[-1].lower() if "." in filename_orig else ""
    mime_default_ext = {
        "image/png": "png",
        "image/jpeg": "jpg",
        "image/webp": "webp",
        "image/gif": "gif",
    }.get(content_type, "png")
    if ext not in ALLOWED_AVATAR_EXTENSIONS:
        ext = mime_default_ext

    content = await file.read(MAX_AVATAR_UPLOAD_BYTES + 1)
    if len(content) > MAX_AVATAR_UPLOAD_BYTES:
        raise HTTPException(status_code=400, detail="图片不能超过 10MB")
    if not content:
        raise HTTPException(status_code=400, detail="上传文件为空")

    safe_user = _safe_avatar_user_dir(userId or "anonymous")
    avatar_dir = os.path.abspath(os.path.join(UPLOADS_DIR, "avatars", safe_user))
    uploads_abs = os.path.abspath(UPLOADS_DIR)
    if not avatar_dir.startswith(uploads_abs):
        raise HTTPException(status_code=400, detail="非法上传目录")
    os.makedirs(avatar_dir, exist_ok=True)

    filename = f"{uuid.uuid4().hex}.{ext}"
    filepath = os.path.abspath(os.path.join(avatar_dir, filename))
    if not filepath.startswith(avatar_dir):
        raise HTTPException(status_code=400, detail="非法文件路径")

    with open(filepath, "wb") as f:
        f.write(content)

    avatar_url = f"/uploads/avatars/{safe_user}/{filename}"
    if userId:
        db_add_avatar_history(
            str(userId).strip(),
            avatar_url,
            filename,
            content_type,
            len(content),
        )

    return {
        "ok": True,
        "url": avatar_url,
        "avatarUrl": avatar_url,
        "sizeBytes": len(content),
        "contentType": content_type,
    }


@app.post("/api/upload/chat-image")
async def upload_chat_image(
    file: UploadFile = File(...),
    channelId: Optional[str] = Form(None),
    userId: Optional[str] = Form(None),
):
    """上传聊天图片，返回可直接插入消息的图片 URL。

    聊天图片按频道保存：uploads/chat/<channelId>/<uuid>.<ext>。
    userId 仅用于后续审计/扩展，目前不进入文件名，避免泄漏身份。
    """
    content_type = (file.content_type or "").lower().split(";")[0].strip()
    if content_type not in ALLOWED_CHAT_IMAGE_MIME_TYPES:
        raise HTTPException(status_code=400, detail="只允许上传 png/jpg/jpeg/webp/gif 图片")

    ext = _upload_ext_from_mime(file.filename or "", content_type, ALLOWED_CHAT_IMAGE_EXTENSIONS)

    content = await file.read(MAX_CHAT_IMAGE_UPLOAD_BYTES + 1)
    if len(content) > MAX_CHAT_IMAGE_UPLOAD_BYTES:
        raise HTTPException(status_code=400, detail="聊天图片不能超过 20MB")
    if not content:
        raise HTTPException(status_code=400, detail="上传文件为空")

    safe_channel = _safe_chat_channel_dir(channelId or "lobby")
    chat_dir = os.path.abspath(os.path.join(UPLOADS_DIR, "chat", safe_channel))
    uploads_abs = os.path.abspath(UPLOADS_DIR)
    if not chat_dir.startswith(uploads_abs):
        raise HTTPException(status_code=400, detail="非法上传目录")
    os.makedirs(chat_dir, exist_ok=True)

    filename = f"{uuid.uuid4().hex}.{ext}"
    filepath = os.path.abspath(os.path.join(chat_dir, filename))
    if not filepath.startswith(chat_dir):
        raise HTTPException(status_code=400, detail="非法文件路径")

    with open(filepath, "wb") as f:
        f.write(content)

    image_url = f"/uploads/chat/{safe_channel}/{filename}"
    return {
        "ok": True,
        "url": image_url,
        "imageUrl": image_url,
        "sizeBytes": len(content),
        "contentType": content_type,
    }


# ============================================================
# Presence WebSocket
# ============================================================

@app.websocket("/ws/presence")
async def presence_websocket(websocket: WebSocket):
    """
    Presence WebSocket 入口。

    前端消息：
    - {"type":"join_channel", "channelId":"day0"}
    - {"type":"leave_channel"}
    - {"type":"request_snapshot"}
    - {"type":"ping"}
    - {"type":"update_profile", "avatarColor":"#xxx", "avatarPreset":"🎮"}   ← 新增
    """
    user = websocket.query_params.get("user", "访客").strip() or "访客"
    identity = websocket.query_params.get("identity")
    avatar_color = websocket.query_params.get("avatarColor", "#5865f2")
    avatar_preset = websocket.query_params.get("avatarPreset", "")
    avatar_url = websocket.query_params.get("avatarUrl", "")
    status_text = websocket.query_params.get("statusText", "在线")
    user_id = websocket.query_params.get("userId", "")
    connection_id = websocket.query_params.get("connectionId", "")

    if not identity:
        identity = f"{user}-{uuid.uuid4().hex[:8]}"

    connected = await presence_manager.connect(
        websocket,
        identity=identity,
        display_name=user,
        avatar_color=avatar_color,
        avatar_preset=avatar_preset,
        avatar_url=avatar_url,
        status_text=status_text or "在线",
        user_id=user_id or identity,
        connection_id=connection_id or identity,
    )

    if not connected:
        return

    try:
        while True:
            raw_message = await websocket.receive_text()

            try:
                message = json.loads(raw_message)
            except json.JSONDecodeError:
                await presence_manager.send_to(
                    identity,
                    {
                        "type": "error",
                        "message": "Presence 消息不是合法 JSON",
                        "raw": raw_message,
                    },
                )
                continue

            message_type = message.get("type")

            if message_type == "ping":
                await presence_manager.send_to(identity, {"type": "pong"})

            elif message_type == "join_channel":
                channel_id = message.get("channelId")
                try:
                    await presence_manager.move_to_channel(identity, channel_id)
                except ValueError as error:
                    await presence_manager.send_to(
                        identity,
                        {
                            "type": "error",
                            "message": str(error),
                            "action": "join_channel",
                        },
                    )

            elif message_type == "leave_channel":
                await presence_manager.move_to_channel(identity, None)

            elif message_type == "request_snapshot":
                await presence_manager.send_to(identity, presence_manager.build_snapshot())

            elif message_type == "update_profile":
                # 客户端头像信息变更（颜色/emoji/上传头像），广播给其他人
                new_color = str(message.get("avatarColor") or "#5865f2")
                new_preset = str(message.get("avatarPreset") or "")
                new_url = str(message.get("avatarUrl") or "")
                new_name = str(message.get("displayName") or "").strip() or None
                new_status = str(message.get("statusText") or "在线")
                await presence_manager.update_profile(identity, new_color, new_preset, new_url, display_name=new_name, status_text=new_status)

            else:
                await presence_manager.send_to(
                    identity,
                    {
                        "type": "error",
                        "message": f"未知 Presence 消息类型: {message_type}",
                    },
                )

    except WebSocketDisconnect:
        await presence_manager.disconnect(identity, websocket)

    except RuntimeError as error:
        error_text = str(error)
        if "WebSocket is not connected" in error_text:
            await presence_manager.disconnect(identity, websocket)
            return

        print(f"[presence] WebSocket 运行时异常: identity={identity}, error={error}")
        await presence_manager.disconnect(identity, websocket)

    except Exception as error:
        print(f"[presence] WebSocket 异常: identity={identity}, error={error}")
        await presence_manager.disconnect(identity, websocket)


# ============================================================
# Chat WebSocket（Phase 1：独立聊天通道基础）
# ============================================================

@app.websocket("/ws/chat")
async def chat_websocket(websocket: WebSocket):
    """
    Chat WebSocket 入口（Phase 1）。

    当前阶段用于验证独立聊天通道：
    - {"type":"ping"}
    - {"type":"subscribe_channel", "channelId":"day0"}
    - {"type":"unsubscribe_channel"}
    - {"type":"request_state"}

    后续 Phase 2 再承载 send_message / toggle_reaction。
    """
    user = websocket.query_params.get("user", "访客").strip() or "访客"
    user_id = websocket.query_params.get("userId", "").strip()
    connection_id = websocket.query_params.get("connectionId", "").strip()
    identity = websocket.query_params.get("identity", "").strip()
    avatar_color = websocket.query_params.get("avatarColor", "#5865f2").strip() or "#5865f2"
    avatar_preset = websocket.query_params.get("avatarPreset", "").strip()
    avatar_url = websocket.query_params.get("avatarUrl", "").strip()
    status_text = websocket.query_params.get("statusText", "在线").strip() or "在线"

    if not user_id:
        user_id = identity or f"u_{uuid.uuid4().hex[:12]}"
    if not connection_id:
        connection_id = f"conn_{uuid.uuid4().hex[:12]}"
    if not identity:
        identity = user_id

    connected = await chat_manager.connect(
        websocket,
        connection_id=connection_id,
        user_id=user_id,
        identity=identity,
        display_name=user,
        avatar_color=avatar_color,
        avatar_preset=avatar_preset,
        avatar_url=avatar_url,
        status_text=status_text,
    )
    if not connected:
        return

    try:
        while True:
            raw_message = await websocket.receive_text()

            try:
                message = json.loads(raw_message)
            except json.JSONDecodeError:
                await chat_manager.send_to_connection(
                    connection_id,
                    {
                        "type": "error",
                        "scope": "chat",
                        "message": "Chat 消息不是合法 JSON",
                        "raw": raw_message,
                    },
                    websocket=websocket,
                )
                continue

            message_type = message.get("type")

            if message_type == "ping":
                await chat_manager.send_to_connection(connection_id, {"type": "pong", "scope": "chat"})

            elif message_type == "subscribe_channel":
                try:
                    await chat_manager.subscribe_channel(connection_id, message.get("channelId"))
                except ValueError as error:
                    await chat_manager.send_to_connection(
                        connection_id,
                        {
                            "type": "error",
                            "scope": "chat",
                            "action": "subscribe_channel",
                            "message": str(error),
                        },
                    )

            elif message_type == "unsubscribe_channel":
                await chat_manager.subscribe_channel(connection_id, None)

            elif message_type == "request_state":
                conn = chat_manager.active_connections.get(connection_id)
                await chat_manager.send_to_connection(
                    connection_id,
                    {
                        "type": "chat_state",
                        "connectionId": connection_id,
                        "userId": user_id,
                        "identity": identity,
                        "displayName": user,
                        "channelId": conn.current_channel if conn else None,
                        "onlineChatConnections": chat_manager.get_connection_count(),
                    },
                )

            elif message_type == "send_message":
                try:
                    await chat_manager.handle_send_message(connection_id, message)
                except ValueError as error:
                    await chat_manager.send_to_connection(
                        connection_id,
                        {
                            "type": "message_ack",
                            "clientMessageId": message.get("clientMessageId"),
                            "status": "error",
                            "message": str(error),
                        },
                    )

            elif message_type == "toggle_reaction":
                try:
                    await chat_manager.handle_toggle_reaction(connection_id, message)
                except ValueError as error:
                    await chat_manager.send_to_connection(
                        connection_id,
                        {
                            "type": "reaction_ack",
                            "messageId": message.get("messageId"),
                            "emoji": message.get("emoji"),
                            "status": "error",
                            "message": str(error),
                        },
                    )

            else:
                await chat_manager.send_to_connection(
                    connection_id,
                    {
                        "type": "error",
                        "scope": "chat",
                        "message": f"未知 Chat 消息类型: {message_type}",
                    },
                )

    except WebSocketDisconnect:
        await chat_manager.disconnect(connection_id, websocket)

    except RuntimeError as error:
        error_text = str(error)
        if "WebSocket is not connected" in error_text:
            await chat_manager.disconnect(connection_id, websocket)
            return
        print(f"[chat] WebSocket 运行时异常: connectionId={connection_id}, error={error}")
        await chat_manager.disconnect(connection_id, websocket)

    except Exception as error:
        print(f"[chat] WebSocket 异常: connectionId={connection_id}, error={error}")
        await chat_manager.disconnect(connection_id, websocket)


# ============================================================
# 静态资源兜底
# ============================================================

assets_dir = os.path.join(UI_DIR, "assets")
if os.path.exists(assets_dir):
    app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")


# ============================================================
# 本地启动入口
# ============================================================

def run_server() -> None:
    """
    启动 FastAPI 后端服务。

    PyInstaller 打包后必须直接传 app 对象，不能使用 "main:app" 字符串。
    """
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=5000,
        reload=False,
    )


if __name__ == "__main__":
    import multiprocessing

    multiprocessing.freeze_support()
    run_server()
