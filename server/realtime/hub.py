"""Small shared transport primitive used by independent realtime managers."""

from __future__ import annotations

from fastapi import WebSocket

from .protocol import encode_message


async def send_payload(websocket: WebSocket, payload: dict) -> None:
    await websocket.send_text(encode_message(payload))
