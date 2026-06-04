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

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('\n----------------------');
console.log(`passed: ${passed}   failed: ${failed}   skipped: ${skipped}\n`);
process.exitCode = failed > 0 ? 1 : 0;
