/**
 * Shareable design report (Markdown / HTML), read-only over a {@link SystemConfig}.
 *
 * Markdown is the source of truth; `designReport(config, 'html')` converts it
 * with a small in-module converter (no dependency). Sections reuse the existing
 * engine functions (routing, validation, coverage).
 */

import type { SystemConfig } from '../model/config.js';
import { isMicDevice } from '../model/devices.js';
import { isPickupZone } from '../model/coverage.js';
import { talkerCoverage } from '../coverage/talker-coverage.js';
import { coverageReport, zoneCoverageReport } from '../coverage/check.js';
import { routingSummary, signalFlowReport } from '../routing/summary.js';
import { validate } from '../validation/validate.js';
import { estimatedRt60 } from '../sim/index.js';

/** Render a shareable design report. `fmt` is `'markdown'` (default) or `'html'`. */
export function designReport(config: SystemConfig, fmt: 'markdown' | 'html' = 'markdown'): string {
  if (fmt === 'markdown') return markdown(config);
  if (fmt === 'html') return mdToHtml(markdown(config));
  throw new Error(`Unknown report format: ${String(fmt)} (expected 'markdown' or 'html').`);
}

// ---------------------------------------------------------------------------
// Commissioning / as-built report (design report + measured live state)
// ---------------------------------------------------------------------------

/**
 * Runtime / measured state captured during commissioning, layered onto the pure
 * {@link SystemConfig} design report. Every field is optional — a report built
 * from an empty `{}` is just the as-built config plus a sign-off checklist (the
 * honest "we never went live" case). The GUI fills these from the running engine;
 * the pure library never reads a clock or a device.
 *
 * `silentCapsules` is `undefined`/`null` when capsule health was never probed,
 * `[]` when probed and all live, or the 1-based indices found silent. Latency is
 * always framed as *estimated* (summed from stage constants, not measured).
 */
export interface CommissioningInfo {
  site?: string;
  commissionedBy?: string;
  date?: string;
  notes?: string;
  listeningMode?: string;
  /** Estimated end-to-end latency (ms); `null`/absent = not estimated. */
  estimatedLatencyMs?: number | null;
  /** Latency target (ms); defaults to 150. */
  latencyTargetMs?: number;
  activeCleaningStages?: string;
  aecRefSource?: string;
  /** AEC echo reduction (ERLE, dB); `null`/absent = not measured. */
  aecErleDb?: number | null;
  /** A/B proof: how much quieter the background got (dB). */
  bedReductionDb?: number | null;
  /** A/B proof: broadband level delta (dB). */
  rmsReductionDb?: number | null;
  /** Front calibration offset (deg). */
  frontOffsetDeg?: number | null;
  /** `undefined`/`null` = never probed; `[]` = all live; else 1-based silent indices. */
  silentCapsules?: number[] | null;
}

/**
 * An integrator deliverable: the as-built configuration plus the measured live
 * state (estimated latency, AEC/ERLE, A/B noise-bed proof, capsule health, front
 * calibration) and a derived pass/fail sign-off checklist. `fmt` is `'markdown'`
 * (default) or `'html'`. Mirrors the Python engine's `commissioning_report`.
 */
export function commissioningReport(
  config: SystemConfig,
  info: CommissioningInfo = {},
  fmt: 'markdown' | 'html' = 'markdown',
): string {
  const md = commissionMarkdown(config, info);
  if (fmt === 'markdown') return md;
  if (fmt === 'html') return mdToHtml(md);
  throw new Error(`Unknown report format: ${String(fmt)} (expected 'markdown' or 'html').`);
}

// ---------------------------------------------------------------------------
// Markdown sections
// ---------------------------------------------------------------------------

/** Format a number with a leading sign, like Python's `:+.Nf`. */
function signed(x: number, digits: number): string {
  return (x >= 0 ? '+' : '') + x.toFixed(digits);
}

function markdown(config: SystemConfig): string {
  return [
    roomSection(config),
    deviceSection(config),
    routingSection(config),
    aecSection(config),
    coverageSection(config),
    coverageAreasSection(config),
    controlSection(config),
    validationSection(config),
  ]
    .filter((s) => s)
    .join('\n\n');
}

function roomFacts(config: SystemConfig): string[] {
  const room = config.room;
  if (room && room.vertices.length > 0) {
    const xs = room.vertices.map((v) => v.x);
    const ys = room.vertices.map((v) => v.y);
    const w = Math.max(...xs) - Math.min(...xs);
    const d = Math.max(...ys) - Math.min(...ys);
    return [
      `- Room: ${w.toFixed(1)} × ${d.toFixed(1)} × ${room.height.toFixed(1)} m`,
      `- Estimated RT60: ${estimatedRt60(config).toFixed(2)} s`,
    ];
  }
  return ['- Room: not defined'];
}

