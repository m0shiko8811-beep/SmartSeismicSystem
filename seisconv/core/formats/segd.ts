// seisconv-core — SEG-D parser (Rev 1 / 3, demultiplexed)
//
// Handles 32-bit IEEE float (code 8058, plus the legacy SeisConv codes 0032/8032),
// 24-bit int (0068), and 20-bit packed (2.5 bytes/sample) data.
// NOTE: not covered by the bundled sample data — validate against real SEG-D
// before relying on it.

import { bcd2, dv, r32u, rIEEE, w32 } from '../binary';
import type { Bytes, ParsedFile, Trace } from '../types';
import { MAX_SAMPLES_PER_TRACE } from '../types';

// SEG-D Rev 1 base-scan-interval codes → microseconds. Codes 7/8 are the true
// fractional intervals (62.5 / 31.25 µs for 16/8 kHz); truncating them to 62/31
// biases the time axis (and thus NMO velocities / spectra) ~0.8% for fast data.
const BSI_TABLE: Record<number, number> = { 1: 4000, 2: 2000, 3: 1000, 4: 500, 5: 250, 6: 125, 7: 62.5, 8: 31.25, 9: 16, 10: 8 };

/** Inverse of BSI_TABLE: pick the BSI code whose interval is closest to `us`
 *  (defaults to 2000 µs / code 2 when absent). Used by writeSEGD so the written
 *  base-scan-interval round-trips through parseSEGD. */
