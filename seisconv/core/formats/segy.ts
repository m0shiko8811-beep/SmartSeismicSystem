// seisconv-core — SEG-Y parser + writer (Rev 0/1/2)
//
// Ported from the SeisConv reference. The READER auto-detects byte order per
// file (big- or little-endian) and threads a single `le` flag through every
// header/sample read; the WRITER always emits standard big-endian SEG-Y.
// Data formats: 1=IBM float, 2=int32, 3=int16, 5=IEEE float32, 8=int8.

import { asciiPrintable, dv, ebcdic, getF32, getI16, getI32, ibm2f, r16s, r16u, r32s, r32u, w16, w32 } from '../binary';
import type { Bytes, ParsedFile, Trace, TraceHeader } from '../types';
import { MAX_SAMPLES_PER_TRACE, MAX_TRACES } from '../types';

/** Product tag stamped into written SEG-Y textual headers. Neutral; change here if rebranding. */
export const WRITER_TAG = 'SeisConv';

/**
 * Detect SEG-Y byte order from the binary header (file bytes 3201-3600, abs
 * offset 3200). Returns true for little-endian, false for big-endian. Three
 * layers, most authoritative first, so rev0/rev1 files without the byte-order
 * constant still resolve via the format-code / sample-interval heuristics.
 */
function detectLittleEndian(b: Bytes): boolean {
  // PRIMARY — byte-order constant, file bytes 3297-3300 (binhdr offset 96, uint32).
  const o = 3296; // 3200 + 96
  const beVal = ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  if (beVal === 0x01020304) return false; // big-endian marker
  if (beVal === 0x04030201) return true; // little-endian marker (bytes swapped)
  // rev0/rev1 leave this zero → fall through to the heuristics.

  // FALLBACK — data sample format code, file bytes 3225-3226 (binhdr offset 24, uint16).
  const fo = 3224; // 3200 + 24
  const fmtBE = (b[fo] << 8) | b[fo + 1];
  const fmtLE = b[fo] | (b[fo + 1] << 8);
  const okFmt = (v: number): boolean => v >= 1 && (v <= 12 || v === 15 || v === 16); // SEGY_BPS keys
  if (okFmt(fmtLE) && !okFmt(fmtBE)) return true;
  if (okFmt(fmtBE) && !okFmt(fmtLE)) return false;
  // both valid or both invalid → tiebreak.

  // TIEBREAK — sample interval (µs), file bytes 3217-3218 (binhdr offset 16, uint16).
  const so = 3216; // 3200 + 16
  const siBE = (b[so] << 8) | b[so + 1];
  const siLE = b[so] | (b[so + 1] << 8);
  const plaus = (v: number): boolean => v >= 1 && v <= 100000;
  if (plaus(siLE) && !plaus(siBE)) return true;
  if (plaus(siBE) && !plaus(siLE)) return false;

  return false; // default big-endian
}

/** Read a header value as an integer (headers are numeric for SEG-Y). */
function hi(h: TraceHeader, k: string): number {
  const v = h[k];
  return typeof v === 'number' ? v : 0;
}

