import { radioParameters, type FilterSettings } from '../shared/filters';

export function configureProtection(compressor: DynamicsCompressorNode) {
  compressor.threshold.value = -2;
  compressor.knee.value = 0;
  compressor.ratio.value = 20;
  compressor.attack.value = 0.003;
  compressor.release.value = 0.1;
}
export async function measureProtectionDelay() {
  const offline = new OfflineAudioContext(1, 4800, 48000);
  const buffer = offline.createBuffer(1, 4800, 48000);
  buffer.getChannelData(0)[1024] = 0.2;
  const source = offline.createBufferSource(); source.buffer = buffer;
  const compressor = offline.createDynamicsCompressor(); configureProtection(compressor);
  source.connect(compressor).connect(offline.destination); source.start();
  const samples = (await offline.startRendering()).getChannelData(0);
  let peak = 0;
  for (let i = 0; i < samples.length; i++) if (Math.abs(samples[i]!) > Math.abs(samples[peak]!)) peak = i;
  const delay = peak - 1024;
  if (samples[peak]! < 0.1 || delay < 0 || delay > 48000 * 0.02) throw new Error('Could not measure audio output timing.');
  return delay / 48000;
}

/** The verified prototype graph, including its fixed +12 dB radio compensation. */
export class FilterGraph {
  private raw: GainNode;
  private clean: GainNode;
  private dry: GainNode;
  private wet: GainNode;
  private volume: GainNode;
  private filters: BiquadFilterNode[] = [];
  private presence: BiquadFilterNode;
  private panner: StereoPannerNode;
  constructor(private context: AudioContext, reader: AudioWorkletNode) {
    const gain = (value = 1) => { const node = context.createGain(); node.gain.value = value; return node; };
    this.raw = gain(); this.clean = gain(0); this.dry = gain(); this.wet = gain(0); this.volume = gain();
    const entry = gain(), exit = gain();
    reader.connect(this.raw, 0).connect(entry);
    reader.connect(this.clean, 1).connect(entry);
    entry.connect(this.dry).connect(exit);
    let last: AudioNode = entry;
    for (let i = 0; i < 2; i++) {
      const high = context.createBiquadFilter(), low = context.createBiquadFilter();
      high.type = 'highpass'; low.type = 'lowpass';
      high.Q.value = low.Q.value = Math.SQRT1_2;
      last.connect(high).connect(low); last = low; this.filters.push(high, low);
    }
    this.presence = context.createBiquadFilter();
    this.presence.type = 'peaking'; this.presence.frequency.value = 1800; this.presence.Q.value = 0.9;
    last.connect(this.presence).connect(this.wet).connect(exit);
    this.panner = context.createStereoPanner();
    const protection = context.createDynamicsCompressor(); configureProtection(protection);
    exit.connect(this.panner).connect(this.volume).connect(protection).connect(context.destination);
  }
  private smooth(parameter: AudioParam, value: number) {
    parameter.cancelScheduledValues(this.context.currentTime);
    parameter.setTargetAtTime(value, this.context.currentTime, 0.008);
  }
  apply(settings: FilterSettings) {
    const radio = radioParameters(settings.radio.strength);
    this.filters.forEach((filter, index) => this.smooth(filter.frequency, index % 2 ? radio.low : radio.high));
    this.smooth(this.presence.gain, radio.presence);
    this.smooth(this.raw.gain, settings.noise.enabled ? 0 : 1);
    this.smooth(this.clean.gain, settings.noise.enabled ? 1 : 0);
    this.smooth(this.dry.gain, settings.radio.enabled ? 0 : 1);
    this.smooth(this.wet.gain, settings.radio.enabled ? radio.gain : 0);
    this.smooth(this.panner.pan, settings.position.enabled ? settings.position.pan / 100 : 0);
  }
  setVolume(value: number) { this.smooth(this.volume.gain, value / 100); }
}