function roomSection(config: SystemConfig): string {
  const name = config.metadata.name || 'Untitled';
  return [`# Design report — ${name}`, '', ...roomFacts(config)].join('\n');
}

function deviceSection(config: SystemConfig): string {
  const lines = [
    '## Devices',
    '',
    '| ID | Label | Type | Profile | Ports | Elev (m) | AEC ref |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const d of config.devices) {
    const elev = d.elevation === undefined ? '' : d.elevation.toFixed(2);
    let aec = '';
    if (isMicDevice(d)) {
      aec = d.aec.enabled ? d.aec.referenceBusId ?? '(none)' : 'off';
    }
    lines.push(`| ${d.id} | ${d.label} | ${d.type} | ${d.profileId ?? '—'} | ${d.ports.length} | ${elev} | ${aec} |`);
  }
  return lines.join('\n');
}

function routingSection(config: SystemConfig): string {
  const s = routingSummary(config);
  const flow = signalFlowReport(config) || '(no routes)';
  return (
    '## Routing\n\n' +
    `- ${s.total} route(s) · ${s.dante} Dante · ${s.analog} analog\n\n` +
    '```\n' +
    flow +
    '\n```'
  );
}

function aecSection(config: SystemConfig): string {
  const mics = config.devices.filter(isMicDevice);
  if (mics.length === 0) return '';
  const lines = ['## AEC references'];
  for (const m of mics) {
    lines.push(m.aec.enabled ? `- ${m.label}: ${m.aec.referenceBusId ?? '(none)'}` : `- ${m.label}: disabled`);
  }
  return lines.join('\n');
}

function coverageSection(config: SystemConfig): string {
  if (config.talkers.length === 0) return '';
  const labelOf = new Map(config.talkers.map((t) => [t.id, t.label]));
  const rep = coverageReport(config);
  const lines = [
    '## Coverage',
    `- ${rep.covered.length}/${config.talkers.length} talkers within an array coverage circle`,
  ];
  if (rep.uncovered.length > 0) {
    lines.push('- Uncovered: ' + rep.uncovered.map((t) => labelOf.get(t) ?? t).join(', '));
  }
  if (rep.overlaps.length > 0) {
    lines.push('- Overlapping arrays: ' + rep.overlaps.map(([a, b]) => `${a}/${b}`).join(', '));
  }
  for (const t of config.talkers) {
    const cov = talkerCoverage(config, t.id);
    const status = cov.captured ? 'captured' : cov.excludedBy.length > 0 ? 'excluded' : 'not in a pickup zone';
    lines.push(`- ${t.label}: ${status}`);
  }
  return lines.join('\n');
}

function coverageAreasSection(config: SystemConfig): string {
  const arrays = config.devices.filter((d) => d.type === 'microphoneArray');
  const pickupZones = arrays.flatMap((a) => a.zones.filter(isPickupZone));
  if (pickupZones.length === 0) return '';
  const lines = [
    '## Coverage areas',
    '',
    '| Array | Area | Type | Out channel | Gain (dB) |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const a of arrays) {
    for (const z of a.zones) {
      if (!isPickupZone(z)) continue;
      const ch = z.outputChannel !== undefined ? String(z.outputChannel) : '—';
      const gain = z.gainDb !== undefined ? signed(z.gainDb, 1) : '0.0';
      lines.push(`| ${a.label} | ${z.label} | ${z.type} | ${ch} | ${gain} |`);
    }
  }
  const zrep = zoneCoverageReport(config);
  if (zrep.zones.length > 0) {
    const covered = zrep.zones.filter((z) => z.centroidCovered).length;
    lines.push('');
    lines.push(`- ${covered}/${zrep.zones.length} coverage area(s) inside their array's pickup circle`);
    if (zrep.uncovered.length > 0) {
      lines.push('- Outside coverage: ' + zrep.uncovered.map((z) => `${z.zoneLabel} (${z.arrayId})`).join(', '));
    }
    if (zrep.partial.length > 0) {
      lines.push('- Partially covered (edges outside): ' + zrep.partial.map((z) => `${z.zoneLabel} (${z.arrayId})`).join(', '));
    }
    if (zrep.contended.length > 0) {
      lines.push('- Lobe contention (2+ arrays cover the area): ' + zrep.contended.map((z) => z.zoneLabel).join(', '));
    }
  }
  return lines.join('\n');
}

function controlSection(config: SystemConfig): string {
  if (!config.control || config.control.muteGroups.length === 0) return '';
  const lines = ['## Mute groups'];
  for (const g of config.control.muteGroups) {
    const members = [...g.deviceIds, ...g.zoneRefs.map((r) => `${r.arrayId}/${r.zoneId}`)];
    const state = g.muted ? 'muted' : 'unmuted';
    lines.push(`- ${g.label} [${g.trigger}, ${state}]: ${members.join(', ') || '(empty)'}`);
  }
  return lines.join('\n');
}

