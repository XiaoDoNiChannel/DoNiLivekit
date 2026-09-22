"""LiveKit token creation boundary."""

from __future__ import annotations

import uuid

from livekit.api import AccessToken, VideoGrants


def build_room_token(
    api_key: str,
    api_secret: str,
    user_name: str,
    room_name: str,
    identity: str | None = None,
) -> str:
    clean_user = (user_name or "访客").strip() or "访客"
    clean_room = (room_name or "team-meeting-room").strip() or "team-meeting-room"
    livekit_identity = identity or f"{clean_user}-{uuid.uuid4().hex[:8]}"
    return (
        AccessToken(api_key, api_secret)
        .with_identity(livekit_identity)
        .with_name(clean_user)
        .with_grants(VideoGrants(room_join=True, room=clean_room))
        .to_jwt()
    )
