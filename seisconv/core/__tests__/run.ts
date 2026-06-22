// seisconv-core — self-contained test runner
//
// No test framework: uses only Node built-ins (node:fs, node:assert) so it runs
// under `npx tsx` (or any TS runner) without installing project dependencies.
//
//   cd seisconv && npx --yes tsx core/__tests__/run.ts
//
// Validates the ported parsers/writers/coords against the real sample data in
// D:\Projects\SeisconvApp\Data_Games (round-trip invariants + golden-value print).

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import {
  parseAny,
  parseSEGY,
  parseSU,
  parseSEG2,
  parseSEGD,
  parseTpimage,
  writeSEGY,
  writeSU,
  writeSEG2,
  writeSEGD,
  writeTapeImage,
  writeCSV,
  detect,
  latLonToUTM,
  utmToLatLon,
  latLonToITM,
  itmToLatLon,
  parseWithRegistry,
  listWriters,
  resampleLinear,
  resampleToInterval,
  applyAGC,
  getColor,
  colorSeismic,
  maxAbs,
  normFactorPercentile,
  decimateMinMax,
  parseSPSText,
  detectSPSType,
  runSPSQC,
  reprojectSPS,
  EPSG_DB,
  computeSemblance,
  fft,
  amplitudeSpectrum,
  nextPow2,
  rIEEE,
} from '../index';
import { bytesToBase64, base64ToBytes } from '../base64';

const DATA = process.env.SEISCONV_DATA || 'D:/Projects/SeisconvApp/Data_Games';
const SEGY = `${DATA}/00000186_SegY_Rev2.segy`;
const GEODE = `${DATA}/1006.dat`;
const BATCH_DIR = `${DATA}/Raw Original Data/GP_393_26_SegY`;

let passed = 0;
let failed = 0;
let skipped = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`      ${(e as Error).message}`);
  }
}

function skip(name: string, why: string): void {
  skipped++;
  console.log(`  ⊘ ${name}  (skipped: ${why})`);
}

function readBytes(path: string): Uint8Array {
  return new Uint8Array(readFileSync(path));
}

/** Compare two Float32Arrays for exact equality over the first `n` samples. */
function samplesEqual(a: Float32Array | null, b: Float32Array | null, n: number): boolean {
  if (!a || !b) return false;
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false;
  return true;
}

console.log('\nseisconv-core test run\n----------------------');

// ── SEG-Y ──────────────────────────────────────────────────────────────────
console.log('\n[SEG-Y]');
if (existsSync(SEGY)) {
  const bytes = readBytes(SEGY);

  test('detect() identifies SEG-Y', () => {
    assert.equal(detect(bytes, '00000186_SegY_Rev2.segy'), 'SEG-Y');
  });

  const pf = parseSEGY(bytes);
  console.log(
    `      golden: revision=${pf.revision} traceCount=${pf.traceCount} ` +
      `samplesTrace=${pf.bh.samplesTrace} sampleInt=${pf.bh.sampleInt}us dataFmt=${pf.bh.dataFmt}`,
  );

  test('parses traces with no errors', () => {
    assert.equal(pf.errors.length, 0, `errors: ${pf.errors.join('; ')}`);
    assert.ok(pf.traceCount > 0, 'expected > 0 traces');
  });

  test('first trace sample count matches header', () => {
    const t0 = pf.traces[0];
    assert.ok(t0.samples, 'first trace has samples');
    assert.equal(t0.samples!.length, t0.nSamples);
  });

  test('SEG-Y → writeSEGY → re-parse is sample-exact (IEEE float)', () => {
    const out = writeSEGY(pf, 2);
    const re = parseSEGY(out);
    assert.equal(re.traceCount, pf.traceCount, 'trace count preserved');
    const n = Math.min(pf.traces[0].nSamples, 65535);
    assert.ok(samplesEqual(pf.traces[0].samples, re.traces[0].samples, n), 'trace-0 samples identical');
  });

  test('SEG-Y → writeSEGY preserves srcX/srcY', () => {
    const out = writeSEGY(pf, 2);
    const re = parseSEGY(out);
    assert.equal(re.traces[0].hdr.srcX, pf.traces[0].hdr.srcX, 'srcX parity');
    assert.equal(re.traces[0].hdr.srcY, pf.traces[0].hdr.srcY, 'srcY parity');
  });

  test('SEG-Y → writeSU → parseSU round-trips samples', () => {
    const su = writeSU(pf);
    const re = parseSU(su);
    assert.equal(re.traceCount, pf.traceCount, 'trace count preserved');
    assert.ok(samplesEqual(pf.traces[0].samples, re.traces[0].samples, pf.traces[0].nSamples), 'trace-0 samples identical');
  });
} else {
  skip('SEG-Y suite', `${SEGY} not found`);
}

// ── SEG-2 / Geode .dat ───────────────────────────────────────────────────────
console.log('\n[SEG-2 / Geode .dat]');
if (existsSync(GEODE)) {
  const bytes = readBytes(GEODE);

  test('detect() identifies SEG-2 from .dat', () => {
    assert.equal(detect(bytes, '1006.dat'), 'SEG-2');
  });

  const pf = parseAny(bytes, '1006.dat');
  console.log(
    `      golden: format=${pf.format} traceCount=${pf.traceCount} ` +
      `samplesTrace=${pf.bh.samplesTrace} sampleInt=${pf.bh.sampleInt}us dataFmt=${pf.bh.dataFmt}`,
  );

  test('parses Geode traces', () => {
    assert.equal(pf.format, 'SEG-2');
    assert.ok(pf.traceCount > 0, 'expected > 0 traces');
    assert.ok(pf.bh.sampleInt && pf.bh.sampleInt > 0, 'sample interval populated');
  });

  test('first Geode trace has decoded samples', () => {
    const t0 = pf.traces[0];
    assert.ok(t0.samples && t0.samples.length === t0.nSamples, 'samples decoded');
  });
} else {
  skip('SEG-2 suite', `${GEODE} not found`);
}

