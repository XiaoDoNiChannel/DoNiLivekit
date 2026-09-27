"""Room repository."""

from __future__ import annotations

from pathlib import Path

from .connection import connect


def list_rooms(db_path: str | Path) -> list[str]:
    connection = connect(db_path)
    try:
        rows = connection.execute("SELECT room_name FROM rooms WHERE deleted_at = 0 ORDER BY is_lobby DESC, id ASC").fetchall()
        return [row["room_name"] for row in rows]
    finally:
        connection.close()


def add_room(db_path: str | Path, room_name: str) -> None:
    connection = connect(db_path)
    try:
        existing = connection.execute("SELECT deleted_at FROM rooms WHERE room_name = ?", (room_name,)).fetchone()
        if existing and existing['deleted_at']:
            raise ValueError('频道名称已归档，请使用其他名称')
        connection.execute(
            "INSERT OR IGNORE INTO rooms (room_name) VALUES (?)", (room_name,)
        )
        connection.commit()
    finally:
        connection.close()


def room_metadata(db_path: str | Path) -> dict:
    connection = connect(db_path)
    try:
        return {row['room_name']: {'isLobby': bool(row['is_lobby']), 'deleted': bool(row['deleted_at'])}
                for row in connection.execute('SELECT room_name, is_lobby, deleted_at FROM rooms')}
    finally:
        connection.close()
