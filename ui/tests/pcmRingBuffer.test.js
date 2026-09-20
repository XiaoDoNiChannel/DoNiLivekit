import test from 'node:test';
import assert from 'node:assert/strict';
import { PcmRingBufferCore } from '../public/pcm-ring-buffer-core.js';

function makeBuffer(options = {}) {
    return new PcmRingBufferCore({
        capacityFrames: 1024,
        targetLatencyFrames: 128,
        softLatencyFrames: 256,
        maxLatencyFrames: 768,
        recoveryLatencyFrames: 384,
        ...options,
    });
}

test('环形缓冲统计下溢和最大缓冲帧数', () => {
    const buffer = makeBuffer();
    buffer.read(128);
    buffer.push(new Float32Array(400).fill(0.1), { seq: 1 });
    const stats = buffer.getStats();
    assert.equal(stats.underflowCount, 1);
    assert.equal(stats.currentBufferFrames, 400);
    assert.equal(stats.maxBufferFrames, 400);
});

test('轻微积压采用平滑追赶而非一次硬裁剪', () => {
    const buffer = makeBuffer();
    const samples = new Float32Array(500);
    for (let index = 0; index < samples.length; index += 1) samples[index] = index % 20 === 0 ? 0 : 0.1;
    buffer.push(samples, { seq: 1 });
    buffer.read(256);
    const stats = buffer.getStats();
    assert.equal(stats.droppedFrames, 0);
    assert.ok(stats.skippedFrames > 0);
    assert.equal(stats.discontinuityCount, 0);
});

test('严重积压在安静边界恢复并记录丢弃与 discontinuity', () => {
    const buffer = makeBuffer();
    buffer.push(new Float32Array(700).fill(0.2), { seq: 1 });
    const next = new Float32Array(300).fill(0.2);
    next[50] = 0;
    buffer.push(next, { seq: 3, discontinuity: true });
    const stats = buffer.getStats();
    assert.ok(stats.droppedFrames > 0);
    assert.ok(stats.discontinuityCount >= 2);
    assert.ok(stats.currentBufferFrames <= stats.capacityFrames);
});