// ── Batch SEG-Y ──────────────────────────────────────────────────────────────
console.log('\n[Batch SEG-Y]');
if (existsSync(BATCH_DIR)) {
  const files = readdirSync(BATCH_DIR).filter((f) => /\.sgy$/i.test(f));
  test(`batch parses ${files.length} .sgy files with no errors`, () => {
    assert.ok(files.length > 0, 'found .sgy files');
    for (const f of files) {
      const pf = parseAny(readBytes(`${BATCH_DIR}/${f}`), f);
      assert.equal(pf.errors.length, 0, `${f}: ${pf.errors.join('; ')}`);
      assert.ok(pf.traceCount > 0, `${f}: expected > 0 traces`);
    }
  });
} else {
  skip('Batch suite', `${BATCH_DIR} not found`);
}

// ── Coordinates ───────────────────────────────────────────────────────────────
console.log('\n[Coordinates]');
test('UTM forward/inverse round-trips (< 1e-6 deg)', () => {
  const lat = 32.0853;
  const lon = 34.7818; // Tel Aviv, UTM zone 36N
  const en = latLonToUTM(lat, lon, 36, 'N');
  const ll = utmToLatLon(en.E, en.N, 36, 'N');
  assert.ok(Math.abs(ll.lat - lat) < 1e-6, `lat err ${Math.abs(ll.lat - lat)}`);
  assert.ok(Math.abs(ll.lon - lon) < 1e-6, `lon err ${Math.abs(ll.lon - lon)}`);
});

test('ITM forward/inverse round-trips (< 1e-6 deg)', () => {
  const lat = 32.0853;
  const lon = 34.7818;
  const en = latLonToITM(lat, lon);
  const ll = itmToLatLon(en.E, en.N);
  assert.ok(Math.abs(ll.lat - lat) < 1e-6, `lat err ${Math.abs(ll.lat - lat)}`);
  assert.ok(Math.abs(ll.lon - lon) < 1e-6, `lon err ${Math.abs(ll.lon - lon)}`);
});

test('ITM lands a Tel Aviv point in the Israeli grid range', () => {
  const en = latLonToITM(32.0853, 34.7818);
  // New Israeli Grid: easting ~120k-280k, northing ~380k-790k
  assert.ok(en.E > 120000 && en.E < 280000, `E out of range: ${en.E}`);
  assert.ok(en.N > 380000 && en.N < 790000, `N out of range: ${en.N}`);
  console.log(`      golden: Tel Aviv ITM E=${en.E.toFixed(2)} N=${en.N.toFixed(2)}`);
});

// ── base64 (I/O bridge) ───────────────────────────────────────────────────────
console.log('\n[base64]');
test('base64 round-trips arbitrary byte lengths', () => {
  for (const len of [0, 1, 2, 3, 4, 5, 255, 1000, 65537]) {
    const a = new Uint8Array(len);
    for (let i = 0; i < len; i++) a[i] = (i * 31 + 7) & 0xff;
    const b = base64ToBytes(bytesToBase64(a));
    assert.equal(b.length, len, `length mismatch at len ${len}`);
    for (let i = 0; i < len; i++) assert.equal(b[i], a[i], `byte ${i} mismatch at len ${len}`);
  }
});
test('base64 encoding matches Node Buffer reference', () => {
  const a = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255, 65, 66, 67]);
  assert.equal(bytesToBase64(a), Buffer.from(a).toString('base64'));
});

// ── Format registry ──────────────────────────────────────────────────────────
console.log('\n[registry]');
test('registry lists writers and dispatches detect→parser', () => {
  const ids = listWriters().map((w) => w.id);
  assert.ok(ids.includes('segy1') && ids.includes('segy0') && ids.includes('su'), `writers: ${ids.join(',')}`);
  if (existsSync(SEGY)) {
    const pf = parseWithRegistry(readBytes(SEGY), '00000186_SegY_Rev2.segy');
    assert.equal(pf.format, 'SEG-Y');
    assert.ok(pf.traceCount > 0);
  }
});

// ── Processing (interpolation) ────────────────────────────────────────────────
console.log('\n[processing]');
test('resampleLinear preserves endpoints, length, and ramp values', () => {
  const a = Float32Array.from([0, 1, 2, 3]);
  const up = resampleLinear(a, 7);
  assert.equal(up.length, 7);
  assert.equal(up[0], 0);
  assert.equal(up[6], 3);
  assert.ok(Math.abs(up[3] - 1.5) < 1e-6, `midpoint ${up[3]}`);
  assert.deepEqual(Array.from(resampleLinear(a, 4)), [0, 1, 2, 3]);
  // regression: downsample to a single point must not produce NaN
  const one = resampleLinear(a, 1);
  assert.equal(one.length, 1);
  assert.ok(Number.isFinite(one[0]), `newLength=1 produced ${one[0]}`);
});
test('resampleToInterval rescales trace sample count when interval changes', () => {
  const ramp = resampleLinear(Float32Array.from([0, 100]), 101);
  const pf: any = {
    format: 'SEG-Y', revision: 0, bh: { sampleInt: 500, samplesTrace: 101 },
    traceCount: 1, errors: [], traces: [{ hdr: {}, samples: ramp, nSamples: 101 }],
  };
  const rs = resampleToInterval(pf, 1000);
  assert.equal(rs.bh.sampleInt, 1000);
  assert.equal(rs.traces[0].nSamples, 51);
  assert.ok(rs.traces[0].samples != null);
});

// ── Render engine (N1) ────────────────────────────────────────────────────────
console.log('\n[render engine]');
test('AGC normalizes a constant-amplitude trace to ~1', () => {
  const s = new Float32Array(200).fill(5);
  const rms = applyAGC(s, 50, 1000, 'rms');
  assert.equal(rms.length, 200);
  assert.ok(Math.abs(rms[100] - 1) < 1e-6, `rms mid ${rms[100]}`);
  assert.ok(Number.isFinite(rms[0]) && Number.isFinite(rms[199]));
  assert.ok(Math.abs(applyAGC(s, 50, 1000, 'mean')[100] - 1) < 1e-6);
});
test('color maps hit known anchors', () => {
  assert.deepEqual(colorSeismic(0), [255, 255, 255]);
  assert.deepEqual(colorSeismic(1), [255, 0, 0]);
  assert.deepEqual(colorSeismic(-1), [0, 0, 255]);
  assert.deepEqual(getColor(0, 'gray'), [128, 128, 128]);
  assert.deepEqual(getColor(5, 'amber'), [255, 140, 0]);
});
test('maxAbs / percentile / decimate behave', () => {
  const s = Float32Array.from([-3, 1, 2, -1]);
  assert.equal(maxAbs(s), 3);
  assert.ok(normFactorPercentile(s, 0.95) > 0);
  const big = new Float32Array(1000);
  for (let i = 0; i < 1000; i++) big[i] = Math.sin(i / 10);
  assert.ok(decimateMinMax(big, 100).length <= 100);
});