function bsiCodeForInterval(us: number | undefined): number {
  const target = typeof us === 'number' && isFinite(us) && us > 0 ? us : 2000;
  let best = 2; // 2000 µs default
  let bestErr = Infinity;
  for (const k of Object.keys(BSI_TABLE)) {
    const code = Number(k);
    const err = Math.abs(BSI_TABLE[code] - target);
    if (err < bestErr) { bestErr = err; best = code; }
  }
  return best;
}

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
  const si_us = BSI_TABLE[bsiCode] || 2000;
  r.bh = { sampleInt: si_us }; // for SEG-Y-style viewers

  // Bytes per scan in GH1 bytes 18-20 (BCD). For IEEE float (0032): spt = bps/4.
  const bpsStored = bcd2(b[18]) * 10000 + bcd2(b[19]) * 100 + bcd2(b[20]);
  let bpsBits = 20;
  // 8058 = 32-bit IEEE float (the conformant SEG-D code, decoded as IEEE below).
  // 32/8032 are the legacy SeisConv-internal IEEE codes, kept for backward
  // compatibility with previously written files (all 4-byte IEEE float here).
  if (fmtCode === 8058 || fmtCode === 32 || fmtCode === 8032) bpsBits = 32;
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
      // Each demultiplexed trace record carries its OWN samples after its 20-byte
      // header, so the per-trace sample count is bounded by THIS record's bytes
      // (rem/4), not the whole file divided by the seismic-channel count — the old
      // /seisCC fallback read every trace at ~1/seisCC of its true length on a
      // multi-channel-set survey. When sptStored is set it is attacker-controllable,
      // so clamp it by both the on-disk bytes AND MAX_SAMPLES_PER_TRACE.
      ns = sptStored > 0 ? sptStored : Math.floor(rem / 4);
      ns = Math.min(ns, Math.floor(rem / 4), MAX_SAMPLES_PER_TRACE);
      if (ns <= 0) break;
      if (tc < 2000) {
        samples = new Float32Array(ns);
        for (let i = 0; i < ns; i++) samples[i] = rIEEE(b, off + i * 4);
      }
      off += ns * 4;
    } else if (bpsBits === 24) {
      // Same per-record bound as the 32-bit branch: rem/3 (3 bytes/sample), clamped
      // by MAX_SAMPLES_PER_TRACE when sptStored is attacker-controllable.
      ns = sptStored > 0 ? sptStored : Math.floor(rem / 3);
      ns = Math.min(ns, Math.floor(rem / 3), MAX_SAMPLES_PER_TRACE);
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
      // 20-bit packed (2 samples per 5 bytes). Per-record bound = rem*2/5; when
      // sptStored>0 it is attacker-controllable so clamp by both the on-disk bytes
      // AND MAX_SAMPLES_PER_TRACE (an inflated bytes-per-scan field would otherwise
      // drive a multi-GB Float32Array on a tiny file). No /seisCC: each record
      // carries its own samples (see the 32-bit branch).
      ns = sptStored > 0 ? sptStored : Math.floor((rem * 2) / 5);
      ns = Math.min(ns, Math.floor((rem * 2) / 5), MAX_SAMPLES_PER_TRACE);
      const nb = Math.ceil((ns * 5) / 2);
      if (ns <= 0) break;
      if (tc < 2000) {
        samples = new Float32Array(ns);
        // Decode full sample PAIRS, then the trailing single sample when ns is odd
        // (it occupies the first 2.5 bytes of the final 5-byte group). Without the
        // odd-tail decode the last sample of every odd-length 20-bit trace stays 0.
        const pairs = Math.floor(ns / 2);
        for (let i = 0; i < pairs; i++) {
          const p = off + i * 5;
          if (p + 5 > b.length) break;
          let s1 = (b[p] << 12) | (b[p + 1] << 4) | ((b[p + 2] >> 4) & 0xf);
          let s2 = ((b[p + 2] & 0xf) << 16) | (b[p + 3] << 8) | b[p + 4];
          samples[i * 2] = s1 & 0x80000 ? s1 - 0x100000 : s1;
          samples[i * 2 + 1] = s2 & 0x80000 ? s2 - 0x100000 : s2;
        }
        if (ns % 2 === 1) {
          const p = off + pairs * 5;
          if (p + 3 <= b.length) {
            let s1 = (b[p] << 12) | (b[p + 1] << 4) | ((b[p + 2] >> 4) & 0xf);
            samples[ns - 1] = s1 & 0x80000 ? s1 - 0x100000 : s1;
          }
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
  // Samples-per-trace drives the fixed record size. Size it from the LONGEST
  // trace (like the SEG-Y / SU writers) — sizing from trc[0] silently truncates
  // every trace longer than the first when the gather has variable lengths. The
  // per-trace write is still clamped to `spt` so a trace can never overrun the
  // DataView; shorter traces are zero-padded to the fixed slot.
  const spt = trc.reduce((m, t) => Math.max(m, t.nSamples || 0), 0);
  const trD = spt * 4; // 4 bytes/sample (IEEE float32, code 8058)
  const gh2 = rev3 ? 32 : 0; // General Header Block 2 (Rev 3 only)
  const nExt = rev3 ? 1 : 0; // one extended header (Rev 3 only)
  const off0 = 32 + gh2 + 32 + nExt * 32; // GH1 + [GH2] + channel-set + [ext]
  const out = new Uint8Array(off0 + trc.length * (20 + trD));

  // ── General Header Block 1 (32 bytes) ──
  out[0] = 0;
  out[1] = 1;
  // Data sample format code = 8058 (32-bit IEEE float, demultiplexed) — the real
  // SEG-D code for IEEE float. The prior code 0032 was non-standard (SEG-D has no
  // 0032), so a conformant reader (SegDSee / SeisUnix / Sercel) would reject it.
  // bcd2(0x80)=80, bcd2(0x58)=58 → 8058. The parser still accepts the legacy 0032
  // so previously-written files keep parsing.
  out[2] = 0x80;
  out[3] = 0x58; // format code 8058 (BCD) = 32-bit IEEE float (demux)
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
  // Base scan interval code in GH1 byte 21 (hi nibble) — the parser reads this to
  // recover the sample interval (bsiCode → bsiTable). Without it the written file
  // always reads back at the default 2000 µs, losing the true interval on every
  // non-2000 µs round-trip. Map the file's sampleInt (µs) to the nearest BSI code.
  out[21] = (bsiCodeForInterval(pd.bh?.sampleInt) << 4) & 0xf0;
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
