/**
 * Runnable demo for the conferencing audio pipeline (control plane).
 *
 *   1. build:  npm run build
 *   2. run:    node demo.mjs
 *
 * It builds a small boardroom scene with a locally-reinforced presenter mic,
 * shows the AEC self-reference trap being caught, then shows the correct
 * dedicated far-end-only reference passing validation.
 */
import {
  createConfig,
  addDevice,
  createProcessor,
  createWirelessMic,
  createLoudspeaker,
  createCodec,
  route,
  matrixFor,
  setAec,
  validate,
  serialize,
} from './dist/index.js';

function banner(title) {
  console.log('\n' + '='.repeat(72) + '\n' + title + '\n' + '='.repeat(72));
}

function report(label, cfg) {
  const res = validate(cfg);
  console.log(`\n${label}: ${res.ok ? 'OK ✅' : 'INVALID ❌'}`);
  for (const e of res.errors) console.log(`  ERROR   [${e.code}] ${e.message}`);
  for (const w of res.warnings) console.log(`  WARNING [${w.code}] ${w.message}`);
  if (res.ok && res.warnings.length === 0) console.log('  (no errors, no warnings)');
}

// --- Build the scene: processor, presenter mic, speaker, codec (far-end) ---
let cfg = createConfig({ name: 'Boardroom', createdAt: '2026-06-08T00:00:00Z' });
cfg = addDevice(cfg, createProcessor('P', 'DSP'));
cfg = addDevice(cfg, createWirelessMic('PM', 'Presenter Mic', 'dante'));
cfg = addDevice(cfg, createLoudspeaker('L', 'Ceiling Speaker', 'analog'));
cfg = addDevice(cfg, createCodec('C', 'Video Codec', 'dante'));

// Routing: mic + far-end into the processor; processor output to the speaker.
cfg = route(cfg, 'PM-out-dante-1', 'P-in-dante-1'); // presenter -> processor
cfg = route(cfg, 'C-out-dante-1', 'P-in-dante-2'); // far-end   -> processor
cfg = route(cfg, 'P-out-analog-1', 'L-in-analog-1'); // speaker feed

// Speaker feed carries far-end + the reinforced presenter.
cfg = matrixFor(cfg, 'P').route('P-in-dante-2', 'P-out-analog-1'); // far-end -> speakers
cfg = matrixFor(cfg, 'P').route('P-in-dante-1', 'P-out-analog-1'); // presenter -> speakers (reinforcement)

banner('1) THE TRAP — point the reinforced presenter AEC at the speaker feed');
let trap = setAec(cfg, 'PM', { enabled: true, referenceBusId: 'P-out-analog-1' });
report('Presenter AEC reference = speaker feed (contains the mic)', trap);

banner('2) THE FIX — dedicated far-end-only reference bus (excludes the mic)');
let fixed = matrixFor(cfg, 'P').route('P-in-dante-2', 'P-out-dante-2'); // far-end ONLY -> unused bus
fixed = setAec(fixed, 'PM', { enabled: true, referenceBusId: 'P-out-dante-2' });
report('Presenter AEC reference = far-end-only bus', fixed);

banner('3) The fixed config serializes to versioned JSON (round-trippable)');
console.log(serialize(fixed, true).split('\n').slice(0, 12).join('\n') + '\n  ...');