// ── SPS (N5) ──────────────────────────────────────────────────────────────────
console.log('\n[sps]');
test('SPS parser reads S/R records, headers, and ITM projection', () => {
  const put = (line: string, start: number, txt: string) => {
    const padded = line.padEnd(Math.max(line.length, start + txt.length), ' ');
    return padded.slice(0, start) + txt + padded.slice(start + txt.length);
  };
  let h = 'H18'.padEnd(80, ' ');
  h = put(h, 32, 'ITM');
  let s = put('S'.padEnd(80, ' '), 1, '101');
  s = put(s, 11, '200'); s = put(s, 23, '1');
  s = put(s, 46, '660000.0'); s = put(s, 55, '3550000.0'); s = put(s, 65, '120.0');
  let r = put('R'.padEnd(80, ' '), 1, '500');
  r = put(r, 11, '10'); r = put(r, 23, '1');
  r = put(r, 46, '661000.0'); r = put(r, 55, '3551000.0'); r = put(r, 65, '95.0');
  const sps = parseSPSText([h, s, r].join('\n'));
  assert.equal(sps.sources.length, 1, `sources ${sps.sources.length}`);
  assert.equal(sps.receivers.length, 1, `receivers ${sps.receivers.length}`);
  assert.equal(sps.layout, 'SPS2.1');
  assert.ok(Math.abs(sps.sources[0].easting - 660000) < 1, `E ${sps.sources[0].easting}`);
  assert.ok(Math.abs(sps.receivers[0].northing - 3551000) < 1, `N ${sps.receivers[0].northing}`);
  assert.equal(sps.projection?.subtype, 'TM');
  const lat0 = sps.projection?.latOrigin ?? 0;
  assert.ok(lat0 > 31 && lat0 < 32, `latOrigin ${lat0}`);
  assert.equal(detectSPSType('survey.s01'), 'S');
  assert.equal(detectSPSType('survey.r'), 'R');
});
test('SPS QC flags a duplicate source', () => {
  const put = (line: string, start: number, txt: string) => {
    const padded = line.padEnd(Math.max(line.length, start + txt.length), ' ');
    return padded.slice(0, start) + txt + padded.slice(start + txt.length);
  };
  const mk = () => {
    let s = put('S'.padEnd(80, ' '), 1, '101');
    s = put(s, 11, '200'); s = put(s, 23, '1');
    s = put(s, 46, '660000.0'); s = put(s, 55, '3550000.0'); s = put(s, 65, '120.0');
    return s;
  };
  const qc = runSPSQC(parseSPSText([mk(), mk()].join('\n')), {});
  assert.ok(qc.some((r) => r.cat === 'Duplicate' && r.sev === 'error'), 'duplicate not flagged');
});
test('SPS reprojection ITM→WGS84 lands near Israel', () => {
  const put = (line: string, start: number, txt: string) => {
    const padded = line.padEnd(Math.max(line.length, start + txt.length), ' ');
    return padded.slice(0, start) + txt + padded.slice(start + txt.length);
  };
  const src: any = {
    subtype: 'TM', a: 6378137, invF: 298.257222101, centralMeridian: 35.20451694444, latOrigin: 31.73439361111,
    scaleFactor: 1.0000067, falseEasting: 219529.584, falseNorthing: 626907.39,
    helmert: { dx: 23.772, dy: 17.49, dz: 17.859, rx: -0.313, ry: -1.853, rz: 1.673, ds: 0 },
  };
  let s = put('S'.padEnd(80, ' '), 1, '101');
  s = put(s, 46, '179622.00');
  s = put(s, 55, '665896.00');
  const wgs = EPSG_DB.find((c) => c.code === 'EPSG:4326')!;
  const txt = reprojectSPS([s], wgs, 'S', src);
  const lon = parseFloat(txt.substring(46, 55));
  const lat = parseFloat(txt.substring(55, 65));
  assert.ok(lon > 33 && lon < 37, `lon ${lon}`);
  assert.ok(lat > 29 && lat < 34, `lat ${lat}`);
});

test('semblance returns a valid [0,1] matrix with a coherent peak', () => {
  const traces: any[] = [];
  for (let k = 0; k < 12; k++) {
    const s = new Float32Array(200);
    s[100] = 1; // flat spike across the gather
    traces.push({ hdr: {}, samples: s, nSamples: 200 });
  }
  const r = computeSemblance(traces, 2000, 4000, 6000, 500);
  assert.equal(r.vels.length, 5);
  assert.equal(r.semb.length, 5 * 200);
  let max = 0;
  for (const v of r.semb) {
    assert.ok(Number.isFinite(v), 'no NaN in semblance');
    if (v > max) max = v;
  }
  assert.ok(max > 0.5 && max <= 1.0001, `peak semblance ${max}`);
});

console.log('\n[spectrum]');
test('nextPow2 rounds up to a power of two', () => {
  assert.equal(nextPow2(1), 1);
  assert.equal(nextPow2(2), 2);
  assert.equal(nextPow2(3), 4);
  assert.equal(nextPow2(1000), 1024);
});

test('fft∘ifft round-trips a random signal (< 1e-9)', () => {
  const N = 64;
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const orig = new Float64Array(N);
  for (let i = 0; i < N; i++) { re[i] = Math.sin(i * 0.7) + 0.3 * Math.cos(i * 2.1); orig[i] = re[i]; }
  fft(re, im, false);
  fft(re, im, true);
  let maxErr = 0;
  for (let i = 0; i < N; i++) maxErr = Math.max(maxErr, Math.abs(re[i] - orig[i]), Math.abs(im[i]));
  assert.ok(maxErr < 1e-9, `round-trip error ${maxErr}`);
});

