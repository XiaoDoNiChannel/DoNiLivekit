"""Channel/card commands bound to an established Presence session."""
import asyncio
import logging
from ..db import parties, rooms

LOGGER = logging.getLogger('donichannel.workspace')


async def execute(manager, path, identity, websocket, generation, message, ensure_live_room_empty):
    request_id = message.get('requestId')
    if not isinstance(request_id, str) or not 1 <= len(request_id) <= 100:
        return {'type': 'workspace_result', 'requestId': '', 'ok': False, 'error': '请求标识无效'}
    response = {'type': 'workspace_result', 'requestId': request_id, 'ok': False}
    snapshot = None
    async with manager.lock:
        session = manager.active_connections.get(identity)
        if not session or session.websocket is not websocket or session.generation != generation:
            return {**response, 'error': '连接已失效，请重新连接'}
        cache_key = (identity, request_id)
        if cache_key in manager.workspace_results:
            return manager.workspace_results[cache_key]
        actor = manager.participants[identity]
        try:
            action = message.get('action')
            values = message.get('values', {})
            if not isinstance(values, dict):
                raise ValueError('操作参数无效')
            if action == 'channel_create':
                name = parties.clean_text(values.get('name', ''), '频道名称', 64, True)
                if any(c in name for c in '\r\n\t'):
                    raise ValueError('频道名称不能包含换行或制表符')
                if name in rooms.room_metadata(path):
                    raise ValueError('频道名称已使用，请换一个名称')
                rooms.add_room(path, name)
                result = name
            elif action == 'channel_delete':
                name = parties.clean_text(values.get('name', ''), '频道名称', 64, True)
                metadata = rooms.room_metadata(path).get(name)
                if not metadata or metadata['deleted']:
                    raise ValueError('频道不存在或已删除')
                if metadata['isLobby']:
                    raise ValueError('主大厅是固定入口，不能删除')
                if any(p.current_channel == name for p in manager.participants.values()):
                    raise ValueError('频道仍有成员，请先移到其他频道再删除')
                try:
                    await asyncio.wait_for(ensure_live_room_empty(name), timeout=5)
                except ValueError:
                    raise
                except Exception as error:
                    raise ValueError('无法确认语音频道是否空闲，请稍后重试') from error
                parties.archive_room(path, name)
                result = name
            elif action in ('card_create', 'card_update', 'card_delete', 'card_interest'):
                result = parties.mutate(path, actor.user_id or identity, actor.display_name, action, values)
            else:
                raise ValueError('未知大厅操作，请升级客户端或服务端')
            manager._next_seq_locked()
            snapshot = manager.build_snapshot()
            response.update(ok=True, value=result)
        except ValueError as error:
            response['error'] = str(error)
        except Exception:
            LOGGER.exception('Workspace command failed: %s', message.get('action'))
            response['error'] = '服务端暂时无法完成操作，请刷新列表后重试'
        manager.workspace_results[cache_key] = response
        while len(manager.workspace_results) > 512:
            manager.workspace_results.pop(next(iter(manager.workspace_results)))
    if snapshot:
        await manager.broadcast(snapshot)
    return response
