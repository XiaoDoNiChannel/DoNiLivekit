"""Persistent, explicitly maintained game intentions. No inferred match status."""
import time
import uuid
from .connection import connect


def now_ms():
    return int(time.time() * 1000)


def snapshot(path):
    db = connect(path)
    try:
        cards = []
        interests = {}
        for row in db.execute('SELECT * FROM party_interests ORDER BY created_at'):
            interests.setdefault(row['card_id'], []).append({
                'userId': row['user_id'], 'displayName': row['display_name'],
            })
        for row in db.execute('SELECT * FROM party_cards WHERE deleted_at = 0 ORDER BY created_at DESC'):
            cards.append({
                'id': row['id'], 'ownerId': row['owner_id'], 'ownerName': row['owner_name'],
                'game': row['game'], 'note': row['note'], 'targetChannel': row['target_channel'],
                'createdAt': row['created_at'], 'updatedAt': row['updated_at'],
                'revision': row['revision'], 'interests': interests.get(row['id'], []),
            })
        return cards
    finally:
        db.close()


def clean_text(value, label, limit, required=False):
    if not isinstance(value, str):
        raise ValueError(f'{label}格式不正确')
    value = value.strip()
    if len(value) > limit or (required and not value) or any(ord(c) < 32 and c not in '\n\t' for c in value):
        raise ValueError(f'{label}须为 {1 if required else 0}–{limit} 个字符')
    return value


def mutate(path, actor_id, actor_name, action, values):
    """Identity comes from the current Presence connection, never from values."""
    db = connect(path)
    try:
        with db:
            db.execute('BEGIN IMMEDIATE')
            timestamp = now_ms()
            if action in ('card_create', 'card_update'):
                game = clean_text(values.get('game', ''), '游戏名称', 40, True)
                note = clean_text(values.get('note', ''), '招呼内容', 160)
                target = clean_text(values.get('targetChannel') or '', '语音频道', 64) or None
                if target and not db.execute('SELECT 1 FROM rooms WHERE room_name=? AND deleted_at=0', (target,)).fetchone():
                    raise ValueError('目标语音频道不存在，请重新选择')
            if action == 'card_create':
                if db.execute('SELECT COUNT(*) FROM party_cards WHERE deleted_at=0').fetchone()[0] >= 100:
                    raise ValueError('活跃卡片已达 100 张，请先整理旧卡片')
                card_id = uuid.uuid4().hex
                db.execute('INSERT INTO party_cards(id,owner_id,owner_name,game,note,target_channel,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
                           (card_id, actor_id, actor_name, game, note, target, timestamp, timestamp))
                db.execute('INSERT INTO party_interests VALUES(?,?,?,?)', (card_id, actor_id, actor_name, timestamp))
                return card_id
            card_id = clean_text(values.get('id', ''), '卡片 ID', 64, True)
            card = db.execute('SELECT * FROM party_cards WHERE id=? AND deleted_at=0', (card_id,)).fetchone()
            if not card:
                raise ValueError('卡片已被删除，请刷新列表')
            if action in ('card_update', 'card_delete'):
                if card['owner_id'] != actor_id:
                    raise ValueError('只有发起人可以修改或删除这张卡片')
                if values.get('revision') != card['revision']:
                    raise ValueError('卡片已更新，请重新打开后操作')
                if action == 'card_delete':
                    db.execute('UPDATE party_cards SET deleted_at=?, revision=revision+1 WHERE id=?', (timestamp, card_id))
                    db.execute('DELETE FROM party_interests WHERE card_id=?', (card_id,))
                else:
                    db.execute('UPDATE party_cards SET game=?,note=?,target_channel=?,updated_at=?,revision=revision+1 WHERE id=?',
                               (game, note, target, timestamp, card_id))
            elif action == 'card_interest':
                enabled = values.get('enabled')
                if not isinstance(enabled, bool):
                    raise ValueError('意向状态须为布尔值')
                if enabled:
                    db.execute('INSERT INTO party_interests VALUES(?,?,?,?) ON CONFLICT(card_id,user_id) DO UPDATE SET display_name=excluded.display_name',
                               (card_id, actor_id, actor_name, timestamp))
                else:
                    db.execute('DELETE FROM party_interests WHERE card_id=? AND user_id=?', (card_id, actor_id))
            else:
                raise ValueError('未知组队操作')
            return card_id
    finally:
        db.close()


def archive_room(path, name):
    db = connect(path)
    try:
        with db:
            row = db.execute('SELECT * FROM rooms WHERE room_name=? AND deleted_at=0', (name,)).fetchone()
            if not row:
                raise ValueError('频道不存在或已删除')
            if row['is_lobby']:
                raise ValueError('主大厅是固定入口，不能删除')
            db.execute('UPDATE rooms SET deleted_at=? WHERE room_name=?', (now_ms(), name))
            # Keep cards and history. Only remove the obsolete channel association.
            db.execute('UPDATE party_cards SET target_channel=NULL,revision=revision+1 WHERE target_channel=?', (name,))
    finally:
        db.close()