test('amplitudeSpectrum peaks at the input frequency with correct amplitude', () => {
  const N = 512;
  const fs = 500; // Hz → siUs = 2000
  const f0 = 62.5; // Hz — lands exactly on bin 64 (fs/N = 0.9766 Hz)
  const amp0 = 1; // unit-amplitude cosine
  const s = new Float32Array(N);
  for (let i = 0; i < N; i++) s[i] = amp0 * Math.cos((2 * Math.PI * f0 * i) / fs);
  const sp = amplitudeSpectrum(s, 2000);
  assert.equal(sp.freqs.length, N / 2);
  assert.ok(Math.abs(sp.nyquist - 250) < 1e-6, `nyquist ${sp.nyquist}`);
  let max = 0, peakK = 0;
  for (let k = 0; k < sp.amp.length; k++) {
    assert.ok(Number.isFinite(sp.amp[k]), 'no NaN in spectrum');
    if (sp.amp[k] > max) { max = sp.amp[k]; peakK = k; }
  }
  const binHz = fs / N;
  assert.ok(Math.abs(sp.freqs[peakK] - f0) < binHz, `peak at ${sp.freqs[peakK]} Hz, expected ${f0}`);
  assert.ok(Math.abs(max - amp0) < 0.05, `peak amplitude ${max}, expected ~${amp0}`);
  console.log(`      peak ${sp.freqs[peakK].toFixed(1)} Hz (amp ${max.toFixed(3)})`);
});

// ── Robustness: variable-length traces + truncated/garbage buffers ────────────
// Regression for the batch-convert crash "Offset is outside the bounds of the
// DataView": the writers sized the output buffer from the FIRST trace's sample
// count but wrote each trace's own count, overrunning whenever a later trace was
// longer than the first. Parsers must also never throw on a truncated buffer.
console.log('\n[robustness]');

/** Build an in-memory ParsedFile with the given per-trace sample counts (ramps). */
function mkPF(sampleCounts: number[]): any {
  const traces = sampleCounts.map((n, t) => {
    const s = new Float32Array(n);
    for (let i = 0; i < n; i++) s[i] = (t + 1) * 1000 + i; // distinct, exact-in-float32 values
    return { hdr: {}, samples: s, nSamples: n, dataFmt: 5 };
  });
  return { format: 'SEG-Y', revision: 0, bh: { sampleInt: 2000, samplesTrace: sampleCounts[0] }, traceCount: traces.length, errors: [], traces };
}

test('writeSEGY does NOT overrun when a later trace is longer than the first', () => {
  // short first trace (aux/timebreak) followed by full-length data traces — the
  // exact shape that threw "Offset is outside the bounds of the DataView" before
  // the fix (buffer sized from trc[0]=10, write loop ran out to 2001).
  const counts = [10, 2001, 2001, 2001];
  const pf = mkPF(counts);
  let out: Uint8Array = new Uint8Array();
  assert.doesNotThrow(() => { out = writeSEGY(pf, 1); }, 'writeSEGY threw on variable-length traces');
  // Buffer must be sized for the LONGEST trace (2001), in fixed-stride slots.
  const maxN = Math.max(...counts);
  const tsz = 240 + maxN * 4;
  assert.equal(out.length, 3600 + counts.length * tsz, 'buffer sized for the longest trace');
  // Each trace's samples must actually be in its slot (read slot 0 directly,
  // since the short first trace makes header-driven re-parse ambiguous).
  for (let t = 0; t < counts.length; t++) {
    const base = 3600 + t * tsz + 240;
    for (let i = 0; i < counts[t]; i++) {
      assert.equal(rIEEE(out, base + i * 4), pf.traces[t].samples![i], `trace ${t} sample ${i}`);
    }
  }
});

test('writeSEGY stays bit-identical for uniform traces (longest == first)', () => {
  const pf = mkPF([100, 100, 100]);
  const out = writeSEGY(pf, 1);
  const re = parseSEGY(out);
  assert.equal(re.traceCount, 3);
  for (let t = 0; t < 3; t++) {
    assert.ok(samplesEqual(pf.traces[t].samples, re.traces[t].samples, 100), `trace ${t} identical`);
  }
});

test('writeSU does NOT overrun when a later trace is longer than the first', () => {
  const counts = [5, 300, 300];
  const pf = mkPF(counts);
  let su: Uint8Array = new Uint8Array();
  assert.doesNotThrow(() => { su = writeSU(pf); }, 'writeSU threw on variable-length traces');
  const maxN = Math.max(...counts);
  const tsz = 240 + maxN * 4;
  assert.equal(su.length, counts.length * tsz, 'SU buffer sized for the longest trace');
  // Verify each trace's samples landed in its fixed-stride slot.
  for (let t = 0; t < counts.length; t++) {
    const base = t * tsz + 240;
    for (let i = 0; i < counts[t]; i++) {
      assert.equal(rIEEE(su, base + i * 4), pf.traces[t].samples![i], `SU trace ${t} sample ${i}`);
    }
  }
});

test('parseSEGY does NOT throw on a buffer truncated mid-trace (degrades gracefully)', () => {
  // Make a valid 3-trace SEG-Y, then cut it 50 bytes into the last trace's data.
  const full = writeSEGY(mkPF([100, 100, 100]), 1);
  const cut = full.slice(0, full.length - 50);
  let pf: any;
  assert.doesNotThrow(() => { pf = parseSEGY(cut); }, 'parseSEGY threw on truncated buffer');
  assert.ok(Array.isArray(pf.errors), 'returns a ParsedFile with errors[]');
  assert.ok(pf.traceCount >= 2, `kept the intact traces (got ${pf.traceCount})`);
});

test('parseSU does NOT throw on a buffer truncated mid-samples', () => {
  const full = writeSU(mkPF([200, 200]));
  const cut = full.slice(0, full.length - 123); // chop into the 2nd trace's samples
  let pf: any;
  assert.doesNotThrow(() => { pf = parseSU(cut); }, 'parseSU threw on truncated buffer');
  assert.ok(Array.isArray(pf.errors) && Array.isArray(pf.traces), 'returns a ParsedFile');
});

