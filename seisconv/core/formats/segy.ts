// seisconv-core — SEG-Y parser + writer (Rev 0/1/2)
//
// Ported verbatim from the SeisConv reference. Big-endian throughout.
// Data formats: 1=IBM float, 2=int32, 3=int16, 5=IEEE float32, 8=int8.

import { asciiPrintable, dv, ebcdic, ibm2f, r16s, r16u, r32s, w16, w32 } from '../binary';
import type { Bytes, ParsedFile, Trace, TraceHeader } from '../types';
import { MAX_TRACES } from '../types';

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
    extHdrCnt: r16u(bh, 304),
    lineNum: r32s(bh, 4),
    jobId: r32s(bh, 0),
  };
  r.revision = r.bh.revision === 0x0100 ? 1 : r.bh.revision === 0x0200 ? 2 : 0;

  let off = 3600;
  for (let i = 0; i < (r.bh.extHdrCnt || 0) && off + 3200 <= b.length; i++) off += 3200;

  const spt = r.bh.samplesTrace || 0;
  const fmt = r.bh.dataFmt || 1;
  const bps = fmt === 3 ? 2 : fmt === 8 ? 1 : 4;
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
    if (ns <= 0 || ns > 500000) {
      off += 240 + Math.max(spt > 0 ? spt * bps : 0, 4);
      continue;
    }
    const dEnd = off + 240 + ns * bps;
    if (dEnd > b.length) break;
    const samples = new Float32Array(ns);
    const bdv = dv(b);
    for (let i = 0; i < ns; i++) {
      const p = off + 240 + i * bps;
      if (fmt === 1) samples[i] = ibm2f(b, p);
      else if (fmt === 5) samples[i] = bdv.getFloat32(p, false);
      else if (fmt === 2) samples[i] = bdv.getInt32(p, false);
      else if (fmt === 3) samples[i] = bdv.getInt16(p, false);
      else if (fmt === 8) samples[i] = b[p] > 127 ? b[p] - 256 : b[p];
      else samples[i] = bdv.getFloat32(p, false);
    }
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
  const spt = Math.min(trc[0].nSamples, 65535); // max 65535 (16-bit SEG-Y field)
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
      const ns2 = Math.min(tr.nSamples, 65535);
      for (let i = 0; i < ns2; i++) odv.setFloat32(base + i * 4, tr.samples[i] || 0, false);
    }
    off += tsz;
  }
  return out;
}
