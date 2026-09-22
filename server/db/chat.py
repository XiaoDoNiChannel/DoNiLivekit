"""Chat message repository."""

from __future__ import annotations

import json
from pathlib import Path

from .connection import connect


def save_message(db_path: str | Path, message: dict, max_per_channel: int) -> None:
    connection = connect(db_path)
    try:
        connection.execute(
            """
            INSERT OR REPLACE INTO chat_messages
                (id, channel_id, sender_id, sender_name, sender_color, sender_preset,
                 content, timestamp, reactions, sender_avatar_url)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                message["id"],
                message["channelId"],
                message["senderId"],
                message["senderName"],
                message.get("senderColor", "#5865f2"),
                message.get("senderPreset", ""),
                message["content"],
                message["timestamp"],
                json.dumps(message.get("reactions", {}), ensure_ascii=False),
                message.get("senderAvatarUrl", ""),
            ),
        )
        connection.execute(
            """
            DELETE FROM chat_messages
            WHERE channel_id = ? AND id NOT IN (
                SELECT id FROM chat_messages WHERE channel_id = ?
                ORDER BY timestamp DESC LIMIT ?
            )
            """,
            (message["channelId"], message["channelId"], max_per_channel),
        )
        connection.commit()
    finally:
        connection.close()


def get_history(
    db_path: str | Path,
    channel_id: str,
    limit: int = 50,
    before_ts: int | None = None,
) -> list[dict]:
    connection = connect(db_path)
    try:
        where = "m.channel_id = ?"
        arguments: tuple = (channel_id, limit)
        if before_ts is not None:
            where += " AND m.timestamp < ?"
            arguments = (channel_id, before_ts, limit)
        rows = connection.execute(
            f"""
            SELECT m.*, p.avatar_color AS current_color,
                   p.avatar_preset AS current_preset, p.avatar_url AS current_url
            FROM chat_messages m
            LEFT JOIN user_profiles p ON m.sender_id = p.identity
            WHERE {where}
            ORDER BY m.timestamp DESC LIMIT ?
            """,
            arguments,
        ).fetchall()
        result = []
        for row in reversed(rows):
            current_color = row["current_color"]
            current_preset = row["current_preset"]
            current_url = row["current_url"]
            result.append(
                {
                    "id": row["id"],
                    "channelId": row["channel_id"],
                    "senderId": row["sender_id"],
                    "senderName": row["sender_name"],
                    "senderColor": current_color or row["sender_color"],
                    "senderPreset": (
                        current_preset
                        if current_preset is not None
                        else row["sender_preset"]
                    ),
                    "senderAvatarUrl": current_url or row["sender_avatar_url"],
                    "content": row["content"],
                    "timestamp": row["timestamp"],
                    "reactions": json.loads(row["reactions"] or "{}"),
                    "isSelf": False,
                }
            )
        return result
    finally:
        connection.close()


def update_reactions(db_path: str | Path, message_id: str, reactions: dict) -> None:
    connection = connect(db_path)
    try:
        connection.execute(
            "UPDATE chat_messages SET reactions = ? WHERE id = ?",
            (json.dumps(reactions, ensure_ascii=False), message_id),
        )
        connection.commit()
    finally:
        connection.close()


def get_message(db_path: str | Path, message_id: str) -> dict | None:
    connection = connect(db_path)
    try:
        row = connection.execute(
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
        connection.close()