test('parseAny does NOT throw on garbage / mis-detection-prone bytes', () => {
  // (a) random short buffer; (b) a 3600+ byte buffer whose byte0 is not a 'C'
  // (would-be SEG-D BCD bait) — must still return a ParsedFile, never throw.
  const garbage = new Uint8Array(64);
  for (let i = 0; i < garbage.length; i++) garbage[i] = (i * 37 + 11) & 0xff;
  assert.doesNotThrow(() => {
    const pf = parseAny(garbage, 'junk.bin');
    assert.ok(Array.isArray(pf.errors), 'garbage → ParsedFile');
  }, 'parseAny threw on garbage');

  const big = new Uint8Array(4000); // all-zero header, ns fields = 0 → no valid traces
  assert.doesNotThrow(() => {
    const pf = parseAny(big, 'zero.sgy');
    assert.ok(Array.isArray(pf.traces) && Array.isArray(pf.errors), 'zero-buffer → ParsedFile');
  }, 'parseAny threw on zero buffer');
});

// ── Writers (new outputs: SEG-Y Rev 2, SEG-2, SEG-D, Tape Image, CSV) ─────────
// Each writer is exercised offline against a synthetic ParsedFile (mkPF), so the
// suite stays deterministic whether or not the D: sample data is present.
console.log('\n[writers]');

test('writeSEGY Rev 2 → parseSEGY re-parses with revision 2 (sample-exact)', () => {
  const pf = mkPF([100, 100, 100]);
  const out = writeSEGY(pf, 2);
  const re = parseSEGY(out);
  assert.equal(re.errors.length, 0, `errors: ${re.errors.join('; ')}`);
  assert.equal(re.revision, 2, 'Rev 2 marker honoured');
  assert.equal(re.traceCount, 3, 'trace count preserved');
  assert.ok(samplesEqual(pf.traces[0].samples, re.traces[0].samples, 100), 'trace-0 samples identical');
});

// ── CSV / ASCII export (write-only) ────────────────────────────────────────────
console.log('\n[csv]');
test('writeCSV emits preamble, header row, and one row per sample (right column count)', () => {
  const pf: any = {
    format: 'SEG-Y', revision: 0,
    bh: { sampleInt: 2000, samplesTrace: 3 },
    traceCount: 2, errors: [],
    traces: [
      { hdr: {}, samples: Float32Array.from([1.5, 2.5, 3.5]), nSamples: 3 },
      { hdr: {}, samples: Float32Array.from([10, 20]), nSamples: 2 }, // shorter trace
    ],
  };
  const txt = new TextDecoder().decode(writeCSV(pf));
  const lines = txt.trim().split('\n');
  // preamble is '#'-commented
  assert.ok(lines[0].startsWith('# SeisConv CSV export'), `preamble: ${lines[0]}`);
  // header row: 'sample,time_ms,t1,t2' → 2 fixed + 2 trace columns
  const hIdx = lines.findIndex((l) => l.startsWith('sample,'));
  assert.ok(hIdx >= 0, 'header row present');
  assert.equal(lines[hIdx], 'sample,time_ms,t1,t2', `header: ${lines[hIdx]}`);
  assert.equal(lines[hIdx].split(',').length, 4, 'header has 4 columns');
  // first data row: sample 0, time 0 ms, both trace amplitudes
  assert.equal(lines[hIdx + 1], '0,0,1.5,10', `row0: ${lines[hIdx + 1]}`);
  assert.equal(lines[hIdx + 1].split(',').length, 4, 'data row has 4 columns');
  // last row: shorter trace t2 produces a trailing blank cell; time = 2*2000/1000 = 4 ms
  assert.equal(lines[hIdx + 3], '2,4,3.5,', `last row: ${lines[hIdx + 3]}`);
});

// ── SEG-2 writer round-trip ───────────────────────────────────────────────
console.log('\n[SEG-2 writer]');
test('writeSEG2 → parseSEG2 round-trips traceCount and trace-0 samples', () => {
  const ramp = (t: number, nn: number) => {
    const s = new Float32Array(nn);
    for (let i = 0; i < nn; i++) s[i] = (t + 1) * 1000 + i + 0.5;
    return s;
  };
  const counts = [8, 256, 256]; // short first trace + full-length data traces
  const traces = counts.map((nn, t) => ({ hdr: { channelNum: t + 1 }, samples: ramp(t, nn), nSamples: nn, dataFmt: 4 }));
  const pf: any = { format: 'SEG-2', revision: 1, bh: { sampleInt: 2000, samplesTrace: counts[0] }, traceCount: traces.length, errors: [], traces };
  const out = writeSEG2(pf);
  const re = parseSEG2(out);
  assert.equal(re.errors.length, 0, `errors: ${re.errors.join('; ')}`);
  assert.equal(re.traceCount, pf.traceCount, 'trace count preserved');
  const n = pf.traces[0].nSamples;
  let maxErr = 0;
  for (let i = 0; i < n; i++) maxErr = Math.max(maxErr, Math.abs(re.traces[0].samples![i] - pf.traces[0].samples![i]));
  assert.ok(maxErr < 1e-3, `trace-0 samples within float tolerance (maxErr ${maxErr})`);
});

// ── SEG-D writer (round-trip) ──────────────────────────────────────────────
console.log('\n[SEG-D writer]');
test('writeSEGD Rev 1 → detect() = SEG-D and re-parses to >0 traces (sample-exact)', () => {
  const pf = mkPF([100, 100, 100]);
  const out = writeSEGD(pf, false);
  assert.equal(detect(out), 'SEG-D', 'detect identifies SEG-D');
  const re = parseSEGD(out);
  assert.equal(re.errors.length, 0, `errors: ${re.errors.join('; ')}`);
  assert.equal(re.traceCount, 3, 'trace count preserved');
  assert.ok(samplesEqual(pf.traces[0].samples, re.traces[0].samples, 100), 'trace-0 samples identical');
});
test('writeSEGD Rev 3 → detect() = SEG-D, revision 3, re-parses to >0 traces', () => {
  const pf = mkPF([100, 100, 100]);
  const out = writeSEGD(pf, true);
  assert.equal(detect(out), 'SEG-D', 'detect identifies SEG-D');
  const re = parseSEGD(out);
  assert.equal(re.errors.length, 0, `errors: ${re.errors.join('; ')}`);
  assert.equal(re.revision, 3, 'Rev 3 marker honoured');
  assert.ok(re.traceCount > 0, 'expected > 0 traces');
  assert.ok(samplesEqual(pf.traces[2].samples, re.traces[2].samples, 100), 'trace-2 samples identical');
});

