// seisconv-core — SEG-2 parser (incl. Geometrics Geode ".dat")
//
// Little-endian throughout. Handles both classic SEG-2 (null/line-terminated
// free-form headers) and Geode's length-prefixed free-form variant.
// Ported verbatim from the SeisConv reference.

import { dv } from '../binary';
import type { Bytes, ParsedFile, Trace, TraceHeader } from '../types';

const ri16 = (buf: Bytes, o: number): number => buf[o] | (buf[o + 1] << 8); // always LE
const ri32 = (buf: Bytes, o: number): number =>
  (buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16) | (buf[o + 3] << 24)) >>> 0;

/** Classic free-form text block → string (line-terminator → newline). */
function seg2FreeFormStr(b: Bytes, s: number, e: number, st: number, lt: number): string {
  let r = '';
  for (let i = s; i < e; i++) {
    const c = b[i];
    r += c === lt ? '\n' : c === 0 || c === st ? '' : c >= 32 && c < 127 ? String.fromCharCode(c) : '?';
  }
  return r.trim();
}

/** Length-prefixed free-form parser — Geode .dat.
 * Each entry: [uint16LE total_block_size][key value\x00] (size includes the 2-byte length field). */
function seg2LenPrefixObj(b: Bytes, start: number, end: number): TraceHeader {
  const p: TraceHeader = {};
  let i = start;
  while (i + 2 <= end) {
    const total = b[i] | (b[i + 1] << 8);
    if (total < 3 || i + total > end) break;
    let nul = i + 2;
    while (nul < i + total && b[nul] !== 0) nul++;
    const line = Array.from(b.slice(i + 2, nul))
      .map((c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : ' '))
      .join('')
      .trim();
    if (line) {
      const sp = line.indexOf(' ');
      if (sp > 0) p[line.slice(0, sp).trim()] = line.slice(sp + 1).trim();
      else p[line] = '';
    }
    i += total;
  }
  return p;
}

/** Null/line-terminated free-form parser — classic SEG-2. */
function seg2FreeFormObj(b: Bytes, start: number, end: number, st: number, lt: number): TraceHeader {
  const p: TraceHeader = {};
  let i = start;
  while (i < end) {
    if (b[i] === 0 || b[i] === st) {
      i++;
      continue;
    }
    let le = i;
    while (le < end && b[le] !== lt && b[le] !== 0 && b[le] !== st) le++;
    const line = Array.from(b.slice(i, le))
      .map((c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : ' '))
      .join('')
      .trim();
    if (line) {
      const sp = line.indexOf(' ');
      if (sp > 0) p[line.slice(0, sp).trim()] = line.slice(sp + 1).trim();
      else if (line) p[line] = '';
    }
    i = le + 1;
  }
  return p;
}

function num(v: number | string | undefined): number {
  if (v == null) return 0;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return isNaN(n) ? 0 : n;
}

