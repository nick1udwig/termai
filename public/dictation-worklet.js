// Streaming mono downsampling, retaining fractional sample coverage across blocks.
class DictationPCM extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.remaining = this.ratio; this.sum = 0;
    this.samples = []; this.stopped = false;
    this.port.onmessage = () => { this.flush(); this.stopped = true; this.port.postMessage('flushed'); };
  }
  flush() {
    if (!this.samples.length) return;
    const bytes = new ArrayBuffer(this.samples.length * 2), view = new DataView(bytes);
    this.samples.forEach((value, index) => view.setInt16(index * 2, value, true));
    this.samples = []; this.port.postMessage(bytes, [bytes]);
  }
  process(inputs) {
    if (this.stopped) return false;
    const channels = inputs[0];
    if (!channels?.length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      let value = 0;
      for (const channel of channels) value += channel[i] / channels.length;
      let weight = 1;
      while (weight > 1e-8) {
        const used = Math.min(weight, this.remaining);
        this.sum += value * used; this.remaining -= used; weight -= used;
        if (this.remaining < 1e-8) {
          const normalized = Math.max(-1, Math.min(1, this.sum / this.ratio));
          this.samples.push(Math.round(normalized * (normalized < 0 ? 32768 : 32767)));
          this.sum = 0; this.remaining = this.ratio;
          if (this.samples.length >= 1600) this.flush();
        }
      }
    }
    return true;
  }
}
registerProcessor('dictation-pcm', DictationPCM);