export function parseSEGY(b: Bytes): ParsedFile {
  const r: ParsedFile = { format: 'SEG-Y', revision: 0, textHeader: '', bh: {}, traces: [], traceCount: 0, errors: [] };
  if (b.length < 3600) {
    r.errors.push('File <3600 bytes');
    return r;
  }
  // Auto-detect byte order ONCE from the binary header, then thread `le` through
  // every header/sample read below. Reads the raw absolute buffer `b` (the
  // binary header lives at abs offset 3200) before the byte-order-dependent
  // header parse so the very first header value is interpreted correctly.
  const le = detectLittleEndian(b);
  const isE = b[0] === 0xc3 || b[0] === 0xc1 || b[0] === 0x40;
  r.textHeader = isE ? ebcdic(b.slice(0, 3200)) : asciiPrintable(b.slice(0, 3200));
  const bh = b.slice(3200, 3600);
  r.bh = {
    sampleInt: r16u(bh, 16, le),
    samplesTrace: r16u(bh, 20, le),
    dataFmt: r16u(bh, 24, le),
    revision: r16u(bh, 300, le),
    // Byte 3505-3506 is SIGNED in rev2: -1 (0xFFFF) means "a variable number of
    // extended textual headers, read until the End Text stanza", NOT 65535.
    extHdrCnt: r16s(bh, 304, le),
    // SEG-Y rev2 'Max number of additional 240-byte trace headers' (file bytes
    // 3507-3510, binhdr offset 306, uint32). Drives the per-trace stride below.
    maxAddTraceHdr: r32u(bh, 306, le),
    lineNum: r32s(bh, 4, le),
    jobId: r32s(bh, 0, le),
    // Diagnostic: detected byte order, for worker-summary / test asserts.
    littleEndian: le ? 1 : 0,
  };
  // Byte 3501 = major revision, byte 3502 = minor (radix point between the two
  // bytes). Decode the major byte on its own so a nonzero minor — e.g. rev 2.1 =
  // 0x0201 — is NOT demoted to rev 0, and any future minor revision is honoured.
  const revWord = r.bh.revision || 0;
  // r16u already applied the file's byte order, so the major byte (3501) lands in
  // the HIGH byte for big-endian but the LOW byte for little-endian. Decode major/
  // minor accordingly — else a little-endian rev-2 file mis-reads as rev 0 and the
  // rev-2 additional-trace-header stride below is skipped (traces mis-walk).
  const revMajor = le ? (revWord & 0xff) : ((revWord >> 8) & 0xff);
  r.bh.revMinor = le ? ((revWord >> 8) & 0xff) : (revWord & 0xff);
  r.revision = revMajor; // 0 → rev 0, 1 → rev 1, 2 → rev 2 (regardless of minor)

  let off = 3600;
  const extCnt = r.bh.extHdrCnt || 0;
  if (extCnt < 0) {
    // Variable count (rev2, -1): skip 3200-byte extended-header blocks until one
    // contains the End Text stanza '((SEG: EndText))' (case-insensitive), or we
    // run out of room. The stanza marks the last extended textual header.
    while (off + 3200 <= b.length) {
      const block = asciiPrintable(b.slice(off, off + 3200));
      off += 3200;
      if (/\(\(\s*SEG\s*:\s*EndText\s*\)\)/i.test(block)) break;
    }
  } else {
    for (let i = 0; i < extCnt && off + 3200 <= b.length; i++) off += 3200;
  }

  const spt = r.bh.samplesTrace || 0;
  const fmt = r.bh.dataFmt || 1;
  // Bytes-per-sample keyed by the SEG-Y data sample format code (byte 3225-3226).
  // This drives BOTH the decode switch below AND the trace-walk stride, so a
  // conformant rev2 file using an 8-/3-/1-byte format is stepped at the true
  // on-disk record size instead of being mis-walked as 4-byte IEEE.
  //   1=IBM f32(4) 2=int32(4) 3=int16(2) 4=fixed-gain(4) 5=IEEE f32(4)
  //   6=IEEE f64(8) 7=int24(3) 8=int8(1) 9=int64(8) 10=uint32(4) 11=uint16(2)
  //   12=uint64(8) 15=uint24(3) 16=uint8(1)
  const SEGY_BPS: Record<number, number> = { 1: 4, 2: 4, 3: 2, 4: 4, 5: 4, 6: 8, 7: 3, 8: 1, 9: 8, 10: 4, 11: 2, 12: 8, 15: 3, 16: 1 };
  // Codes this parser can actually decode to samples. Others (rev2 additions we
  // don't yet decode) are stepped at the correct width but flagged, not silently
  // reinterpreted as IEEE f32.
  const decodable = fmt === 1 || fmt === 2 || fmt === 3 || fmt === 5 || fmt === 8;
  const bps = SEGY_BPS[fmt] ?? 4;
  if (!SEGY_BPS[fmt]) r.errors.push(`Unknown SEG-Y data sample format code ${fmt}`);
  else if (!decodable) r.errors.push(`Unsupported SEG-Y data sample format code ${fmt} (samples not decoded)`);
  // SEG-Y rev2 may carry extra 240-byte trace headers that FOLLOW the primary
  // trace header and PRECEDE the samples. They widen the per-trace stride. Only
  // rev2; clamp to [0,100] so a garbage high word can't blow up the stride.
  const addHdrCount = r.revision >= 2 ? Math.max(0, Math.min(r.bh.maxAddTraceHdr ?? 0, 100)) : 0;
  const addHdrBytes = addHdrCount * 240;
  let tc = 0;
  while (off < b.length - 240 && tc < MAX_TRACES) {
    if (off + 240 > b.length) break;
    // Read header fields directly from the main buffer — no slice/copy.
    const hdr: TraceHeader = {
      seqLine: r32s(b, off + 0, le), seqFile: r32s(b, off + 4, le), fieldRec: r32s(b, off + 8, le),
      trcField: r32s(b, off + 12, le), srcPt: r32s(b, off + 16, le), ensemble: r32s(b, off + 20, le),
      trcEns: r32s(b, off + 24, le), traceId: r16s(b, off + 28, le), dataUse: r16s(b, off + 34, le),
      offset: r32s(b, off + 36, le), rcvElev: r32s(b, off + 40, le), surfElev: r32s(b, off + 44, le),
      srcDepth: r32s(b, off + 48, le), elevScalar: r16s(b, off + 68, le), coordScalar: r16s(b, off + 70, le),
      srcX: r32s(b, off + 72, le), srcY: r32s(b, off + 76, le), rcvX: r32s(b, off + 80, le), rcvY: r32s(b, off + 84, le),
      coordUnit: r16s(b, off + 88, le), nSamples: r16u(b, off + 114, le), sampInt: r16u(b, off + 116, le),
      gainType: r16s(b, off + 118, le), gainConst: r16s(b, off + 120, le), lowCut: r16s(b, off + 146, le),
      highCut: r16s(b, off + 148, le), year: r16s(b, off + 156, le), day: r16s(b, off + 158, le),
      hour: r16s(b, off + 160, le), minute: r16s(b, off + 162, le), second: r16s(b, off + 164, le),
      muteStart: r16s(b, off + 110, le), muteEnd: r16s(b, off + 112, le), traceWeight: r16s(b, off + 168, le),
    };
    const ns = (hdr.nSamples as number) || spt;
    if (ns <= 0 || ns > MAX_SAMPLES_PER_TRACE) {
      off += 240 + addHdrBytes + Math.max(spt > 0 ? spt * bps : 0, 4);
      continue;
    }
    const dEnd = off + 240 + addHdrBytes + ns * bps;
    if (dEnd > b.length) break;
    const samples = new Float32Array(ns);
    if (decodable) {
      for (let i = 0; i < ns; i++) {
        const p = off + 240 + addHdrBytes + i * bps;
        if (fmt === 1) samples[i] = ibm2f(b, p); // IBM hex float is byte-order-agnostic
        else if (fmt === 5) samples[i] = getF32(b, p, le);
        else if (fmt === 2) samples[i] = getI32(b, p, le);
        else if (fmt === 3) samples[i] = getI16(b, p, le);
        else samples[i] = b[p] > 127 ? b[p] - 256 : b[p]; // fmt === 8 (int8): single byte
      }
    }
    // Non-decodable codes: samples stay zero-filled but the trace IS still walked
    // at the correct `bps` stride so subsequent trace headers stay aligned.
    const trace: Trace = { hdr, samples, nSamples: ns, dataFmt: fmt };
    r.traces.push(trace);
    off = dEnd;
    tc++;
  }
  r.traceCount = tc;
  return r;
}

