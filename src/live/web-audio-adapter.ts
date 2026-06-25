/**
 * A browser {@link CaptureAdapter} over the Web-Audio API (getUserMedia + AudioWorklet) — so the live console
 * can run without the Node host.
 *
 * **HONEST, LOAD-BEARING LIMIT:** a browser **cannot** capture the 8 discrete POLARIS USB capsules.
 * `getUserMedia`/MediaStream downmix a multichannel USB device to **stereo (or mono)** before Web-Audio ever
 * sees it, and an `AudioWorklet` only receives whatever the browser exposes. So this adapter delivers **at most
 * 2 channels** — it is an honest stereo/mono capture path (a meter / single-channel-cleaning demo, or feeding
 * the synthetic visualizer from a real but downmixed input). It is **not** real array beamforming; for the
 * 8-capsule array use the Node host (`./live-node` + `naudiodon2`). The adapter never fabricates 8 channels.
 *
 * Browser-only: it uses `navigator.mediaDevices`, `AudioContext`, and `AudioWorkletNode` (the repo's `DOM` lib).
 * The pure device mapper {@link mapAudioInputDevices} is unit-tested; the getUserMedia/worklet flow is verified
 * in a real browser. The AudioWorklet processor lives in `web-audio-processor.ts` (loaded via `processorUrl`).
 */
import type { CaptureAdapter, CaptureDevice, CaptureStartOptions } from './types.js';

/** The most channels a browser capture path can deliver (multichannel USB is downmixed to stereo). */
export const WEB_AUDIO_MAX_CHANNELS = 2;

/** The structural subset of `MediaDeviceInfo` the device mapper reads (so it's testable without a DOM mock). */
export interface AudioInputInfo {
  deviceId: string;
  kind: string;
  label: string;
}

/** Map `enumerateDevices()` audio inputs to {@link CaptureDevice}s, clamping the channel count to stereo. */
export function mapAudioInputDevices(devices: readonly AudioInputInfo[], defaultSampleRate = 48000): CaptureDevice[] {
  const out: CaptureDevice[] = [];
  let i = 0;
  for (const d of devices) {
    if (d.kind !== 'audioinput') continue;
    out.push({
      id: d.deviceId,
      // labels are empty until the user grants mic permission — fall back to a stable placeholder
      name: d.label && d.label.length > 0 ? d.label : `Audio input ${i + 1}`,
      maxInputChannels: WEB_AUDIO_MAX_CHANNELS, // honest: the browser caps capture at stereo
      defaultSampleRate,
    });
    i++;
  }
  return out;
}

/** True when the Web-Audio capture APIs are present (a browser, not Node/CI). */
export function webAudioAvailable(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    navigator.mediaDevices !== undefined &&
    typeof navigator.mediaDevices.getUserMedia === 'function' &&
    typeof AudioContext !== 'undefined'
  );
}

export interface WebAudioAdapterOptions {
  /** The input device id to capture (from {@link mapAudioInputDevices}); omitted = the browser default. */
  deviceId?: string;
  /** URL of the built `web-audio-processor.js` AudioWorklet module (host-provided, or a blob URL). */
  processorUrl: string;
}

export class WebAudioCaptureAdapter implements CaptureAdapter {
  private readonly deviceId: string | undefined;
  private readonly processorUrl: string;
  private cb: ((channels: Float32Array[], sampleRate: number) => void) | null = null;
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private _running = false;

  constructor(opts: WebAudioAdapterOptions) {
    this.deviceId = opts.deviceId;
    this.processorUrl = opts.processorUrl;
  }

  async enumerate(): Promise<CaptureDevice[]> {
    if (!webAudioAvailable()) return [];
    const devices = await navigator.mediaDevices.enumerateDevices();
    return mapAudioInputDevices(devices);
  }

  async start(opts: CaptureStartOptions): Promise<void> {
    if (!webAudioAvailable()) {
      throw new Error('Web-Audio capture unavailable (no navigator.mediaDevices / AudioContext). Use the Node host for the array.');
    }
    this.cb = opts.onBlock;
    const audio: MediaTrackConstraints =
      this.deviceId !== undefined ? { deviceId: { exact: this.deviceId } } : {};
    this.stream = await navigator.mediaDevices.getUserMedia({ audio });
    this.ctx = new AudioContext({ sampleRate: opts.sampleRate });
    await this.ctx.audioWorklet.addModule(this.processorUrl);
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'web-audio-capture');
    const sr = this.ctx.sampleRate;
    this.node.port.onmessage = (ev: MessageEvent): void => {
      if (!this._running || this.cb === null) return;
      const data = ev.data as { channels: Float32Array[] };
      // HONEST: clamp to stereo — never hand the engine fabricated 8-channel data
      this.cb(data.channels.slice(0, WEB_AUDIO_MAX_CHANNELS), sr);
    };
    this.source.connect(this.node);
    // keep the graph pulling without audibly monitoring: route through a muted gain to the destination
    const sink = this.ctx.createGain();
    sink.gain.value = 0;
    this.node.connect(sink).connect(this.ctx.destination);
    this._running = true;
  }

  get running(): boolean {
    return this._running;
  }

  async stop(): Promise<void> {
    this._running = false;
    this.cb = null;
    if (this.node !== null) this.node.disconnect();
    if (this.source !== null) this.source.disconnect();
    if (this.stream !== null) for (const t of this.stream.getTracks()) t.stop();
    if (this.ctx !== null) await this.ctx.close();
    this.node = null;
    this.source = null;
    this.stream = null;
    this.ctx = null;
  }
}
