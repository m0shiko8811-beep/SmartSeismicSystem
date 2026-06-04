// seisconv-core — SU (Seismic Unix) parser + writer
//
// Headerless SEG-Y: 240-byte trace headers, big-endian IEEE float32 samples,
// traces start at byte 0. Ported verbatim from the SeisConv reference.

import { dv, r16u, r32s, w16, w32 } from '../binary';
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
  const bdv = dv(b);
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
      for (let j = 0; j < nSamp; j++) samples[j] = bdv.getFloat32(off + 240 + j * 4, false);
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
  const spt = trc[0].nSamples;
  const si = pd.bh?.sampleInt || 2000;
  const tsz = 240 + spt * 4;
  const out = new Uint8Array(trc.length * tsz);
  let off = 0;
  for (let t = 0; t < trc.length; t++) {
    const tr = trc[t];
    w32(out, off, t + 1);
    w16(out, off + 114, tr.nSamples);
    w16(out, off + 116, si);
    if (tr.samples) {
      const sdv = dv(out);
      const base = off + 240;
      for (let i = 0; i < tr.nSamples; i++) sdv.setFloat32(base + i * 4, tr.samples[i] || 0, false);
    }
    off += tsz;
  }
  return out;
}