export function parseSEG2(b: Bytes): ParsedFile {
  const r: ParsedFile = { format: 'SEG-2', revision: 1, fileHeader: {}, textHeader: '', bh: {}, traces: [], traceCount: 0, errors: [] };
  // Both 0x3A55 (standard LE) and 0x553A (Geode LE) are treated as little-endian.
  const valid = (b[0] === 0x3a && b[1] === 0x55) || (b[0] === 0x55 && b[1] === 0x3a);
  if (!valid) {
    r.errors.push('Invalid SEG-2 magic');
    return r;
  }

  const revision = ri16(b, 2);
  const nTraces = ri16(b, 6); // FDB bytes 6-7 = nTraces
  const stl = b[10]; // string terminator length
  const strTerm = stl > 0 ? b[11] : 0x00;
  const ltlOff = 11 + stl;
  const ltl = b[ltlOff] || 0; // line terminator length
  const lineTerm = ltl > 0 ? b[ltlOff + 1] : 0x0a; // default \n
  r.fileHeader = { revision, nTraces };
  r.revision = revision;

  // Trace pointer array starts at a FIXED byte 32 (Geode format).
  const ptrBase = 32;

  // FDB free-form (between term chars and trace ptrs) → textHeader.
  const ffFDBStart = ltlOff + (ltl > 0 ? ltl + 1 : 1);
  const ffFDBEnd = ptrBase;
  if (ffFDBStart < ffFDBEnd) r.textHeader = seg2FreeFormStr(b, ffFDBStart, ffFDBEnd, strTerm, lineTerm);

  // Per-trace free-form: length-prefix (Geode) vs classic, decided by a heuristic.
  function getTrHdr(trcOff: number, tdbSize: number): TraceHeader {
    const ffStart = trcOff + 32;
    const ffEnd = trcOff + tdbSize;
    if (ffEnd <= ffStart) return {};
    const b0 = b[ffStart];
    const b1 = b[ffStart + 1];
    const maybeLen = b0 | (b1 << 8);
    if (maybeLen >= 3 && maybeLen <= 512 && ffStart + maybeLen <= ffEnd) return seg2LenPrefixObj(b, ffStart, ffEnd);
    return seg2FreeFormObj(b, ffStart, ffEnd, strTerm, lineTerm);
  }

  for (let t = 0; t < nTraces && t < 500000; t++) {
    const trcOff = ri32(b, ptrBase + t * 4);
    if (trcOff === 0 || trcOff + 32 > b.length) break;
    const tdbID = ri16(b, trcOff);
    if (tdbID !== 0x4422 && tdbID !== 0x2244) {
      r.errors.push(`Trace ${t}: bad TDB ID 0x${tdbID.toString(16)}`);
      break;
    }
    const tdbSize = ri16(b, trcOff + 2);
    if (tdbSize < 32 || trcOff + tdbSize > b.length) break;
    const dataBlockSize = ri32(b, trcOff + 4);
    const nSamples = ri32(b, trcOff + 8);
    const trDataFmt = ri16(b, trcOff + 12); // per-trace data format (NOT from FDB)
    if (nSamples <= 0 || nSamples > 1000000) break;
    if (trcOff + tdbSize + dataBlockSize > b.length) break;

    const trHdr = getTrHdr(trcOff, tdbSize);
    const dataStart = trcOff + tdbSize;
    let samples: Float32Array | null = null;
    if (t < 2000) {
      samples = new Float32Array(nSamples);
      const bdv = dv(b);
      const bpsInt = trDataFmt === 1 ? 2 : trDataFmt === 2 ? 4 : trDataFmt === 5 ? 8 : 4;
      if (trDataFmt === 3) {
        // 20-bit packed (2 samples per 5 bytes)
        for (let i = 0; i < Math.floor(nSamples / 2); i++) {
          const p = dataStart + i * 5;
          if (p + 5 > b.length) break;
          let s1 = b[p] | (b[p + 1] << 8) | ((b[p + 2] & 0xf) << 16);
          let s2 = (b[p + 2] >> 4) | (b[p + 3] << 4) | (b[p + 4] << 12);
          samples[i * 2] = s1 & 0x80000 ? s1 - 0x100000 : s1;
          samples[i * 2 + 1] = s2 & 0x80000 ? s2 - 0x100000 : s2;
        }
      } else {
        for (let i = 0; i < nSamples; i++) {
          const p = dataStart + i * bpsInt;
          if (p + bpsInt > b.length) break;
          if (trDataFmt === 4) samples[i] = bdv.getFloat32(p, true);
          else if (trDataFmt === 1) {
            const v = b[p] | (b[p + 1] << 8);
            samples[i] = v > 32767 ? v - 65536 : v;
          } else if (trDataFmt === 2) {
            samples[i] = b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | ((b[p + 3] << 24) >> 0);
          } else if (trDataFmt === 5) samples[i] = bdv.getFloat64(p, true);
          else samples[i] = bdv.getFloat32(p, true);
        }
      }
    }
    const trace: Trace = { hdr: trHdr, samples, nSamples, dataFmt: trDataFmt };
    r.traces.push(trace);
  }
  r.traceCount = r.traces.length;

  // Populate r.bh from the first trace that has headers.
  const _ft = r.traces.find((tr) => tr.hdr && Object.keys(tr.hdr).length > 0) || r.traces[0];
  if (_ft) {
    let _si = 2000;
    const _siStr = _ft.hdr?.SAMPLE_INTERVAL;
    if (_siStr != null) {
      const _sv = typeof _siStr === 'number' ? _siStr : parseFloat(_siStr);
      if (!isNaN(_sv) && _sv > 0) {
        if (_sv < 0.1) _si = Math.round(_sv * 1e6); // seconds → µs
        else if (_sv <= 200) _si = Math.round(_sv * 1000); // ms → µs
        else _si = Math.round(_sv); // already µs
      }
    }
    r.bh = { sampleInt: _si, samplesTrace: _ft.nSamples || 0, numTraces: r.traceCount, dataFmt: _ft.dataFmt };
  }

  // Normalise common trace-header keys for downstream viewers.
  r.traces.forEach((tr, i) => {
    const h = tr.hdr;
    if (!h) return;
    if (h.CHANNEL_NUMBER) h.channelNum = parseInt(String(h.CHANNEL_NUMBER)) || i + 1;
    if (h.RECEIVER_LOCATION) h.rcvSP = num(h.RECEIVER_LOCATION);
    if (h.SOURCE_LOCATION) h.srcSP = num(h.SOURCE_LOCATION);
    if (h.SHOT_SEQUENCE_NUMBER) h.shotSeq = parseInt(String(h.SHOT_SEQUENCE_NUMBER)) || 0;
    if (h.DELAY || h.DELAY_TIME) h.delayMs = num(h.DELAY || h.DELAY_TIME);
    if (h.RECEIVER_LOCATION) h.ensemble = num(h.RECEIVER_LOCATION);
    if (h.SOURCE_LOCATION) h.srcPt = num(h.SOURCE_LOCATION);
  });

  return r;
}
