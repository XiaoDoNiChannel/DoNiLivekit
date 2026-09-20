import { PcmRingBufferCore } from './pcm-ring-buffer-core.js';

class PcmRingBufferProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();
        this.core = new PcmRingBufferCore(options?.processorOptions || {});
        this.lastStatsAt = currentTime;

        this.port.onmessage = (event) => {
            const data = event.data;
            if (!data) return;
            if (data.type === 'reset') {
                this.core.reset();
                return;
            }

            const metadata = data.type === 'pcm_chunk' ? data : {};
            const raw = data.type === 'pcm_chunk' ? data.buffer : data;
            let chunk = null;
            if (raw instanceof ArrayBuffer) {
                chunk = new Float32Array(raw);
            } else if (ArrayBuffer.isView(raw)) {
                chunk = raw instanceof Float32Array
                    ? raw
                    : new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4));
            }
            if (chunk?.length) this.core.push(chunk, metadata);
        };
    }

    process(_inputs, outputs) {
        const output = outputs[0];
        if (!output?.length) return true;
        const mono = this.core.read(output[0].length);
        for (let channel = 0; channel < output.length; channel += 1) {
            output[channel].set(mono);
        }

        if (currentTime - this.lastStatsAt > 2) {
            this.lastStatsAt = currentTime;
            this.port.postMessage({ type: 'pcm_buffer_stats', ...this.core.getStats() });
        }
        return true;
    }
}

registerProcessor('pcm-ring-buffer-processor', PcmRingBufferProcessor);
