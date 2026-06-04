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
  writeSEGY,
  writeSU,
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

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('\n----------------------');
console.log(`passed: ${passed}   failed: ${failed}   skipped: ${skipped}\n`);
process.exitCode = failed > 0 ? 1 : 0;
