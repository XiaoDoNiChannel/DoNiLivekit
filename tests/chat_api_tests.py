import importlib
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

backend = importlib.import_module("server.app")


class ChatAndApiTests(unittest.TestCase):
    def setUp(self):
        self.temp_directory = tempfile.TemporaryDirectory()
        self.db_path = Path(self.temp_directory.name) / "rooms.db"
        self.db_patch = patch.object(backend, "DB_PATH", self.db_path)
        self.db_patch.start()
        backend.init_db()

    def tearDown(self):
        self.db_patch.stop()
        self.temp_directory.cleanup()

    def test_chat_history_and_reaction_round_trip(self):
        message = {
            "id": "message-1",
            "channelId": "day0",
            "senderId": "user-1",
            "senderName": "User",
            "content": "hello",
            "timestamp": 123,
            "reactions": {},
        }
        backend.db_save_message(message)
        backend.db_update_reactions("message-1", {"👍": ["user-2"]})
        history = backend.db_get_history("day0")
        self.assertEqual(len(history), 1)
        self.assertEqual(history[0]["content"], "hello")
        self.assertEqual(history[0]["reactions"], {"👍": ["user-2"]})

    def test_basic_rooms_api_uses_temporary_database(self):
        with (
            patch.object(
                backend,
                "list_livekit_rooms_and_participants",
                AsyncMock(return_value={}),
            ),
            TestClient(backend.app) as client,
        ):
            response = client.get("/api/rooms")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(any(room["name"] == "day0" for room in response.json()))


if __name__ == "__main__":
    unittest.main()
