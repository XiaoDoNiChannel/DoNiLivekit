"""User profile repository."""

from __future__ import annotations

import time
from pathlib import Path

from .connection import connect


def upsert_profile(
    db_path: str | Path,
    identity: str,
    display_name: str,
    avatar_color: str,
    avatar_preset: str,
    avatar_url: str = "",
    status_text: str = "在线",
    user_id: str | None = None,
) -> None:
    clean_identity = (identity or user_id or "").strip()
    if not clean_identity:
        return
    clean_user_id = (user_id or clean_identity).strip()
    clean_name = (display_name or "未命名用户").strip()[:24] or "未命名用户"
    clean_status = (status_text or "在线").strip()[:32] or "在线"
    connection = connect(db_path)
    try:
        connection.execute(
            """
            INSERT INTO user_profiles
                (identity, user_id, display_name, avatar_color, avatar_preset,
                 avatar_url, status_text, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(identity) DO UPDATE SET
                user_id=excluded.user_id, display_name=excluded.display_name,
                avatar_color=excluded.avatar_color, avatar_preset=excluded.avatar_preset,
                avatar_url=excluded.avatar_url, status_text=excluded.status_text,
                updated_at=excluded.updated_at
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
        connection.commit()
    finally:
        connection.close()


def get_profile(db_path: str | Path, identity: str) -> dict | None:
    clean_identity = (identity or "").strip()
    if not clean_identity:
        return None
    connection = connect(db_path)
    try:
        row = connection.execute(
            "SELECT * FROM user_profiles WHERE identity = ? OR user_id = ? LIMIT 1",
            (clean_identity, clean_identity),
        ).fetchone()
        if not row:
            return None
        user_id = row["user_id"] or row["identity"]
        return {
            "identity": row["identity"],
            "userId": user_id,
            "displayName": row["display_name"],
            "avatarColor": row["avatar_color"],
            "avatarPreset": row["avatar_preset"],
            "avatarUrl": row["avatar_url"],
            "statusText": row["status_text"],
            "updatedAt": row["updated_at"],
        }
    finally:
        connection.close()
