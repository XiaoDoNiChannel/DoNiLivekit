"""Environment-backed paths and service settings."""

from __future__ import annotations

import os
import sys
from pathlib import Path


def get_base_dir() -> Path:
    override = os.environ.get("DONICHANNEL_BASE_DIR", "").strip()
    if override:
        return Path(override).expanduser().resolve()
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent.parent


BASE_DIR = get_base_dir()


def get_server_version() -> str:
    configured = os.environ.get("DONICHANNEL_SERVER_VERSION", "").strip()
    if configured:
        return configured
    candidates = (
        BASE_DIR / "server-version.txt",
        Path(__file__).resolve().parent / "VERSION",
    )
    for candidate in candidates:
        try:
            value = candidate.read_text(encoding="utf-8-sig").strip()
            if value:
                return value
        except OSError:
            continue
    return "1.0.0"


SERVER_VERSION = get_server_version()
DB_PATH = Path(os.environ.get("DONICHANNEL_DB_PATH", BASE_DIR / "rooms.db")).resolve()
UPLOADS_DIR = Path(os.environ.get("DONICHANNEL_UPLOADS_DIR", BASE_DIR / "uploads")).resolve()
DOWNLOADS_DIR = Path(os.environ.get("DONICHANNEL_DOWNLOADS_DIR", BASE_DIR / "downloads")).resolve()
UPDATE_BASE_URL = os.environ.get("DONICHANNEL_UPDATE_BASE_URL", "").strip().rstrip("/")

UI_DIST_DIR = BASE_DIR / "ui" / "dist"
UI_SRC_DIR = BASE_DIR / "ui"
UI_DIR = UI_DIST_DIR if UI_DIST_DIR.exists() else UI_SRC_DIR

API_KEY = os.environ.get("LIVEKIT_API_KEY", "devkey")
API_SECRET = os.environ.get("LIVEKIT_API_SECRET", "secret")
LIVEKIT_URL = os.environ.get("LIVEKIT_URL", "http://127.0.0.1:7880")

PRESENCE_TTL_SECONDS = float(os.environ.get("DONICHANNEL_PRESENCE_TTL_SECONDS", "45"))
PRESENCE_CLEANUP_INTERVAL_SECONDS = float(
    os.environ.get("DONICHANNEL_PRESENCE_CLEANUP_INTERVAL_SECONDS", "5")
)
