export class PcmRingBufferCore {
    constructor(options = {}) {
        this.capacity = Math.max(1024, Math.floor(Number(options.capacityFrames) || 12000));
        this.targetLatencyFrames = Math.max(0, Math.floor(Number(options.targetLatencyFrames) || this.capacity * 0.3));
        this.softLatencyFrames = Math.max(
            this.targetLatencyFrames + 1,
            Math.floor(Number(options.softLatencyFrames) || this.capacity * 0.55),
        );
        this.maxLatencyFrames = Math.min(
            this.capacity,
            Math.max(this.softLatencyFrames + 1, Math.floor(Number(options.maxLatencyFrames) || this.capacity * 0.85)),
        );
        this.recoveryLatencyFrames = Math.max(
            this.targetLatencyFrames,
            Math.min(this.maxLatencyFrames, Math.floor(Number(options.recoveryLatencyFrames) || this.softLatencyFrames)),
        );
        this.buffer = new Float32Array(this.capacity);
        this.readIndex = 0;
        this.writeIndex = 0;
        this.available = 0;
        this.expectedSeq = null;
        this.catchUpCounter = 0;
        this.stats = {
            maxBufferFrames: 0,
            underflowCount: 0,
            droppedFrames: 0,
            skippedFrames: 0,
            discontinuityCount: 0,
        };
    }

    reset() {
        this.readIndex = 0;
        this.writeIndex = 0;
        this.available = 0;
        this.expectedSeq = null;
        this.catchUpCounter = 0;
    }

    noteMetadata(metadata = {}) {
        const seq = Number(metadata.seq);
        let discontinuity = metadata.discontinuity === true;
        if (Number.isSafeInteger(seq)) {
            if (this.expectedSeq !== null && seq !== this.expectedSeq) {
                discontinuity = true;
            }
            this.expectedSeq = seq + 1;
        }
        if (discontinuity) this.stats.discontinuityCount += 1;
    }

    peek(offset = 0) {
        if (offset < 0 || offset >= this.available) return 0;
        return this.buffer[(this.readIndex + offset) % this.capacity];
    }

    dropOldest(frameCount, { discontinuity = false } = {}) {
        const count = Math.max(0, Math.min(Math.floor(frameCount), this.available));
        if (!count) return 0;
        this.readIndex = (this.readIndex + count) % this.capacity;
        this.available -= count;
        this.stats.droppedFrames += count;
        if (discontinuity) this.stats.discontinuityCount += 1;
        return count;
    }

    findQuietDropBoundary(minimumDrop) {
        const start = Math.max(1, Math.min(minimumDrop, this.available - 1));
        const end = Math.min(this.available - 1, start + 960);
        let best = start;
        let bestMagnitude = Math.abs(this.peek(start));
        for (let offset = start + 1; offset <= end; offset += 1) {
            const magnitude = Math.abs(this.peek(offset));
            if (magnitude < bestMagnitude) {
                best = offset;
                bestMagnitude = magnitude;
                if (magnitude < 0.001) break;
            }
        }
        return best;
    }

    recoverSevereBacklog(extraFrames = 0) {
        const projected = this.available + Math.max(0, extraFrames);
        if (projected <= this.maxLatencyFrames && projected <= this.capacity) return 0;
        const desiredDrop = Math.max(1, projected - this.recoveryLatencyFrames);
        const boundary = this.findQuietDropBoundary(Math.min(desiredDrop, Math.max(1, this.available - 1)));
        return this.dropOldest(boundary, { discontinuity: true });
    }

    push(chunk, metadata = {}) {
        if (!chunk || !chunk.length) return;
        this.noteMetadata(metadata);
        let input = chunk;
        if (input.length >= this.capacity) {
            const droppedIncoming = input.length - this.recoveryLatencyFrames;
            this.stats.droppedFrames += Math.max(0, droppedIncoming);
            this.stats.discontinuityCount += 1;
            input = input.subarray(input.length - this.recoveryLatencyFrames);
            this.reset();
        } else {
            this.recoverSevereBacklog(input.length);
        }

        const overflow = Math.max(0, this.available + input.length - this.capacity);
        if (overflow > 0) this.dropOldest(overflow, { discontinuity: true });

        for (let index = 0; index < input.length; index += 1) {
            const sample = Number(input[index]);
            this.buffer[this.writeIndex] = Number.isFinite(sample) ? Math.max(-1, Math.min(1, sample)) : 0;
            this.writeIndex = (this.writeIndex + 1) % this.capacity;
            this.available += 1;
        }
        this.stats.maxBufferFrames = Math.max(this.stats.maxBufferFrames, this.available);
    }

    pullOne() {
        if (this.available <= 0) return 0;
        const sample = this.buffer[this.readIndex];
        this.readIndex = (this.readIndex + 1) % this.capacity;
        this.available -= 1;
        return sample;
    }

    maybeSmoothCatchUp() {
        if (this.available <= this.targetLatencyFrames) return;
        const interval = this.available > this.softLatencyFrames ? 32 : 160;
        this.catchUpCounter += 1;
        if (this.catchUpCounter < interval) return;
        this.catchUpCounter = 0;

        // 只在接近零交叉处跳过一个样本，避免轻微积压恢复产生明显点击声。
        if (this.available > 1 && (Math.abs(this.peek(0)) < 0.02 || Math.abs(this.peek(1)) < 0.02)) {
            this.pullOne();
            this.stats.skippedFrames += 1;
        }
    }

    read(frameCount) {
        const output = new Float32Array(frameCount);
        let underflowed = false;
        for (let index = 0; index < frameCount; index += 1) {
            if (this.available <= 0) {
                underflowed = true;
                output[index] = 0;
                continue;
            }
            output[index] = this.pullOne();
            this.maybeSmoothCatchUp();
        }
        if (underflowed) this.stats.underflowCount += 1;
        return output;
    }

    getStats() {
        return {
            currentBufferFrames: this.available,
            capacityFrames: this.capacity,
            ...this.stats,
        };
    }
}
