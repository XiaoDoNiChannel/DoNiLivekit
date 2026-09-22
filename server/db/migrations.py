"""Forward-only, data-preserving SQLite migrations."""

from __future__ import annotations

import logging
import sqlite3
import time
from pathlib import Path
from typing import Iterable

from .connection import connect

LOGGER = logging.getLogger("donichannel.db.migrations")
LATEST_SCHEMA_VERSION = 3


def _current_version(connection: sqlite3.Connection) -> int:
    exists = connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_version'"
    ).fetchone()
    if not exists:
        return 0
    row = connection.execute("SELECT MAX(version) AS version FROM schema_version").fetchone()
    return int(row["version"] or 0)


def _backup_database(path: Path, from_version: int) -> Path | None:
    if not path.exists() or path.stat().st_size == 0:
        return None
    timestamp = time.strftime("%Y%m%d-%H%M%S")
    backup_path = path.with_name(
        f"{path.name}.backup-v{from_version}-to-v{LATEST_SCHEMA_VERSION}-{timestamp}"
    )
    source = sqlite3.connect(path)
    destination = sqlite3.connect(backup_path)
    try:
        source.backup(destination)
    finally:
        destination.close()
        source.close()
    LOGGER.info("action=backup source=%s destination=%s", path, backup_path)
    return backup_path


def _migration_1(connection: sqlite3.Connection, default_rooms: Iterable[str]) -> None:
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS rooms (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            room_name TEXT NOT NULL UNIQUE
        )
        """
    )
    if connection.execute("SELECT COUNT(*) AS count FROM rooms").fetchone()["count"] == 0:
        connection.executemany(
            "INSERT OR IGNORE INTO rooms (room_name) VALUES (?)",
            [(name,) for name in default_rooms],
        )


def _migration_2(connection: sqlite3.Connection, _default_rooms: Iterable[str]) -> None:
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS chat_messages (
            id TEXT PRIMARY KEY,
            channel_id TEXT NOT NULL,
            sender_id TEXT NOT NULL,
            sender_name TEXT NOT NULL,
            sender_color TEXT NOT NULL DEFAULT '#5865f2',
            sender_preset TEXT NOT NULL DEFAULT '',
            content TEXT NOT NULL,
            timestamp INTEGER NOT NULL,
            reactions TEXT NOT NULL DEFAULT '{}',
            sender_avatar_url TEXT NOT NULL DEFAULT ''
        )
        """
    )
    columns = {
        row["name"] for row in connection.execute("PRAGMA table_info(chat_messages)").fetchall()
    }
    if "sender_avatar_url" not in columns:
        connection.execute(
            "ALTER TABLE chat_messages ADD COLUMN sender_avatar_url TEXT NOT NULL DEFAULT ''"
        )
    connection.execute(
        "CREATE INDEX IF NOT EXISTS idx_chat_channel_ts ON chat_messages (channel_id, timestamp)"
    )


def _migration_3(connection: sqlite3.Connection, _default_rooms: Iterable[str]) -> None:
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS user_profiles (
            identity TEXT PRIMARY KEY,
            user_id TEXT NOT NULL DEFAULT '',
            display_name TEXT NOT NULL,
            avatar_color TEXT NOT NULL DEFAULT '#5865f2',
            avatar_preset TEXT NOT NULL DEFAULT '',
            avatar_url TEXT NOT NULL DEFAULT '',
            status_text TEXT NOT NULL DEFAULT '在线',
            updated_at INTEGER NOT NULL DEFAULT 0
        )
        """
    )
    profile_columns = {
        row["name"] for row in connection.execute("PRAGMA table_info(user_profiles)").fetchall()
    }
    for name, ddl in (
        ("user_id", "TEXT NOT NULL DEFAULT ''"),
        ("avatar_url", "TEXT NOT NULL DEFAULT ''"),
        ("status_text", "TEXT NOT NULL DEFAULT '在线'"),
    ):
        if name not in profile_columns:
            connection.execute(f"ALTER TABLE user_profiles ADD COLUMN {name} {ddl}")

    connection.execute(
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
    connection.execute(
        "CREATE INDEX IF NOT EXISTS idx_avatar_history_user_created "
        "ON user_avatar_history (user_id, created_at DESC)"
    )


MIGRATIONS = {1: _migration_1, 2: _migration_2, 3: _migration_3}


def migrate_database(
    db_path: str | Path, default_rooms: Iterable[str]
) -> tuple[int, Path | None]:
    path = Path(db_path)
    connection = connect(path)
    try:
        current = _current_version(connection)
    finally:
        connection.close()

    if current >= LATEST_SCHEMA_VERSION:
        return current, None

    backup_path = _backup_database(path, current)
    connection = connect(path)
    try:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS schema_version (
                version INTEGER PRIMARY KEY,
                applied_at INTEGER NOT NULL
            )
            """
        )
        with connection:
            for version in range(current + 1, LATEST_SCHEMA_VERSION + 1):
                MIGRATIONS[version](connection, default_rooms)
                connection.execute(
                    "INSERT OR REPLACE INTO schema_version(version, applied_at) VALUES (?, ?)",
                    (version, int(time.time() * 1000)),
                )
                LOGGER.info("action=apply version=%s database=%s", version, path)
    finally:
        connection.close()
    return LATEST_SCHEMA_VERSION, backup_path
