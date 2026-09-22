"""Read-only LiveKit service queries used by legacy room polling."""

from __future__ import annotations

import logging

from livekit.api import LiveKitAPI, ListParticipantsRequest, ListRoomsRequest

LOGGER = logging.getLogger("donichannel.livekit.client")


async def list_rooms_and_participants(
    livekit_url: str, api_key: str, api_secret: str
) -> dict[str, list[str]]:
    result: dict[str, list[str]] = {}
    async with LiveKitAPI(livekit_url, api_key, api_secret) as livekit:
        try:
            rooms_response = await livekit.room.list_rooms(ListRoomsRequest())
            for room in rooms_response.rooms:
                participants_response = await livekit.room.list_participants(
                    ListParticipantsRequest(room=room.name)
                )
                result[room.name] = [
                    participant.name or participant.identity
                    for participant in participants_response.participants
                ]
        except Exception as error:
            LOGGER.warning("action=list_rooms_failed error=%s", error)
    return result