// ── SEG standards compliance regressions ───────────────────────────────────
// Guards the per-format conformance fixes so a future change that reverts them
// (back to a non-standard byte) is caught here, not by a downstream reader.
console.log('\n[compliance]');

test('writeSEGD stamps the conformant IEEE-float data sample format code 8058', () => {
  const out = writeSEGD(mkPF([64, 64]), false);
  // GH1 bytes 2-3 (BCD): code 8058 = 0x80 0x58. The old non-standard 0032 must
  // never be emitted again.
  assert.equal(out[2], 0x80, `GH1 byte2 expected 0x80 (got 0x${out[2].toString(16)})`);
  assert.equal(out[3], 0x58, `GH1 byte3 expected 0x58 (got 0x${out[3].toString(16)})`);
});

test('parseSEGD still accepts the legacy 0032 format code (backward compat)', () => {
  const out = writeSEGD(mkPF([64, 64]), false);
  out[2] = 0x00;
  out[3] = 0x32; // downgrade to the legacy SeisConv code
  const re = parseSEGD(out);
  assert.equal(re.errors.length, 0, `errors: ${re.errors.join('; ')}`);
  assert.equal(re.traceCount, 2, 'legacy 0032 still parses to its traces');
});

test('writeSEG2 places the string-terminator size at FDB byte 8 (spec BccBcc @8)', () => {
  const pf = mkPF([32, 32]);
  pf.format = 'SEG-2';
  const out = writeSEG2(pf);
  // Pullan 1990 / ObsPy require byte 8 = 1 or 2; byte 11 = line-terminator size.
  assert.equal(out[8], 1, `FDB byte8 (string-term size) expected 1 (got ${out[8]})`);
  assert.equal(out[9], 0x00, 'FDB byte9 (string-term char) expected 0x00');
  assert.equal(out[11], 1, `FDB byte11 (line-term size) expected 1 (got ${out[11]})`);
  assert.equal(out[12], 0x0a, 'FDB byte12 (line-term char) expected 0x0A');
});

test('writeSEG2 emits SAMPLE_INTERVAL in SECONDS and round-trips the µs value', () => {
  const pf = mkPF([32, 32]);
  pf.format = 'SEG-2';
  pf.bh.sampleInt = 2000; // µs
  const out = writeSEG2(pf);
  const txt = new TextDecoder().decode(out);
  // 2000 µs → 0.002 s, NOT "2.000000" (ms). A 1000× error in any conformant reader.
  assert.ok(/SAMPLE_INTERVAL\s+0\.002/.test(txt), 'SAMPLE_INTERVAL must be in seconds (0.002…)');
  const re = parseSEG2(out);
  assert.equal(re.bh.sampleInt, 2000, `sampleInt must round-trip to 2000 µs (got ${re.bh.sampleInt})`);
});

test('SEG-Y revision word decodes the major byte (rev 2.1 = 0x0201 → rev 2)', () => {
  const out = writeSEGY(mkPF([16, 16]), 2);
  // Stamp a minor revision (0x0201) directly in the binary header (byte 3501-3502)
  // and confirm the parser reports major=2, not rev 0.
  out[3200 + 300] = 0x02;
  out[3200 + 301] = 0x01;
  const re = parseSEGY(out);
  assert.equal(re.revision, 2, 'major revision 2 honoured regardless of nonzero minor');
  assert.equal(re.bh.revMinor, 1, 'minor revision retained');
});

test('writeSU preserves trace geometry (fldr/sp/cdp/offset) and defaults trid=1', () => {
  const traces = [0, 1].map((t) => {
    const s = new Float32Array(16);
    return { hdr: { fieldRec: 7, srcPt: 101, ensemble: 555, trcEns: 3, offset: -250, traceId: 0 }, samples: s, nSamples: 16 };
  });
  const pf: any = { format: 'SEG-Y', revision: 1, bh: { sampleInt: 2000, samplesTrace: 16 }, traceCount: 2, errors: [], traces };
  const re = parseSU(writeSU(pf));
  const h = re.traces[0].hdr;
  assert.equal(h.ffid, 7, 'fldr preserved');
  assert.equal(h.sp, 101, 'shot/source point preserved');
  assert.equal(h.cdp, 555, 'cdp preserved');
  assert.equal(h.cdpTrace, 3, 'cdp trace preserved');
  assert.equal(h.offset, -250, 'offset preserved');
  assert.equal(h.traceId, 1, 'trid defaults to 1 (seismic) when input is 0');
});

// ── TPIMAGE (tape image) ──────────────────────────────────────────────────────
console.log('\n[tpimage]');
test('writeTapeImage wraps a SEG-Y that parseTpimage + detect() recover', () => {
  const pf = mkPF([100, 100, 100]); // reuses the run.ts mkPF helper
  const tp = writeTapeImage(pf); // defaults: label 'ansi', volSerial 'SEI001', innerFmt 'segy1'
  assert.equal(detect(tp, 'tape.tpimage'), 'TPIMAGE', 'image detects as TPIMAGE');
  const files = parseTpimage(tp);
  assert.ok(files.length >= 1, `expected >=1 embedded file, got ${files.length}`);
  assert.equal(detect(files[0].bytes, files[0].name), 'SEG-Y', 'embedded file is SEG-Y');
  // round-trip the embedded SEG-Y back to traces
  const re = parseSEGY(files[0].bytes);
  assert.equal(re.traceCount, 3, 'embedded SEG-Y trace count preserved');
  // 'none' label mode still yields a detectable SEG-Y block
  const raw = parseTpimage(writeTapeImage(pf, { label: 'none' }));
  assert.ok(raw.length >= 1 && detect(raw[0].bytes, raw[0].name) === 'SEG-Y', 'unlabeled image still extracts SEG-Y');
});

