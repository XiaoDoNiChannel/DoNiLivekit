import test from 'node:test';
import assert from 'node:assert/strict';

import { validatePcmServiceHello } from '../src/features/audioPipelines.js';

test('PCM 服务握手只接受当前桌面进程和预期服务', () => {
    assert.equal(validatePcmServiceHello({
        type: 'pcm_service_hello',
        service: 'microphone',
        instanceId: '1234',
        protocolVersion: 1,
    }, 'microphone', '1234'), true);
});

test('PCM 服务握手拒绝占用端口的旧客户端进程', () => {
    assert.throws(() => validatePcmServiceHello({
        type: 'pcm_service_hello',
        service: 'microphone',
        instanceId: 'old-process',
        protocolVersion: 1,
    }, 'microphone', 'current-process'), /另一个客户端进程占用/);
});

test('PCM 服务握手拒绝把应用音频端口当作麦克风端口', () => {
    assert.throws(() => validatePcmServiceHello({
        type: 'pcm_service_hello',
        service: 'process_audio',
        instanceId: '1234',
        protocolVersion: 1,
    }, 'microphone', '1234'), /服务类型不匹配/);
});
