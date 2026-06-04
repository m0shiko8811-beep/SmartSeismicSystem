// seisconv-core — SEG-D parser (Rev 1 / 3, demultiplexed)
//
// Ported verbatim from the SeisConv reference. Handles IEEE float (code 0032,
// 32-bit), 24-bit int (0068), and 20-bit packed (2.5 bytes/sample) data.
// NOTE: not covered by the bundled sample data — validate against real SEG-D
// before relying on it.

import { bcd2, r32u, rIEEE } from '../binary';
import type { Bytes, ParsedFile, Trace } from '../types';

export function parseSEGD(b: Bytes): ParsedFile {
  const r: ParsedFile = { format: 'SEG-D', revision: 1, gh1: {}, bh: {}, traces: [], traceCount: 0, errors: [] };
  if (b.length < 64) {
    r.errors.push('File too small');
    return r;
  }
  const fmtCode = bcd2(b[2]) * 100 + bcd2(b[3]);
  const addlBlocks = (b[10] >> 4) & 0xf;
  const numChanSets = (b[22] >> 4) & 0xf;
  const extHdrLen = (b[23] >> 4) & 0xf;
  const extlHdrLen = b[23] & 0xf;
  r.gh1 = {
    fileNum: bcd2(b[0]) * 100 + bcd2(b[1]),
    fmtCode,
    year: 2000 + bcd2(b[9]),
    julDay: ((b[10] & 0xf) << 8) | b[11],
    numChanSets,
    extHdrLen,
    extlHdrLen,
  };
  // Base scan interval from GH1 byte 21 high nibble (SEG-D Rev 1 code).
  const bsiCode = (b[21] >> 4) & 0xf;
  const bsiTable: Record<number, number> = { 1: 4000, 2: 2000, 3: 1000, 4: 500, 5: 250, 6: 125, 7: 62, 8: 31, 9: 16, 10: 8 };
  const si_us = bsiTable[bsiCode] || 2000;
  r.bh = { sampleInt: si_us }; // for SEG-Y-style viewers

  // Bytes per scan in GH1 bytes 18-20 (BCD). For IEEE float (0032): spt = bps/4.
  const bpsStored = bcd2(b[18]) * 10000 + bcd2(b[19]) * 100 + bcd2(b[20]);
  let bpsBits = 20;
  if (fmtCode === 32 || fmtCode === 8032) bpsBits = 32;
  else if (fmtCode === 8068 || fmtCode === 68) bpsBits = 24;
  const bytesPerSamp = bpsBits === 32 ? 4 : bpsBits === 24 ? 3 : 2.5;
  const sptStored = bpsStored > 0 && bytesPerSamp > 0 ? Math.round(bpsStored / bytesPerSamp) : 0;

  let off = 32;
  if (addlBlocks >= 1 && off + 32 <= b.length) {
    if (b[off + 31] === 0xff) r.revision = 3;
    off += 32 + Math.max(0, addlBlocks - 1) * 32;
  }
  let seisCC = 0;
  for (let cs = 0; cs < (numChanSets || 1) && off + 32 <= b.length; cs++) {
    const csd = b.slice(off, off + 32);
    if (((csd[10] >> 4) & 0xf) === 1) seisCC += ((csd[8] & 0xf) << 8) | csd[9];
    off += 32;
  }
  if (seisCC === 0) seisCC = 1;
  off += extHdrLen * 32 + extlHdrLen * 32;

  let tc = 0;
  while (off + 20 < b.length && tc < 500000) {
    const trcNum = r32u(b, off + 4);
    off += 20;
    const rem = b.length - off;
    if (rem <= 0) break;
    let samples: Float32Array | null = null;
    let ns = 0;
    if (bpsBits === 32) {
      ns = sptStored > 0 ? sptStored : Math.min(Math.floor(rem / (4 * Math.max(seisCC, 1))), 100000);
      if (sptStored > 0) ns = Math.min(ns, Math.floor(rem / 4));
      if (ns <= 0) break;
      if (tc < 2000) {
        samples = new Float32Array(ns);
        for (let i = 0; i < ns; i++) samples[i] = rIEEE(b, off + i * 4);
      }
      off += ns * 4;
    } else if (bpsBits === 24) {
      ns = sptStored > 0 ? sptStored : Math.min(Math.floor(rem / (3 * Math.max(seisCC, 1))), 100000);
      if (sptStored > 0) ns = Math.min(ns, Math.floor(rem / 3));
      if (ns <= 0) break;
      if (tc < 2000) {
        samples = new Float32Array(ns);
        for (let i = 0; i < ns; i++) {
          let v = (b[off + i * 3] << 16) | (b[off + i * 3 + 1] << 8) | b[off + i * 3 + 2];
          if (v & 0x800000) v -= 0x1000000;
          samples[i] = v;
        }
      }
      off += ns * 3;
    } else {
      ns = sptStored > 0 ? sptStored : Math.min(Math.floor((rem * 2) / (5 * Math.max(seisCC, 1))), 100000);
      const nb = Math.ceil((ns * 5) / 2);
      if (ns <= 0) break;
      if (tc < 2000) {
        samples = new Float32Array(ns);
        for (let i = 0; i < Math.floor(ns / 2); i++) {
          const p = off + i * 5;
          if (p + 5 > b.length) break;
          let s1 = (b[p] << 12) | (b[p + 1] << 4) | ((b[p + 2] >> 4) & 0xf);
          let s2 = ((b[p + 2] & 0xf) << 16) | (b[p + 3] << 8) | b[p + 4];
          samples[i * 2] = s1 & 0x80000 ? s1 - 0x100000 : s1;
          samples[i * 2 + 1] = s2 & 0x80000 ? s2 - 0x100000 : s2;
        }
      }
      off += nb;
    }
    const trace: Trace = { hdr: { trcNum }, samples, nSamples: ns, dataFmt: bpsBits };
    r.traces.push(trace);
    tc++;
  }
  r.traceCount = tc;
  return r;
}
