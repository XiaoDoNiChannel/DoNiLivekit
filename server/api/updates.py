"""Tauri updater manifest and signed bundle download endpoints."""

from __future__ import annotations

import json
import logging
import re
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import unquote, urlparse

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import FileResponse, JSONResponse

from ..config import DOWNLOADS_DIR, UPDATE_BASE_URL

LOGGER = logging.getLogger("donichannel.api.updates")
router = APIRouter()


def _version_key(value: str) -> tuple[tuple[int, ...], int, str]:
    clean = value.strip().lstrip("v")
    match = re.fullmatch(r"(\d+(?:\.\d+)*)(?:[-+]([^+]+))?", clean)
    if not match:
        return ((0,), 0, clean)
    numbers = tuple(int(part) for part in match.group(1).split("."))
    prerelease = match.group(2) or ""
    return (numbers, 1 if not prerelease else 0, prerelease)


def _platform_entry(manifest: dict, target: str, arch: str) -> dict | None:
    platforms = manifest.get("platforms") or {}
    aliases = {
        "x86_64": ("x86_64", "x64"),
        "aarch64": ("aarch64", "arm64"),
        "i686": ("i686", "x86"),
    }
    candidates = [f"{target}-{name}" for name in aliases.get(arch, (arch,))]
    candidates.extend((target, arch))
    for candidate in candidates:
        entry = platforms.get(candidate)
        if isinstance(entry, dict):
            return entry
    if all(key in manifest for key in ("url", "signature")):
        return manifest
    return None


def _local_download_url(request: Request, configured_url: str) -> str:
    filename = Path(unquote(urlparse(configured_url).path)).name
    if not filename:
        raise ValueError("update manifest URL has no filename")
    if UPDATE_BASE_URL:
        return f"{UPDATE_BASE_URL}/{filename}"
    return str(request.base_url).rstrip("/") + f"/downloads/{filename}"


@router.get("/api/update/{target}/{arch}/{current_version}")
async def get_update(
    request: Request, target: str, arch: str, current_version: str
) -> Response:
    manifest_path = DOWNLOADS_DIR / "latest.json"
    if not manifest_path.is_file():
        return Response(status_code=204)

    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        version = str(manifest.get("version") or "").strip().lstrip("v")
        if not version or _version_key(version) <= _version_key(current_version):
            return Response(status_code=204)

        entry = _platform_entry(manifest, target, arch)
        if not entry or not entry.get("signature") or not entry.get("url"):
            LOGGER.info(
                "action=no_compatible_artifact target=%s arch=%s version=%s",
                target,
                arch,
                version,
            )
            return Response(status_code=204)

        filename = Path(unquote(urlparse(str(entry["url"])).path)).name
        if not (DOWNLOADS_DIR / filename).is_file() and not UPDATE_BASE_URL:
            LOGGER.warning("action=artifact_missing filename=%s", filename)
            return Response(status_code=204)

        pub_date = manifest.get("pub_date") or manifest.get("pubDate")
        if not pub_date:
            pub_date = datetime.fromtimestamp(
                manifest_path.stat().st_mtime, tz=timezone.utc
            ).isoformat().replace("+00:00", "Z")
        return JSONResponse(
            {
                "version": version,
                "url": _local_download_url(request, str(entry["url"])),
                "signature": entry["signature"],
                "notes": manifest.get("notes") or "",
                "pub_date": pub_date,
            }
        )
    except (OSError, ValueError, TypeError, json.JSONDecodeError) as error:
        LOGGER.warning("action=read_manifest_failed error=%s", error)
        return Response(status_code=204)


@router.get("/downloads/{filename}")
async def download_update(filename: str) -> FileResponse:
    clean_name = Path(filename).name
    if clean_name != filename or clean_name in {"", ".", ".."}:
        raise HTTPException(status_code=404, detail="安装包不存在")
    path = DOWNLOADS_DIR / clean_name
    if not path.is_file():
        raise HTTPException(status_code=404, detail="安装包不存在")
    return FileResponse(path, filename=clean_name, media_type="application/octet-stream")


__all__ = ["router", "_version_key"]
