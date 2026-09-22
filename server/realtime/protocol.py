"""Shared JSON and heartbeat protocol helpers for realtime sockets."""

from __future__ import annotations

import json
import time


class ProtocolMessageError(ValueError):
    pass


def decode_message(raw_message: str, scope: str) -> dict:
    try:
        message = json.loads(raw_message)
    except json.JSONDecodeError as error:
        raise ProtocolMessageError(f"{scope} 消息不是合法 JSON") from error
    if not isinstance(message, dict):
        raise ProtocolMessageError(f"{scope} 消息必须是 JSON 对象")
    return message


def encode_message(payload: dict) -> str:
    return json.dumps(payload, ensure_ascii=False)


def heartbeat_response(scope: str) -> dict:
    payload = {"type": "pong", "serverTime": time.time()}
    if scope == "chat":
        payload["scope"] = "chat"
    return payload
