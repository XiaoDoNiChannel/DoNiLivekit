import sqlite3
import tempfile
import unittest
from unittest.mock import patch
from contextlib import closing
from pathlib import Path

from server.db.migrations import LATEST_SCHEMA_VERSION, migrate_database


class MigrationTests(unittest.TestCase):
    def test_version_three_upgrade_keeps_ids_and_channel_history(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'v3.db'
            with patch('server.db.migrations.LATEST_SCHEMA_VERSION', 3):
                migrate_database(path, ['day0', '自定义频道'])
            with closing(sqlite3.connect(path)) as db, db:
                before = db.execute('SELECT id,room_name FROM rooms').fetchall()
                db.execute("INSERT INTO chat_messages(id,channel_id,sender_id,sender_name,content,timestamp) VALUES('keep','day0','u','U','old history',1)")
            version, backup = migrate_database(path, ['different-default'])
            self.assertEqual(version, 4)
            self.assertTrue(backup.is_file())
            with closing(sqlite3.connect(path)) as db:
                self.assertEqual(db.execute('SELECT id,room_name FROM rooms').fetchall(), before)
                self.assertEqual(db.execute('SELECT room_name FROM rooms WHERE is_lobby=1').fetchone()[0], 'day0')
                self.assertEqual(db.execute('SELECT content FROM chat_messages').fetchone()[0], 'old history')
                self.assertEqual(db.execute('SELECT COUNT(*) FROM party_cards').fetchone()[0], 0)

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
