// seisconv-core — SU (Seismic Unix) parser + writer
//
// Headerless SEG-Y: 240-byte trace headers, big-endian IEEE float32 samples,
// traces start at byte 0. Ported verbatim from the SeisConv reference.

import { dv, getF32, r16u, r32s, w16, w32 } from '../binary';
import type { Bytes, ParsedFile, Trace, TraceHeader } from '../types';
import { MAX_SAMPLE_TRACES } from '../types';

export function parseSU(b: Bytes): ParsedFile {
  const r: ParsedFile = { format: 'SU', revision: 0, textHeader: '', bh: {}, traces: [], traceCount: 0, errors: [] };
  if (b.length < 240) {
    r.errors.push('File too small for SU');
    return r;
  }
  // nSamples + sampleInterval come from the first trace header.
  const nSamp = r16u(b, 114);
  const si = r16u(b, 116);
  const fmt = 1; // SU uses 4-byte IEEE float
  const bps = 4;
  const tSize = 240 + nSamp * bps;
  if (tSize <= 240) {
    r.errors.push('Invalid SU trace size');
    return r;
  }
  r.bh = { sampleInt: si, samplesTrace: nSamp, dataFmt: fmt };
  const nTraces = Math.floor(b.length / tSize);
  for (let i = 0; i < nTraces; i++) {
    const off = i * tSize;
    const hdr: TraceHeader = {
      traceSeq: r32s(b, off), lineSeq: r32s(b, off + 4), ffid: r32s(b, off + 8),
      traceNum: r32s(b, off + 12), sp: r32s(b, off + 16), cdp: r32s(b, off + 20),
      cdpTrace: r32s(b, off + 24), traceId: r16u(b, off + 28), offset: r32s(b, off + 36),
      nSamples: r16u(b, off + 114), sampInt: r16u(b, off + 116),
    };
    let samples: Float32Array | null = null;
    if (i < MAX_SAMPLE_TRACES) {
      samples = new Float32Array(nSamp);
      for (let j = 0; j < nSamp; j++) samples[j] = getF32(b, off + 240 + j * 4);
    }
    const trace: Trace = { hdr, samples, nSamples: nSamp };
    r.traces.push(trace);
  }
  r.traceCount = nTraces;
  return r;
}

export function writeSU(pd: ParsedFile): Bytes {
  const trc = pd.traces;
  if (!trc || !trc.length) throw new Error('No traces');
  // Fixed-record output: size every slot from the LONGEST trace, not the first,
  // so a short first trace can't under-allocate `out` and overrun on a later,
  // longer trace ('Offset is outside the bounds of the DataView').
  const spt = trc.reduce((m, t) => Math.max(m, t.nSamples || 0), 0);
  const si = pd.bh?.sampleInt || 2000;
  const tsz = 240 + spt * 4;
  const out = new Uint8Array(trc.length * tsz);
  // Pull a populated header word, accepting either the SU field name or the
  // equivalent SEG-Y trace-header name (so SU→SU and SEG-Y→SU both preserve the
  // geometry SU processing tools depend on). Returns 0 when neither is present.
  const hw = (h: TraceHeader, ...keys: string[]): number => {
    for (const k of keys) {
      const v = h[k];
      if (typeof v === 'number' && v !== 0) return v;
    }
    return 0;
  };
  let off = 0;
  for (let t = 0; t < trc.length; t++) {
    const tr = trc[t];
    const h = tr.hdr || {};
    w32(out, off, t + 1); // tracl (sequential)
    // Preserve trace geometry/identity at the CWP segy.h byte offsets instead of
    // zeroing it: fldr@8, ep@16 (shot/source point), cdp@20, cdpt@24, offset@36.
    if (hw(h, 'ffid', 'fieldRec')) w32(out, off + 8, hw(h, 'ffid', 'fieldRec'));
    if (hw(h, 'sp', 'srcPt')) w32(out, off + 16, hw(h, 'sp', 'srcPt'));
    if (hw(h, 'cdp', 'ensemble')) w32(out, off + 20, hw(h, 'cdp', 'ensemble'));
    if (hw(h, 'cdpTrace', 'trcEns')) w32(out, off + 24, hw(h, 'cdpTrace', 'trcEns'));
    // trid (byte 28): carry through if present, else 1 = seismic data (segy.h).
    w16(out, off + 28, hw(h, 'traceId') || 1);
    if (hw(h, 'offset')) w32(out, off + 36, hw(h, 'offset'));
    w16(out, off + 114, tr.nSamples);
    w16(out, off + 116, si);
    if (tr.samples) {
      const sdv = dv(out);
      const base = off + 240;
      // Clamp to the allocated slot (spt) so the write stays in-bounds for all traces.
      const ns2 = Math.min(tr.nSamples, spt);
      for (let i = 0; i < ns2; i++) sdv.setFloat32(base + i * 4, tr.samples[i] || 0, false);
    }
    off += tsz;
  }
  return out;
}
