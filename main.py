"""
DoNiChannel 后端入口（FastAPI 版）。

职责：
1. 提供 LiveKit token。
2. 管理语音频道列表。
3. 提供 Presence WebSocket，用于实时同步"谁在线、谁在哪个语音频道"。
4. 兼容旧客户端的 /api/rooms 轮询接口。
5. 聊天消息持久化（SQLite）+ 历史记录拉取。
6. Reaction 实时同步（通过 Presence WebSocket 广播）。
7. 用户资料广播（头像颜色、emoji，让其他客户端渲染正确头像）。

注意：
- LiveKit 负责音频、屏幕共享、Track 订阅。
- Presence WebSocket 负责大厅在线状态、频道成员状态、聊天消息广播、Reaction 同步。
- Rust 9001/9002 本地音频采集不经过这里。
"""

from __future__ import annotations

import asyncio
import json
import os
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
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Body, Query, UploadFile, File
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

os.makedirs(os.path.join(BASE_DIR, "uploads"), exist_ok=True)
app.mount("/uploads", StaticFiles(directory=os.path.join(BASE_DIR, "uploads")), name="uploads")

def get_db_conn() -> sqlite3.Connection:
    """创建 SQLite 连接。"""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


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
                display_name TEXT NOT NULL,
                avatar_color TEXT NOT NULL DEFAULT '#5865f2',
                avatar_preset TEXT NOT NULL DEFAULT '',
                avatar_url    TEXT NOT NULL DEFAULT '',
                updated_at   INTEGER NOT NULL DEFAULT 0
            )
            """
        )

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

def db_upsert_profile(identity: str, display_name: str, avatar_color: str, avatar_preset: str, avatar_url: str = "") -> None:
    """更新/插入用户资料缓存。"""
    conn = get_db_conn()
    try:
        conn.execute(
            """
            INSERT INTO user_profiles (identity, display_name, avatar_color, avatar_preset, avatar_url, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(identity) DO UPDATE SET
                display_name  = excluded.display_name,
                avatar_color  = excluded.avatar_color,
                avatar_preset = excluded.avatar_preset,
                avatar_url    = excluded.avatar_url,
                updated_at    = excluded.updated_at
            """,
            (identity, display_name, avatar_color, avatar_preset, avatar_url, int(time.time() * 1000)),
        )
        conn.commit()
    finally:
        conn.close()


def db_get_profile(identity: str) -> Optional[dict]:
    """读取用户资料缓存。"""
    conn = get_db_conn()
    try:
        row = conn.execute(
            "SELECT * FROM user_profiles WHERE identity = ?", (identity,)
        ).fetchone()
        if not row:
            return None
        return {
            "identity": row["identity"],
            "displayName": row["display_name"],
            "avatarColor": row["avatar_color"],
            "avatarPreset": row["avatar_preset"],
            "avatarUrl": row["avatar_url"] if "avatar_url" in row.keys() else "",
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
    """Presence 层在线用户状态（含头像信息）。"""
    identity: str
    display_name: str
    current_channel: Optional[str] = None
    avatar_color: str = "#5865f2"
    avatar_preset: str = ""
    avatar_url: str = ""


class PresenceManager:
    """
    管理大厅在线状态、语音频道成员状态。
    同时作为聊天消息和 Reaction 的广播中心。

    只负责 Presence + 聊天广播，不负责音频。
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
                    "displayName": participant.display_name,
                    "avatarColor": participant.avatar_color,
                    "avatarPreset": participant.avatar_preset,
                    "avatarUrl": participant.avatar_url,
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
                "displayName": participant.display_name,
                "currentChannel": participant.current_channel,
                "avatarColor": participant.avatar_color,
                "avatarPreset": participant.avatar_preset,
                "avatarUrl": participant.avatar_url,
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
                current_channel=old_channel,
                avatar_color=avatar_color,
                avatar_preset=avatar_preset,
                avatar_url=avatar_url,
            )

        # 持久化用户资料（供历史消息渲染使用）
        db_upsert_profile(identity, display_name, avatar_color, avatar_preset, avatar_url)

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
                        "displayName": display_name,
                        "currentChannel": old_channel,
                        "avatarColor": avatar_color,
                        "avatarPreset": avatar_preset,
                        "avatarUrl": avatar_url,
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
                "displayName": participant.display_name,
                "from": old_channel,
                "to": clean_channel,
                # 同步携带头像信息，避免频道成员列表中头像显示异常
                "avatarColor": participant.avatar_color,
                "avatarPreset": participant.avatar_preset,
                "avatarUrl": participant.avatar_url,
            }

        await self.broadcast(payload)

    async def update_profile(self, identity: str, avatar_color: str, avatar_preset: str, avatar_url: str) -> None:
        """更新用户头像信息，并广播给其他人。"""
        async with self.lock:
            participant = self.participants.get(identity)
            if not participant:
                return
            participant.avatar_color = avatar_color
            participant.avatar_preset = avatar_preset
            participant.avatar_url = avatar_url

        db_upsert_profile(identity, participant.display_name, avatar_color, avatar_preset, avatar_url)

        await self.broadcast(
            {
                "type": "profile_updated",
                "identity": identity,
                "displayName": participant.display_name,
                "avatarColor": avatar_color,
                "avatarPreset": avatar_preset,
                "avatarUrl": avatar_url,
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


presence_manager = PresenceManager()


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
async def clear_chat_history(channel: Optional[str] = Query(None, description="频道 ID，不传则清空全部")):
    """清空聊天记录（指定频道或全部频道）。"""
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

    # 通过 Presence WebSocket 广播给频道内所有在线成员
    broadcast_payload = {
        "type": "chat_message",
        "message": msg,
    }
    await presence_manager.broadcast(broadcast_payload, exclude_identity=sender_id)

    return JSONResponse({"ok": True, "id": msg["id"]})


@app.post("/api/chat/reaction")
async def post_reaction(body: dict = Body(default_factory=dict)):
    """
    添加或取消 Reaction，并广播给所有在线成员。

    body: { messageId, emoji, senderId, channelId }
    
    使用单连接事务原子完成读-改-写，防止并发点击时 reaction 互相覆盖（Lost Update）。
    """
    message_id = str(body.get("messageId") or "").strip()
    emoji = str(body.get("emoji") or "").strip()
    sender_id = str(body.get("senderId") or "").strip()
    channel_id = str(body.get("channelId") or "").strip()

    if not message_id or not emoji or not sender_id:
        raise HTTPException(status_code=400, detail="messageId / emoji / senderId 不能为空")

    # 在单个连接的事务中原子完成读-改-写，防止并发丢失更新
    conn = get_db_conn()
    try:
        # BEGIN IMMEDIATE 获取写锁，防止并发竞争
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT reactions FROM chat_messages WHERE id = ?", (message_id,)
        ).fetchone()

        if not row:
            conn.rollback()
            raise HTTPException(status_code=404, detail="消息不存在")

        reactions = json.loads(row["reactions"] or "{}")

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

        conn.execute(
            "UPDATE chat_messages SET reactions = ? WHERE id = ?",
            (json.dumps(reactions, ensure_ascii=False), message_id),
        )
        conn.commit()
    except HTTPException:
        raise
    except Exception as e:
        conn.rollback()
        raise HTTPException(status_code=500, detail=f"更新 Reaction 失败: {e}") from e
    finally:
        conn.close()

    # 广播（排除发起者，发起者通过 POST 响应数据自行校准本地状态）
    broadcast_payload = {
        "type": "reaction_update",
        "messageId": message_id,
        "channelId": channel_id,
        "emoji": emoji,
        "senderId": sender_id,
        "action": action,
        "reactions": reactions,
    }
    await presence_manager.broadcast(broadcast_payload, exclude_identity=sender_id)

    return JSONResponse({"ok": True, "action": action, "reactions": reactions})



@app.get("/api/user/profile")
async def get_user_profile(identity: str = Query(...)):
    """查询某个用户的资料缓存（头像颜色、emoji）。"""
    profile = db_get_profile(identity)
    if not profile:
        raise HTTPException(status_code=404, detail="用户不存在")
    return JSONResponse(profile)


@app.post("/api/upload/avatar")
async def upload_avatar(file: UploadFile = File(...)):
    """上传自定义头像，返回可访问的 URL。"""
    content_type = file.content_type or ""
    if not content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="必须上传图片文件")
    
    filename_orig = file.filename or ""
    ext = filename_orig.split(".")[-1] if "." in filename_orig else "png"
    # 防御性：避免没有扩展名或过长
    if not ext or len(ext) > 10:
        ext = "png"
        
    filename = f"{uuid.uuid4().hex}.{ext}"
    filepath = os.path.join(BASE_DIR, "uploads", filename)
    
    content = await file.read()
    if len(content) > 5 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="图片不能超过 5MB")
        
    with open(filepath, "wb") as f:
        f.write(content)
        
    return {"ok": True, "url": f"/uploads/{filename}"}


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

    if not identity:
        identity = f"{user}-{uuid.uuid4().hex[:8]}"

    connected = await presence_manager.connect(
        websocket,
        identity=identity,
        display_name=user,
        avatar_color=avatar_color,
        avatar_preset=avatar_preset,
        avatar_url=avatar_url,
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
                await presence_manager.update_profile(identity, new_color, new_preset, new_url)

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
