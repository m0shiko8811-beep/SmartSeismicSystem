// seisconv-core — SEG-D parser (Rev 1 / 3, demultiplexed)
//
// Ported verbatim from the SeisConv reference. Handles IEEE float (code 0032,
// 32-bit), 24-bit int (0068), and 20-bit packed (2.5 bytes/sample) data.
// NOTE: not covered by the bundled sample data — validate against real SEG-D
// before relying on it.

import { bcd2, dv, r32u, rIEEE, w32 } from '../binary';
import type { Bytes, ParsedFile, Trace } from '../types';
import { MAX_SAMPLES_PER_TRACE } from '../types';

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
      ns = sptStored > 0 ? sptStored : Math.min(Math.floor(rem / (4 * Math.max(seisCC, 1))), MAX_SAMPLES_PER_TRACE);
      if (sptStored > 0) ns = Math.min(ns, Math.floor(rem / 4));
      if (ns <= 0) break;
      if (tc < 2000) {
        samples = new Float32Array(ns);
        for (let i = 0; i < ns; i++) samples[i] = rIEEE(b, off + i * 4);
      }
      off += ns * 4;
    } else if (bpsBits === 24) {
      ns = sptStored > 0 ? sptStored : Math.min(Math.floor(rem / (3 * Math.max(seisCC, 1))), MAX_SAMPLES_PER_TRACE);
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
      ns = sptStored > 0 ? sptStored : Math.min(Math.floor((rem * 2) / (5 * Math.max(seisCC, 1))), MAX_SAMPLES_PER_TRACE);
      // SECURITY: when sptStored>0 it is attacker-controllable, so bound it by the
      // bytes actually remaining (2 samples per 5 packed bytes → floor(rem*2/5)),
      // mirroring the 32-bit and 24-bit branches above. Without this an inflated
      // bytes-per-scan field drives a multi-GB Float32Array on a tiny file.
      if (sptStored > 0) ns = Math.min(ns, Math.floor((rem * 2) / 5));
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

/**
 * Write traces as SEG-D (always IEEE float32, format code 0032). `rev3` selects
 * Rev 3 (adds a General Header Block 2 with the 0xFF end marker + one extended
 * header) versus Rev 1. Ported verbatim from the SeisConv reference writeSEGD.
 *
 * CAVEAT: this is a minimal, SeisConv-internal SEG-D layout — it round-trips
 * through `parseSEGD` above but is UNVALIDATED against vendor SEG-D readers
 * (Sercel/SEAL, ION, Geospace, etc.). The general/channel-set/extended headers
 * carry only the fields the bundled parser needs; many standard SEG-D fields are
 * left zero. Do not feed this to acquisition QC tooling without validating first.
 */
export function writeSEGD(pd: ParsedFile, rev3: boolean): Bytes {
  const trc = pd.traces;
  if (!trc || !trc.length) throw new Error('No traces');
  // Samples-per-trace drives the fixed record size. The reference sizes from the
  // first trace; keep that for numeric equivalence, but clamp per-trace writes to
  // `spt` (below) so a later, longer trace can't overrun the DataView.
  const spt = trc[0].nSamples;
  const trD = spt * 4; // 4 bytes/sample (IEEE float32, code 0032)
  const gh2 = rev3 ? 32 : 0; // General Header Block 2 (Rev 3 only)
  const nExt = rev3 ? 1 : 0; // one extended header (Rev 3 only)
  const off0 = 32 + gh2 + 32 + nExt * 32; // GH1 + [GH2] + channel-set + [ext]
  const out = new Uint8Array(off0 + trc.length * (20 + trD));

  // ── General Header Block 1 (32 bytes) ──
  out[0] = 0;
  out[1] = 1;
  out[2] = 0;
  out[3] = 0x32; // format code 0032 (BCD) = IEEE float32
  const yr = new Date().getFullYear() % 100;
  out[9] = (Math.floor(yr / 10) << 4) | (yr % 10); // year (BCD)
  const now = new Date();
  const jd = Math.floor((now.getTime() - new Date(now.getFullYear(), 0, 0).getTime()) / 86400000);
  // Byte 10: hi nibble = number of additional GH blocks (parser reads this to
  // decide whether a GH2 follows), lo nibble = Julian-day high bits.
  out[10] = ((rev3 ? 1 : 0) << 4) | ((jd >> 8) & 0xf);
  out[11] = jd & 0xff; // Julian day
  out[12] = (Math.floor(now.getHours() / 10) << 4) | (now.getHours() % 10); // hour (BCD)
  out[13] = (Math.floor(now.getMinutes() / 10) << 4) | (now.getMinutes() % 10); // minute (BCD)
  out[14] = (Math.floor(now.getSeconds() / 10) << 4) | (now.getSeconds() % 10); // second (BCD)
  // Bytes-per-scan in GH1 bytes 18-20 as BCD (= spt * 4 for IEEE float).
  const bpsVal = spt * 4;
  out[18] = ((Math.floor(bpsVal / 100000) % 10) << 4) | (Math.floor(bpsVal / 10000) % 10);
  out[19] = ((Math.floor(bpsVal / 1000) % 10) << 4) | (Math.floor(bpsVal / 100) % 10);
  out[20] = ((Math.floor(bpsVal / 10) % 10) << 4) | (bpsVal % 10);
  // numChanSets (hi nibble) = 1 (a single channel-set descriptor is written in
  // both revisions); addl GH blocks (lo nibble) = 1. The parser reads the GH2
  // presence from byte 10's hi nibble (set above), not from here.
  out[22] = 0x11;
  out[23] = rev3 ? 0x10 : 0; // extHdrLen (hi nibble) | extlHdrLen (lo nibble)

  let go = 32;
  if (rev3) {
    out[go + 31] = 0xff; // GH2 end marker → parser bumps revision to 3
    go += 32;
  }
  // ── Channel Set Descriptor (32 bytes) ──
  const cc = trc.length;
  out[go] = 0x11;
  out[go + 1] = 0x10;
  out[go + 8] = (cc >> 8) & 0xf;
  out[go + 9] = cc & 0xff; // channel count
  out[go + 10] = 0x10; // channel type 1 (seismic) in hi nibble
  go += 32;
  if (rev3) go += 32; // skip the extended header block

  // ── Demultiplexed trace records: 20-byte trace header + trD bytes data ──
  let to = go;
  for (let t = 0; t < trc.length; t++) {
    out[to] = 0;
    out[to + 1] = 1;
    out[to + 2] = 0x11;
    out[to + 3] = 0x10;
    w32(out, to + 4, t + 1); // trace number
    to += 20;
    if (trc[t].samples) {
      const sdv = dv(out);
      // Clamp to `spt` (the allocated slot) so a longer-than-first trace can't
      // run past the buffer end ('Offset is outside the bounds of the DataView').
      const ns2 = Math.min(trc[t].nSamples, spt);
      for (let i = 0; i < ns2; i++) sdv.setFloat32(to + i * 4, trc[t].samples![i] || 0, false);
    }
    to += trD;
  }
  return out;
}