// ── Security: memory-DoS hardening in the binary parsers ──────────────────────
// Regression for two parser allocation findings:
//  (HIGH) seg2.ts allocated new Float32Array(nSamples) from an attacker-controlled
//         header field that was DECOUPLED from the on-disk data-block size — a
//         crafted ~100KB SEG-2 (nSamples=999999, tiny data block) could allocate
//         ~7.6 GB and OOM the worker. nSamples must be bounded by available bytes.
//  (LOW)  segd.ts 20-bit branch used sptStored WITHOUT the Math.min clamp the
//         32-bit / 24-bit branches have, so an inflated bytes-per-scan field could
//         over-allocate. It must clamp ns = min(ns, floor(rem*2/5)).
// The valid Geode sample must still parse to its true, unchanged sample counts.
console.log('\n[security]');

// LE writers for crafting a hostile SEG-2 buffer.
function w16le(b: Uint8Array, o: number, v: number): void {
  b[o] = v & 0xff;
  b[o + 1] = (v >> 8) & 0xff;
}
function w32le(b: Uint8Array, o: number, v: number): void {
  b[o] = v & 0xff;
  b[o + 1] = (v >> 8) & 0xff;
  b[o + 2] = (v >> 16) & 0xff;
  b[o + 3] = (v >> 24) & 0xff;
}

/**
 * Craft a structurally-valid SEG-2 with ONE trace whose TDB declares a huge
 * nSamples (999999) but whose on-disk data block is tiny (8 bytes = 2 IEEE
 * float32 samples). A pre-fix parser would allocate ~4 MB for this single trace
 * (and ~7.6 GB for the x2000 multi-trace variant in the wild); the fix must clamp
 * nSamples to the data-block budget (= 2 here).
 */
function craftHostileSEG2(): Uint8Array {
  const tdbSize = 32; // fixed TDB header only, no free-form
  const dataBlockSize = 8; // 2 IEEE float32 samples actually on disk
  const trcOff = 64; // past the 32-byte FDB + a 32-slot pad; well clear of ptr array
  const buf = new Uint8Array(trcOff + tdbSize + dataBlockSize);
  // FDB
  buf[0] = 0x3a;
  buf[1] = 0x55; // LE magic
  w16le(buf, 2, 1); // revision 1
  w16le(buf, 6, 1); // nTraces = 1
  buf[10] = 0; // string-terminator length = 0 → ST defaults to 0x00
  buf[11] = 1; // line-terminator length = 1
  buf[12] = 0x0a; // line terminator '\n'
  // Trace pointer array at fixed byte 32: trace 0 → trcOff.
  w32le(buf, 32, trcOff);
  // Trace descriptor block.
  w16le(buf, trcOff, 0x4422); // TDB ID
  w16le(buf, trcOff + 2, tdbSize); // TDB size
  w32le(buf, trcOff + 4, dataBlockSize); // data block size (TINY)
  w32le(buf, trcOff + 8, 999999); // nSamples (HUGE / attacker-controlled)
  w16le(buf, trcOff + 12, 4); // data format 4 = IEEE float32 (4 bytes/sample)
  // 8 bytes of sample data follow at trcOff+tdbSize.
  return buf;
}

test('SEG-2 with a huge declared nSamples + tiny data block parses without OOM (samples bounded by bytes)', () => {
  const hostile = craftHostileSEG2();
  let pf: any;
  assert.doesNotThrow(() => { pf = parseSEG2(hostile); }, 'parseSEG2 threw on the crafted file');
  assert.ok(pf.traceCount >= 1, `expected the trace to be parsed, got ${pf.traceCount}`);
  const t0 = pf.traces[0];
  // The allocation MUST be bounded by the 8-byte data block / 4 = 2 samples,
  // NOT the declared 999999. Assert it is small (not ~1M).
  assert.ok(t0.nSamples <= 2, `nSamples not clamped to data block: ${t0.nSamples}`);
  assert.ok(t0.samples != null && t0.samples.length === t0.nSamples, 'samples length matches clamped nSamples');
  assert.ok(t0.nSamples < 1000, `sanity: clamped count must be far below 1M, got ${t0.nSamples}`);
});

/**
 * Craft a MULTI-TRACE budget-bypass SEG-2 (~100KB): up to 2000 trace pointers
 * ALL aimed at the SAME tiny data region, each TDB declaring nSamples=999999
 * with dataBlockSize=0 (so the per-trace clamp falls back to "remaining file
 * bytes"). Pre-budget-fix, every trace independently clamped to ~filesize/4 and
 * allocated a full ~filesize/4 Float32Array → total = O(traces × filesize)
 * (measured: a 2MB file → ~3.9 GB). The FILE-WIDE budget must bound the TOTAL
 * sample allocation across ALL traces to O(filesize).
 */
function craftBudgetBypassSEG2(): Uint8Array {
  const N = 2000; // trace pointers
  const ptrBase = 32; // fixed trace-pointer array offset
  const ptrArrayEnd = ptrBase + N * 4;
  // Shared trace descriptor block, placed just past the pointer array. Every
  // pointer aims here, so all traces overlap on the same data region.
  const trcOff = ptrArrayEnd + 16;
  const tdbSize = 32; // fixed TDB header only
  const dataStart = trcOff + tdbSize;
  // Pad the file out to ~100KB so "remaining bytes" per trace is large.
  const fileLen = Math.max(100 * 1024, dataStart + 64);
  const buf = new Uint8Array(fileLen);
  // FDB
  buf[0] = 0x3a;
  buf[1] = 0x55; // LE magic
  w16le(buf, 2, 1); // revision 1
  w16le(buf, 6, N); // nTraces = 2000
  buf[10] = 0; // string-terminator length = 0 → ST defaults to 0x00
  buf[11] = 1; // line-terminator length = 1
  buf[12] = 0x0a; // line terminator '\n'
  // Trace pointer array: ALL N pointers → the SAME trcOff (overlapping).
  for (let t = 0; t < N; t++) w32le(buf, ptrBase + t * 4, trcOff);
  // The single shared trace descriptor block.
  w16le(buf, trcOff, 0x4422); // TDB ID
  w16le(buf, trcOff + 2, tdbSize); // TDB size
  w32le(buf, trcOff + 4, 0); // dataBlockSize = 0 → clamp falls back to remaining bytes
  w32le(buf, trcOff + 8, 999999); // nSamples (HUGE / attacker-controlled)
  w16le(buf, trcOff + 12, 4); // data format 4 = IEEE float32 (4 bytes/sample)
  return buf;
}

