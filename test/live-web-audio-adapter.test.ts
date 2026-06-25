import { describe, it, expect } from 'vitest';
import {
  WebAudioCaptureAdapter,
  mapAudioInputDevices,
  webAudioAvailable,
  WEB_AUDIO_MAX_CHANNELS,
  type AudioInputInfo,
} from '../src/live/web-audio-adapter.js';
import { WEB_AUDIO_PROCESSOR_SOURCE, WEB_AUDIO_PROCESSOR_NAME } from '../src/live/web-audio-processor.js';

describe('mapAudioInputDevices', () => {
  it('keeps only audio inputs, clamps channels to stereo, and falls back to a placeholder label', () => {
    const devices: AudioInputInfo[] = [
      { deviceId: 'mic-a', kind: 'audioinput', label: 'USB Mic' },
      { deviceId: 'spk-1', kind: 'audiooutput', label: 'Speakers' },
      { deviceId: 'cam-1', kind: 'videoinput', label: 'Webcam' },
      { deviceId: 'mic-b', kind: 'audioinput', label: '' }, // no label (permission not granted yet)
    ];
    const mapped = mapAudioInputDevices(devices);
    expect(mapped.length).toBe(2); // only the two audio inputs
    expect(mapped.map((d) => d.id)).toEqual(['mic-a', 'mic-b']);
    expect(mapped[0]!.name).toBe('USB Mic');
    expect(mapped[1]!.name).toBe('Audio input 2'); // placeholder for the unlabeled one
    expect(mapped.every((d) => d.maxInputChannels === WEB_AUDIO_MAX_CHANNELS)).toBe(true); // honest stereo cap
    expect(WEB_AUDIO_MAX_CHANNELS).toBe(2);
  });

  it('empty / no-audio-input lists map to []', () => {
    expect(mapAudioInputDevices([])).toEqual([]);
    expect(mapAudioInputDevices([{ deviceId: 'v', kind: 'videoinput', label: 'cam' }])).toEqual([]);
  });
});

describe('WebAudioCaptureAdapter (in a non-browser env)', () => {
  it('webAudioAvailable() is false without navigator.mediaDevices / AudioContext', () => {
    expect(webAudioAvailable()).toBe(false);
  });

  it('enumerate() resolves to [] when Web-Audio is unavailable (no throw)', async () => {
    const adapter = new WebAudioCaptureAdapter({ processorUrl: 'about:blank' });
    await expect(adapter.enumerate()).resolves.toEqual([]);
  });

  it('start() throws a clear, actionable error when Web-Audio is unavailable', async () => {
    const adapter = new WebAudioCaptureAdapter({ processorUrl: 'about:blank' });
    await expect(
      adapter.start({ deviceName: 'web', channels: 2, sampleRate: 48000, onBlock: () => {} }),
    ).rejects.toThrow(/Web-Audio capture unavailable/);
    expect(adapter.running).toBe(false);
  });

  it('stop() is safe before start (idempotent teardown)', async () => {
    const adapter = new WebAudioCaptureAdapter({ processorUrl: 'about:blank' });
    await expect(adapter.stop()).resolves.toBeUndefined();
    expect(adapter.running).toBe(false);
  });
});

describe('WEB_AUDIO_PROCESSOR_SOURCE', () => {
  it('registers the capture processor under the agreed name and posts channels', () => {
    expect(WEB_AUDIO_PROCESSOR_SOURCE).toContain(`registerProcessor('${WEB_AUDIO_PROCESSOR_NAME}'`);
    expect(WEB_AUDIO_PROCESSOR_SOURCE).toContain('extends AudioWorkletProcessor');
    expect(WEB_AUDIO_PROCESSOR_SOURCE).toContain('this.port.postMessage({ channels })');
  });
});