function validationSection(config: SystemConfig): string {
  const res = validate(config);
  const lines = ['## Validation'];
  if (res.errors.length === 0 && res.warnings.length === 0) {
    lines.push('- No issues');
    return lines.join('\n');
  }
  for (const e of res.errors) lines.push(`- ERROR [${e.code}] ${e.message}`);
  for (const w of res.warnings) lines.push(`- WARN [${w.code}] ${w.message}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Commissioning-specific sections (reuse the design-report sections above)
// ---------------------------------------------------------------------------

function commissionMarkdown(config: SystemConfig, info: CommissioningInfo): string {
  return [
    commissionHeader(config, info),
    commissionRoom(config),
    deviceSection(config),
    routingSection(config),
    aecSection(config),
    coverageSection(config),
    coverageAreasSection(config),
    controlSection(config),
    commissionMeasurements(info),
    commissionHealth(info),
    validationSection(config),
    commissionSignoff(config, info),
  ]
    .filter((s) => s)
    .join('\n\n');
}

function commissionHeader(config: SystemConfig, info: CommissioningInfo): string {
  const name = config.metadata.name || 'Untitled';
  const lines = [`# Commissioning report — ${name}`, ''];
  const rows: Array<[string, string]> = [
    ['Site', info.site ?? ''],
    ['Commissioned by', info.commissionedBy ?? ''],
    ['Date', info.date ?? ''],
  ];
  for (const [label, val] of rows) lines.push(`- ${label}: ${val || '—'}`);
  if (info.listeningMode) lines.push(`- Listening mode: ${info.listeningMode}`);
  if (info.notes) lines.push(`- Notes: ${info.notes}`);
  return lines.join('\n');
}

function commissionRoom(config: SystemConfig): string {
  return ['## Room', ...roomFacts(config)].join('\n');
}

function commissionMeasurements(info: CommissioningInfo): string {
  const lines: string[] = [];
  const target = info.latencyTargetMs ?? 150;
  if (info.estimatedLatencyMs != null) {
    const within = info.estimatedLatencyMs <= target ? 'within' : 'ABOVE';
    lines.push(
      `- Estimated end-to-end latency: ~${info.estimatedLatencyMs.toFixed(0)} ms ` +
        `(${within} the ≤ ${target.toFixed(0)} ms target)`,
    );
  }
  if (info.activeCleaningStages) lines.push(`- Active cleaning: ${info.activeCleaningStages}`);
  if (info.aecRefSource) lines.push(`- AEC reference source: ${info.aecRefSource}`);
  if (info.aecErleDb != null) lines.push(`- AEC echo reduction (ERLE): ${info.aecErleDb.toFixed(1)} dB`);
  if (info.bedReductionDb != null) {
    lines.push(`- Background-noise reduction (A/B proof): ${info.bedReductionDb.toFixed(1)} dB quieter`);
  }
  if (info.rmsReductionDb != null) {
    lines.push(`- Broadband level change (A/B proof): ${info.rmsReductionDb.toFixed(1)} dB`);
  }
  if (lines.length === 0) return '';
  return ['## Live measurements', ...lines].join('\n');
}

function commissionHealth(info: CommissioningInfo): string {
  const lines: string[] = [];
  if (info.frontOffsetDeg != null) lines.push(`- Front calibration offset: ${signed(info.frontOffsetDeg, 0)}°`);
  if (info.silentCapsules != null) {
    lines.push(
      info.silentCapsules.length > 0
        ? '- Silent / disabled capsules: ' + info.silentCapsules.map((c) => String(c)).join(', ')
        : '- Capsule health: all capsules active',
    );
  }
  if (lines.length === 0) return '';
  return ['## Health & calibration', ...lines].join('\n');
}

/**
 * A derived pass/fail checklist — the integrator's at-a-glance acceptance view —
 * plus a hand-signed form. Each check is computed from the config / validation /
 * measured info, never assumed passing.
 */
function commissionSignoff(config: SystemConfig, info: CommissioningInfo): string {
  const res = validate(config);
  const mics = config.devices.filter(isMicDevice);
  const checks: Array<[boolean, string]> = [
    [config.room != null && config.room.vertices.length > 0, 'Room geometry defined'],
    [mics.length > 0, 'At least one microphone / array present'],
  ];
  if (config.talkers.length > 0) {
    const rep = coverageReport(config);
    checks.push([
      rep.uncovered.length === 0,
      `All talkers within coverage (${rep.covered.length}/${config.talkers.length})`,
    ]);
  }
  const aecMics = mics.filter((m) => m.aec.enabled);
  if (aecMics.length > 0) {
    checks.push([
      aecMics.every((m) => Boolean(m.aec.referenceBusId)),
      'AEC reference assigned for every echo-cancelling mic',
    ]);
  }
  checks.push([
    res.errors.length === 0,
    `No configuration errors (${res.errors.length} error(s), ${res.warnings.length} warning(s))`,
  ]);
  if (info.estimatedLatencyMs != null) {
    const target = info.latencyTargetMs ?? 150;
    checks.push([
      info.estimatedLatencyMs <= target,
      `Estimated latency within target (~${info.estimatedLatencyMs.toFixed(0)} ms ≤ ${target.toFixed(0)} ms)`,
    ]);
  }
  if (info.bedReductionDb != null) {
    checks.push([
      info.bedReductionDb > 0,
      `Noise reduction verified by A/B proof (${info.bedReductionDb.toFixed(1)} dB quieter)`,
    ]);
  }
  if (info.silentCapsules != null) {
    checks.push([info.silentCapsules.length === 0, 'All capsules active (no silent capsules)']);
  }

  const passed = checks.filter(([ok]) => ok).length;
  const lines = ['## Commissioning sign-off', ''];
  for (const [ok, label] of checks) lines.push(`- [${ok ? 'x' : ' '}] ${label}`);
  lines.push('', `Checks passing: ${passed}/${checks.length}.`, '');
  lines.push(
    '| Field | |',
    '| --- | --- |',
    `| Commissioned by | ${info.commissionedBy || '________________'} |`,
    '| Signature | ________________ |',
    `| Date | ${info.date || '________________'} |`,
    '| Customer sign-off | ________________ |',
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Minimal Markdown -> HTML (only the constructs we emit)
// ---------------------------------------------------------------------------

const CSS =
  'body{font-family:Segoe UI,Arial,sans-serif;margin:24px;color:#1a1a1a}' +
  'h1{font-size:20px}h2{font-size:15px;margin-top:22px;border-bottom:1px solid #ddd;padding-bottom:3px}' +
  'table{border-collapse:collapse;font-size:13px;margin:6px 0}' +
  'th,td{border:1px solid #ccc;padding:3px 8px;text-align:left}th{background:#f2f2f2}' +
  'pre{background:#f6f6f6;border:1px solid #ddd;padding:8px;font-size:12px;overflow:auto}' +
  'ul{margin:4px 0}li{margin:2px 0}';

/** Escape like Python's `html.escape(s, quote=True)`. */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

function isSeparator(cells: string[]): boolean {
  return cells.every((c) => c.trim() !== '' && [...c].every((ch) => '-: '.includes(ch)));
}

function htmlTable(rows: string[]): string {
  let parsed = rows.map((r) =>
    r
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim()),
  );
  parsed = parsed.filter((r) => !isSeparator(r));
  if (parsed.length === 0) return '';
  const [head, ...body] = parsed;
  const th = head!.map((c) => `<th>${esc(c)}</th>`).join('');
  const trs = body
    .map((r) => '<tr>' + r.map((c) => `<td>${esc(c)}</td>`).join('') + '</tr>')
    .join('');
  return `<table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`;
}

function mdToHtml(md: string): string {
  const lines = md.split('\n');
  const out = [`<!doctype html><html><head><meta charset='utf-8'><style>${CSS}</style></head><body>`];
  let i = 0;
  const n = lines.length;
  let inCode = false;
  while (i < n) {
    const line = lines[i]!;
    if (line.trim().startsWith('```')) {
      out.push(inCode ? '</pre>' : '<pre>');
      inCode = !inCode;
      i += 1;
      continue;
    }
    if (inCode) {
      out.push(esc(line));
      i += 1;
      continue;
    }
    if (line.startsWith('## ')) {
      out.push(`<h2>${esc(line.slice(3))}</h2>`);
    } else if (line.startsWith('# ')) {
      out.push(`<h1>${esc(line.slice(2))}</h1>`);
    } else if (line.startsWith('|')) {
      const rows: string[] = [];
      while (i < n && lines[i]!.startsWith('|')) {
        rows.push(lines[i]!);
        i += 1;
      }
      out.push(htmlTable(rows));
      continue;
    } else if (line.startsWith('- ')) {
      out.push('<ul>');
      while (i < n && lines[i]!.startsWith('- ')) {
        out.push(`<li>${esc(lines[i]!.slice(2))}</li>`);
        i += 1;
      }
      out.push('</ul>');
      continue;
    } else if (line.trim()) {
      out.push(`<p>${esc(line)}</p>`);
    }
    i += 1;
  }
  if (inCode) out.push('</pre>');
  out.push('</body></html>');
  return out.join('\n');
}