test('SEG-2 with 2000 overlapping trace pointers (dataBlockSize=0) bounds TOTAL allocation by filesize, not traces×filesize', () => {
  const hostile = craftBudgetBypassSEG2();
  const start = Date.now();
  let pf: any;
  assert.doesNotThrow(() => { pf = parseSEG2(hostile); }, 'parseSEG2 threw on the multi-trace budget-bypass file');
  const elapsed = Date.now() - start;
  // The whole point: TOTAL sample bytes across ALL traces must be O(filesize),
  // not O(traces × filesize). Sum the allocated bytes and assert a small multiple
  // of the file size. (Pre-fix this was ~2000 × filesize/4 = 500× filesize.)
  let totalSampleBytes = 0;
  let allocatedTraces = 0;
  for (const tr of pf.traces) {
    const n = tr.samples ? tr.samples.length : 0;
    totalSampleBytes += n * 4; // IEEE float32 = 4 B/sample
    if (tr.samples) allocatedTraces++;
    // Every individual trace must also still be per-trace clamped.
    assert.ok(!tr.samples || tr.samples.length === tr.nSamples, 'samples length matches nSamples');
  }
  assert.ok(
    totalSampleBytes <= 4 * hostile.length,
    `TOTAL sample allocation must be ≤ 4× filesize: ${totalSampleBytes} bytes vs file ${hostile.length} (×${(totalSampleBytes / hostile.length).toFixed(1)})`,
  );
  // And it must not hang: parsing 2000 overlapping pointers should be sub-second.
  assert.ok(elapsed < 3000, `parse took too long (${elapsed} ms) — possible O(traces×filesize) blow-up`);
  console.log(
    `      golden: budget-bypass — traces=${pf.traceCount} allocated=${allocatedTraces} ` +
      `totalSampleBytes=${totalSampleBytes} (file ${hostile.length}, ${(totalSampleBytes / hostile.length).toFixed(2)}× filesize, ${elapsed} ms)`,
  );
});

/**
 * Craft a SEG-D whose GH1 declares a 20-bit packed format with an inflated
 * bytes-per-scan field (→ sptStored ~400000) on a tiny file. The 20-bit decode
 * branch must clamp ns to floor(rem*2/5), not honour the forged sptStored.
 */
function craftHostileSEGD20bit(): Uint8Array {
  const buf = new Uint8Array(120);
  // GH1: file number (BCD) bytes 0-1, format code (BCD) bytes 2-3.
  // fmtCode must NOT be 32/8032/68/8068 so the parser takes the 20-bit branch.
  buf[2] = 0x00;
  buf[3] = 0x36; // fmtCode = 0036 (20-bit), bcd2 → 0*100 + 36
  buf[9] = 0x24; // year BCD (cosmetic)
  // addlBlocks = (b[10]>>4)&0xf = 0; Julian-day low bits = 0.
  buf[10] = 0x00;
  buf[11] = 0x00;
  // bytes-per-scan (BCD) in 18-20 → inflate to 999999 → sptStored = round(/2.5) = 400000.
  buf[18] = 0x99;
  buf[19] = 0x99;
  buf[20] = 0x99;
  // numChanSets = (b[22]>>4)&0xf, extHdrLen = (b[23]>>4)&0xf, extlHdrLen = b[23]&0xf.
  buf[21] = 0x20; // base-scan-interval code 2 (cosmetic, → 2000us)
  buf[22] = 0x00; // numChanSets = 0 → loop runs (numChanSets||1)=1 channel-set block
  buf[23] = 0x00; // no extended headers
  // The channel-set descriptor block (32 bytes) starts at off=32; leave it zero
  // (seisCC stays 0 → defaults to 1). The trace record header begins thereafter.
  return buf;
}

test('SEG-D 20-bit packed with a forged bytes-per-scan is bounded by remaining bytes (not ~400k)', () => {
  const hostile = craftHostileSEGD20bit();
  let pf: any;
  assert.doesNotThrow(() => { pf = parseSEGD(hostile); }, 'parseSEGD threw on the crafted 20-bit file');
  assert.ok(pf.traceCount >= 1, `expected a trace, got ${pf.traceCount}`);
  const t0 = pf.traces[0];
  // floor(rem*2/5) on this ~120-byte file is a few dozen samples at most — assert
  // it is nowhere near the forged sptStored (~400000).
  assert.ok(t0.nSamples < 1000, `20-bit ns not clamped to remaining bytes: ${t0.nSamples}`);
  if (t0.samples) assert.equal(t0.samples.length, t0.nSamples, 'samples length matches clamped ns');
});

// The fix must NOT alter valid parsing: the real Geode sample still decodes to
// its true, unchanged per-trace sample counts (data block == nSamples*bps, so the
// new clamp is a no-op).
if (existsSync(GEODE)) {
  test('valid Geode .dat still parses to its true, unchanged sample counts (clamp is a no-op)', () => {
    const pf = parseSEG2(readBytes(GEODE));
    assert.equal(pf.errors.length, 0, `errors: ${pf.errors.join('; ')}`);
    assert.ok(pf.traceCount > 0, 'expected > 0 traces');
    for (const tr of pf.traces) {
      if (tr.samples) {
        assert.equal(tr.samples.length, tr.nSamples, 'decoded length matches header nSamples');
        // A real Geode trace carries hundreds–thousands of samples; the clamp must
        // NOT have truncated it to the data-block-undershoot seen in the attack.
        assert.ok(tr.nSamples > 2, `valid trace truncated by the clamp: nSamples=${tr.nSamples}`);
      }
    }
    console.log(`      golden: Geode traceCount=${pf.traceCount} samplesPerTrace=${pf.traces[0].nSamples}`);
  });
} else {
  skip('valid Geode clamp-is-a-no-op check', `${GEODE} not found`);
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('\n----------------------');
console.log(`passed: ${passed}   failed: ${failed}   skipped: ${skipped}\n`);
process.exitCode = failed > 0 ? 1 : 0;
