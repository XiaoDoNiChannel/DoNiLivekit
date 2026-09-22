"""Room repository."""

from __future__ import annotations

from pathlib import Path

from .connection import connect


def list_rooms(db_path: str | Path) -> list[str]:
    connection = connect(db_path)
    try:
        rows = connection.execute("SELECT room_name FROM rooms ORDER BY id ASC").fetchall()
        return [row["room_name"] for row in rows]
    finally:
        connection.close()


def add_room(db_path: str | Path, room_name: str) -> None:
    connection = connect(db_path)
    try:
        connection.execute(
            "INSERT OR IGNORE INTO rooms (room_name) VALUES (?)", (room_name,)
        )
        connection.commit()
    finally:
        connection.close()
