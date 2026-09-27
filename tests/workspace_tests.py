import importlib
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch
from fastapi.testclient import TestClient

from server.db import parties, rooms
from server.db.migrations import migrate_database
from server.realtime.workspace import execute
from presence_tests import FakeWebSocket

backend = importlib.import_module('server.app')


class WorkspaceTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / 'test.db'
        self.patch = patch.object(backend, 'DB_PATH', self.path)
        self.patch.start()
        migrate_database(self.path, ['day0', 'day1', 'day2'])
        self.manager = backend.PresenceManager(server_epoch='test')
        self.counter = 0

    def tearDown(self):
        self.patch.stop()
        self.temp.cleanup()

    async def client(self, identity):
        socket = FakeWebSocket()
        generation = await self.manager.connect(socket, identity, identity, user_id=identity)
        return identity, socket, generation

    async def command(self, client, action, values, delete_live=None, request_id=None):
        self.counter += 1
        return await execute(self.manager, self.path, *client,
                             {'type': 'workspace_command', 'requestId': request_id or str(self.counter), 'action': action, 'values': values},
                             delete_live or AsyncMock())

    async def test_card_crud_and_interests_are_broadcast_to_both_clients(self):
        owner, guest = await self.client('rain'), await self.client('guest')
        created = await self.command(owner, 'card_create', {'game': 'CS2', 'note': '下把一起', 'targetChannel': 'day1'})
        self.assertTrue(created['ok'])
        card_id = created['value']
        for client in (owner, guest):
            card = client[1].messages[-1]['partyCards'][0]
            self.assertEqual(card['id'], card_id)
        for enabled in (True, True, False, True):
            self.assertTrue((await self.command(guest, 'card_interest', {'id': card_id, 'enabled': enabled}))['ok'])
        self.assertEqual(len(parties.snapshot(self.path)[0]['interests']), 2)
        self.assertFalse((await self.command(guest, 'card_delete', {'id': card_id, 'revision': 1}))['ok'])
        self.assertTrue((await self.command(owner, 'card_update', {'id': card_id, 'revision': 1, 'game': 'CS2', 'note': '来就进'}))['ok'])
        self.assertFalse((await self.command(owner, 'card_delete', {'id': card_id, 'revision': 1}))['ok'])
        self.assertTrue((await self.command(owner, 'card_delete', {'id': card_id, 'revision': 2}))['ok'])
        self.assertEqual(parties.snapshot(self.path), [])
        self.assertIn('day1', rooms.list_rooms(self.path))
        self.assertFalse((await self.command(guest, 'card_interest', {'id': card_id, 'enabled': True}))['ok'])

    async def test_channel_creation_is_idempotent_and_does_not_move_voice(self):
        client = await self.client('rain')
        await self.manager.move_to_channel('rain', 'day0')
        one = await self.command(client, 'channel_create', {'name': '中文 游戏频道'}, request_id='same')
        two = await self.command(client, 'channel_create', {'name': '中文 游戏频道'}, request_id='same')
        self.assertEqual(one, two)
        self.assertEqual(self.manager.participants['rain'].current_channel, 'day0')
        self.assertEqual(rooms.list_rooms(self.path).count('中文 游戏频道'), 1)
        self.assertFalse((await self.command(client, 'channel_create', {'name': '中文 游戏频道'}))['ok'])

    async def test_room_delete_protects_lobby_presence_members_and_livekit_members(self):
        client = await self.client('rain')
        live = AsyncMock()
        self.assertFalse((await self.command(client, 'channel_delete', {'name': 'day0'}, live))['ok'])
        await self.manager.move_to_channel('rain', 'day1')
        self.assertFalse((await self.command(client, 'channel_delete', {'name': 'day1'}, live))['ok'])
        live.assert_not_awaited()
        await self.manager.move_to_channel('rain', 'day0')
        for error in (ValueError('频道仍有成员'), RuntimeError('offline')):
            result = await self.command(client, 'channel_delete', {'name': 'day1'}, AsyncMock(side_effect=error))
            self.assertFalse(result['ok']); self.assertIn('day1', rooms.list_rooms(self.path))

    async def test_delete_detaches_card_keeps_history_and_blocks_recreation(self):
        client = await self.client('rain')
        await self.command(client, 'card_create', {'game': 'CS2', 'targetChannel': 'day1'})
        backend.db_save_message({'id': 'm', 'channelId': 'day1', 'senderId': 'rain', 'senderName': 'rain', 'content': 'keep', 'timestamp': 1})
        self.assertTrue((await self.command(client, 'channel_delete', {'name': 'day1'}))['ok'])
        self.assertNotIn('day1', rooms.list_rooms(self.path))
        self.assertIsNone(parties.snapshot(self.path)[0]['targetChannel'])
        self.assertEqual(backend.db_get_history('day1')[0]['content'], 'keep')
        with self.assertRaises(ValueError): rooms.add_room(self.path, 'day1')
        with self.assertRaises(ValueError): await self.manager.move_to_channel('rain', 'day1')
        with self.assertRaises(backend.HTTPException): await backend.get_token('rain', 'day1')
        with patch.object(backend, 'list_livekit_rooms_and_participants', AsyncMock(return_value={'day1': ['late']})):
            response = await backend.get_rooms()
            self.assertNotIn(b'day1', response.body)

    async def test_old_socket_and_forged_owner_cannot_edit_another_card(self):
        old = await self.client('rain')
        current = await self.client('rain')
        self.assertFalse((await self.command(old, 'card_create', {'game': 'old'}))['ok'])
        result = await self.command(current, 'card_create', {'game': 'CS2', 'ownerId': 'someone-else'})
        self.assertTrue(result['ok']); self.assertEqual(parties.snapshot(self.path)[0]['ownerId'], 'rain')

    async def test_validation_and_reconnect_snapshot(self):
        client = await self.client('rain')
        for values in ({'game': ''}, {'game': 'a' * 41}, {'game': 'ok', 'targetChannel': 'missing'}):
            self.assertFalse((await self.command(client, 'card_create', values))['ok'])
        await self.command(client, 'card_create', {'game': 'CS2'})
        manager = backend.PresenceManager(server_epoch='new-server')
        self.assertEqual(manager.build_snapshot()['partyCards'][0]['game'], 'CS2')
        self.assertTrue(manager.build_snapshot()['channels'][0]['isLobby'])
        self.assertEqual(manager.build_snapshot()['channels'][0]['id'], 'day0')

    def test_presence_websocket_delivers_snapshot_and_command_ack(self):
        with patch.object(backend, 'presence_manager', self.manager), TestClient(backend.app) as client:
            with client.websocket_connect('/ws/presence?identity=wire&userId=wire&user=Wire') as socket:
                initial = socket.receive_json()
                self.assertEqual(initial['workspaceVersion'], 1)
                socket.send_json({'type': 'workspace_command', 'requestId': 'wire-create', 'action': 'card_create', 'values': {'game': '联机测试'}})
                received = []
                for _ in range(5):
                    message = socket.receive_json()
                    received.append(message)
                    if message['type'] == 'workspace_result':
                        break
                self.assertTrue(received[-1]['ok'])
                snapshot = next(m for m in received if m['type'] == 'presence_snapshot')
                self.assertEqual(snapshot['partyCards'][0]['game'], '联机测试')
                socket.send_json({'type': 'ping'})
                self.assertEqual(socket.receive_json()['type'], 'pong')


if __name__ == '__main__': unittest.main()
