"""Reserved LiveKit webhook boundary.

P1 intentionally does not expose a webhook route because deployment signing
credentials and a callback URL are not yet configured. Future work must verify
LiveKit signatures before forwarding only the supported presence events.
"""

SUPPORTED_PRESENCE_EVENTS = frozenset(
    {
        "participant_joined",
        "participant_left",
        "participant_connection_aborted",
        "room_finished",
    }
)
