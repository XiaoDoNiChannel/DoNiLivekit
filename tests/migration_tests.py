import sqlite3
import tempfile
import unittest
from pathlib import Path

from server.db.migrations import LATEST_SCHEMA_VERSION, migrate_database


class MigrationTests(unittest.TestCase):
    def test_legacy_database_is_backed_up_migrated_and_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            db_path = Path(directory) / "rooms.db"
            connection = sqlite3.connect(db_path)
            connection.executescript(
                """
                CREATE TABLE rooms (id INTEGER PRIMARY KEY AUTOINCREMENT, room_name TEXT UNIQUE);
                INSERT INTO rooms(room_name) VALUES ('legacy-room');
                CREATE TABLE chat_messages (
                    id TEXT PRIMARY KEY, channel_id TEXT, sender_id TEXT, sender_name TEXT,
                    sender_color TEXT, sender_preset TEXT, content TEXT, timestamp INTEGER,
                    reactions TEXT
                );
                INSERT INTO chat_messages VALUES
                    ('m1', 'legacy-room', 'u1', 'User', '#fff', '', 'hello', 1, '{}');
                """
            )
            connection.commit()
            connection.close()

            version, backup_path = migrate_database(db_path, ["day0"])
            self.assertEqual(version, LATEST_SCHEMA_VERSION)
            self.assertIsNotNone(backup_path)
            self.assertTrue(backup_path.is_file())

            connection = sqlite3.connect(db_path)
            room = connection.execute("SELECT room_name FROM rooms").fetchone()[0]
            message = connection.execute("SELECT content FROM chat_messages").fetchone()[0]
            columns = {
                row[1] for row in connection.execute("PRAGMA table_info(chat_messages)")
            }
            schema_version = connection.execute(
                "SELECT MAX(version) FROM schema_version"
            ).fetchone()[0]
            connection.close()
            self.assertEqual(room, "legacy-room")
            self.assertEqual(message, "hello")
            self.assertIn("sender_avatar_url", columns)
            self.assertEqual(schema_version, LATEST_SCHEMA_VERSION)

            _, second_backup = migrate_database(db_path, ["day0"])
            self.assertIsNone(second_backup)


if __name__ == "__main__":
    unittest.main()
