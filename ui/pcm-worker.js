class PcmRingBufferProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();
        const configured = Number(options?.processorOptions?.capacityFrames);
        const capacityFrames = Number.isFinite(configured) && configured > 1024 ? configured : 48000 * 0.4;
        this.capacity = capacityFrames;
        this.buffer = new Float32Array(this.capacity);
        this.readIndex = 0;
        this.writeIndex = 0;
        this.available = 0;

        this.port.onmessage = (event) => {
            const data = event.data;
            if (!data) return;

            let chunk = null;
            if (data instanceof ArrayBuffer) {
                chunk = new Float32Array(data);
            } else if (ArrayBuffer.isView(data)) {
                chunk = data instanceof Float32Array
                    ? data
                    : new Float32Array(data.buffer, data.byteOffset, Math.floor(data.byteLength / 4));
            }

            if (!chunk || chunk.length === 0) return;
            this.push(chunk);
        };
    }

    push(chunk) {
        for (let i = 0; i < chunk.length; i++) {
            if (this.available >= this.capacity) {
                this.readIndex = (this.readIndex + 1) % this.capacity;
                this.available--;
            }

            this.buffer[this.writeIndex] = chunk[i];
            this.writeIndex = (this.writeIndex + 1) % this.capacity;
            this.available++;
        }
    }

    pull() {
        if (this.available <= 0) return 0;
        const sample = this.buffer[this.readIndex];
        this.readIndex = (this.readIndex + 1) % this.capacity;
        this.available--;
        return sample;
    }

    process(_inputs, outputs) {
        const output = outputs[0];
        if (!output || output.length === 0) return true;

        const frames = output[0].length;
        for (let i = 0; i < frames; i++) {
            const monoSample = this.pull();
            for (let ch = 0; ch < output.length; ch++) {
                output[ch][i] = monoSample;
            }
        }

        return true;
    }
}

registerProcessor('pcm-ring-buffer-processor', PcmRingBufferProcessor);