/**
 * Write traces as SEG-Y (always IEEE float32, data format 5). `rev` selects the
 * declared revision (0/1/2). Mirrors the reference writer.
 */
export function writeSEGY(pd: ParsedFile, rev: number): Bytes {
  const trc = pd.traces;
  if (!trc || !trc.length) throw new Error('No traces');
  // SEG-Y is a fixed-record format: every trace slot is the same size. Size it
  // from the LONGEST trace, not just the first — otherwise a short first trace
  // (e.g. an aux/timebreak) under-allocates `out` and the per-trace write below
  // runs past the buffer end ('Offset is outside the bounds of the DataView').
  const spt = Math.min(trc.reduce((m, t) => Math.max(m, t.nSamples || 0), 0), 65535); // max 65535 (16-bit SEG-Y field)
  const si = pd.bh?.sampleInt || 2000;
  const tsz = 240 + spt * 4;
  const out = new Uint8Array(3600 + trc.length * tsz);

  const lines = [
    `C 1 ${WRITER_TAG} SEG-Y Rev ${rev}`,
    `C 2 Traces: ${trc.length}  Samples: ${spt}`,
    `C 3 SI: ${si} us IEEE Float32`,
    `C 4 Input: ${pd.format} Rev ${pd.revision || 0}`,
    `C40 END TEXTUAL HEADER`,
  ];
  let txt = '';
  for (let i = 0; i < 40; i++) {
    const l = lines[i] || `C${String(i + 1).padStart(2, ' ')}`;
    txt += l.slice(0, 80).padEnd(80, ' ');
  }
  for (let i = 0; i < 3200; i++) out[i] = txt.charCodeAt(i) || 0x20;

  const bh = 3200;
  w16(out, bh + 16, si);
  w16(out, bh + 18, si);
  w16(out, bh + 20, spt);
  w16(out, bh + 22, spt);
  w16(out, bh + 24, 5);
  w16(out, bh + 300, rev === 1 ? 0x0100 : rev === 2 ? 0x0200 : 0);
  w16(out, bh + 302, 1);

  // ── Rev 2 extended / required binary-header fields ──
  // The legacy 16-bit sample-interval (3217) and samples-per-trace (3221) fields
  // overflow above 65535; rev2 carries authoritative copies in extended fields,
  // and a fixed-length flag (3503) that references them. Write them so a rev2
  // file is internally self-consistent for strict rev2 readers. The parser does
  // not read these, so round-tripping through parseSEGY is unaffected.
  if (rev === 2) {
    const bdv = dv(out);
    bdv.setFloat64(bh + 80, si, false); // 3281-3288: extended sample interval (IEEE double, µs)
    bdv.setUint32(bh + 88, spt, false); // 3289-3292: extended number of samples/trace (uint32)
    bdv.setUint32(bh + 96, 0x01020304, false); // 3297-3300: byte-order constant (big-endian)
    w16(out, bh + 316, 0); // 3517-3518: number of additional 240-byte trace headers = 0
  }

  let off = 3600;
  for (let t = 0; t < trc.length; t++) {
    const tr = trc[t];
    const h = tr.hdr || {};
    w32(out, off, t + 1);
    w32(out, off + 4, t + 1);
    w32(out, off + 8, hi(h, 'fieldRec') || t + 1);
    w32(out, off + 12, hi(h, 'trcField') || t + 1);
    w32(out, off + 20, hi(h, 'ensemble') || t + 1);
    w16(out, off + 28, hi(h, 'traceId') || 1);
    w16(out, off + 114, Math.min(tr.nSamples, 65535));
    w16(out, off + 116, si);
    if (hi(h, 'srcX')) w32(out, off + 72, hi(h, 'srcX'));
    if (hi(h, 'srcY')) w32(out, off + 76, hi(h, 'srcY'));
    if (hi(h, 'rcvX')) w32(out, off + 80, hi(h, 'rcvX'));
    if (hi(h, 'rcvY')) w32(out, off + 84, hi(h, 'rcvY'));
    if (tr.samples) {
      const odv = dv(out);
      const base = off + 240;
      // Clamp to the allocated slot (spt), never the raw per-trace nSamples — the
      // slot is sized for the longest trace, so this stays in-bounds for all.
      const ns2 = Math.min(tr.nSamples, spt);
      for (let i = 0; i < ns2; i++) odv.setFloat32(base + i * 4, tr.samples[i] || 0, false);
    }
    off += tsz;
  }
  return out;
}
