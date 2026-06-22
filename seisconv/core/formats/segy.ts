// seisconv-core — SEG-Y parser + writer (Rev 0/1/2)
//
// Ported verbatim from the SeisConv reference. Big-endian throughout.
// Data formats: 1=IBM float, 2=int32, 3=int16, 5=IEEE float32, 8=int8.

import { asciiPrintable, dv, ebcdic, getF32, getI16, getI32, ibm2f, r16s, r16u, r32s, w16, w32 } from '../binary';
import type { Bytes, ParsedFile, Trace, TraceHeader } from '../types';
import { MAX_SAMPLES_PER_TRACE, MAX_TRACES } from '../types';

/** Product tag stamped into written SEG-Y textual headers. Neutral; change here if rebranding. */
export const WRITER_TAG = 'SeisConv';

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
  const isE = b[0] === 0xc3 || b[0] === 0xc1 || b[0] === 0x40;
  r.textHeader = isE ? ebcdic(b.slice(0, 3200)) : asciiPrintable(b.slice(0, 3200));
  const bh = b.slice(3200, 3600);
  r.bh = {
    sampleInt: r16u(bh, 16),
    samplesTrace: r16u(bh, 20),
    dataFmt: r16u(bh, 24),
    revision: r16u(bh, 300),
    // Byte 3505-3506 is SIGNED in rev2: -1 (0xFFFF) means "a variable number of
    // extended textual headers, read until the End Text stanza", NOT 65535.
    extHdrCnt: r16s(bh, 304),
    lineNum: r32s(bh, 4),
    jobId: r32s(bh, 0),
  };
  // Byte 3501 = major revision, byte 3502 = minor (radix point between the two
  // bytes). Decode the major byte on its own so a nonzero minor — e.g. rev 2.1 =
  // 0x0201 — is NOT demoted to rev 0, and any future minor revision is honoured.
  const revWord = r.bh.revision || 0;
  const revMajor = (revWord >> 8) & 0xff;
  r.bh.revMinor = revWord & 0xff;
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
  let tc = 0;
  while (off < b.length - 240 && tc < MAX_TRACES) {
    if (off + 240 > b.length) break;
    // Read header fields directly from the main buffer — no slice/copy.
    const hdr: TraceHeader = {
      seqLine: r32s(b, off + 0), seqFile: r32s(b, off + 4), fieldRec: r32s(b, off + 8),
      trcField: r32s(b, off + 12), srcPt: r32s(b, off + 16), ensemble: r32s(b, off + 20),
      trcEns: r32s(b, off + 24), traceId: r16s(b, off + 28), dataUse: r16s(b, off + 34),
      offset: r32s(b, off + 36), rcvElev: r32s(b, off + 40), surfElev: r32s(b, off + 44),
      srcDepth: r32s(b, off + 48), elevScalar: r16s(b, off + 68), coordScalar: r16s(b, off + 70),
      srcX: r32s(b, off + 72), srcY: r32s(b, off + 76), rcvX: r32s(b, off + 80), rcvY: r32s(b, off + 84),
      coordUnit: r16s(b, off + 88), nSamples: r16u(b, off + 114), sampInt: r16u(b, off + 116),
      gainType: r16s(b, off + 118), gainConst: r16s(b, off + 120), lowCut: r16s(b, off + 146),
      highCut: r16s(b, off + 148), year: r16s(b, off + 156), day: r16s(b, off + 158),
      hour: r16s(b, off + 160), minute: r16s(b, off + 162), second: r16s(b, off + 164),
      muteStart: r16s(b, off + 110), muteEnd: r16s(b, off + 112), traceWeight: r16s(b, off + 168),
    };
    const ns = (hdr.nSamples as number) || spt;
    if (ns <= 0 || ns > MAX_SAMPLES_PER_TRACE) {
      off += 240 + Math.max(spt > 0 ? spt * bps : 0, 4);
      continue;
    }
    const dEnd = off + 240 + ns * bps;
    if (dEnd > b.length) break;
    const samples = new Float32Array(ns);
    if (decodable) {
      for (let i = 0; i < ns; i++) {
        const p = off + 240 + i * bps;
        if (fmt === 1) samples[i] = ibm2f(b, p);
        else if (fmt === 5) samples[i] = getF32(b, p);
        else if (fmt === 2) samples[i] = getI32(b, p);
        else if (fmt === 3) samples[i] = getI16(b, p);
        else samples[i] = b[p] > 127 ? b[p] - 256 : b[p]; // fmt === 8 (int8)
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
