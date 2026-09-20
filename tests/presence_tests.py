import json
import unittest

from main import PresenceManager


class FakeWebSocket:
    def __init__(self):
        self.accepted = False
        self.closed = False
        self.messages = []

    async def accept(self):
        self.accepted = True

    async def send_text(self, message):
        self.messages.append(json.loads(message))

    async def close(self, code=1000):
        self.closed = True
        self.close_code = code


class PresenceManagerTests(unittest.IsolatedAsyncioTestCase):
    async def test_old_connection_disconnect_does_not_remove_new_generation(self):
        manager = PresenceManager(server_epoch="test-epoch")
        old_socket = FakeWebSocket()
        old_generation = await manager.connect(old_socket, "same-user", "旧连接")
        await manager.move_to_channel("same-user", "day0")

        new_socket = FakeWebSocket()
        new_generation = await manager.connect(new_socket, "same-user", "新连接")
        await manager.disconnect("same-user", old_socket, old_generation)

        self.assertNotEqual(old_generation, new_generation)
        self.assertIs(manager.active_connections["same-user"].websocket, new_socket)
        self.assertEqual(manager.participants["same-user"].current_channel, "day0")

    async def test_ttl_cleanup_removes_ghost_member_and_emits_versioned_offline(self):
        manager = PresenceManager(server_epoch="test-epoch")
        observer = FakeWebSocket()
        await manager.connect(observer, "observer", "观察者")
        ghost = FakeWebSocket()
        await manager.connect(ghost, "ghost", "幽灵")
        await manager.move_to_channel("ghost", "day0")
        manager.active_connections["observer"].last_seen = 100.0
        manager.active_connections["ghost"].last_seen = 0.0

        removed = await manager.cleanup_stale(now=20.0, ttl_seconds=10.0)

        self.assertEqual(removed, ["ghost"])
        self.assertNotIn("ghost", manager.participants)
        offline = [item for item in observer.messages if item.get("type") == "participant_offline"][-1]
        self.assertEqual(offline["serverEpoch"], "test-epoch")
        self.assertIsInstance(offline["seq"], int)

    async def test_snapshot_and_diffs_have_monotonic_version(self):
        manager = PresenceManager(server_epoch="test-epoch")
        first = FakeWebSocket()
        await manager.connect(first, "one", "一号")
        initial_seq = first.messages[0]["seq"]
        await manager.move_to_channel("one", "day0")
        snapshot = manager.build_snapshot()

        self.assertEqual(snapshot["serverEpoch"], "test-epoch")
        self.assertGreater(snapshot["seq"], initial_seq)
        moved = [item for item in first.messages if item.get("type") == "participant_moved"][-1]
        self.assertEqual(moved["seq"], snapshot["seq"])


if __name__ == "__main__":
    unittest.main()
