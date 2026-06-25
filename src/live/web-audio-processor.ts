/**
 * The AudioWorklet processor for {@link WebAudioCaptureAdapter}, as a **source string**.
 *
 * An AudioWorklet module runs in the `AudioWorkletGlobalScope` (`AudioWorkletProcessor` / `registerProcessor`
 * / `sampleRate`), which is NOT in the repo's `DOM` lib — so rather than a separate `.ts` file that won't
 * typecheck, the processor ships as this plain-JS string. The host turns it into a module URL once and passes
 * it to the adapter:
 *
 * ```ts
 * const url = URL.createObjectURL(new Blob([WEB_AUDIO_PROCESSOR_SOURCE], { type: 'application/javascript' }));
 * const adapter = new WebAudioCaptureAdapter({ processorUrl: url });
 * ```
 *
 * Each render quantum (128 samples) it copies the input channels (≤ 2 — the browser downmixes a multichannel
 * USB device to stereo before the worklet sees it) and posts them to the main thread, where the adapter calls
 * `onBlock`. The copy is required because the worklet's input buffers are reused across quanta.
 */
export const WEB_AUDIO_PROCESSOR_NAME = 'web-audio-capture';

export const WEB_AUDIO_PROCESSOR_SOURCE = `
class WebAudioCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input.length > 0 && input[0] && input[0].length > 0) {
      const channels = input.map((ch) => {
        const c = new Float32Array(ch.length);
        c.set(ch);
        return c;
      });
      this.port.postMessage({ channels });
    }
    return true; // keep the processor alive
  }
}
registerProcessor('${WEB_AUDIO_PROCESSOR_NAME}', WebAudioCaptureProcessor);
`;
