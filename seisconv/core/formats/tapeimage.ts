// seisconv-core — TPIMAGE (tape image) reader.
//
// Some acquisition systems (Inova/ION "Stand Alone Mode") store seismic data as
// a tape image: 4-byte big-endian block-length prefixes, ANSI/IBM label blocks
// (VOL1/HDR1/EOF1…), and the actual SEG-Y/SEG-2/SU data in between. This extracts
// the embedded files. Ported verbatim from the SeisConv reference.

import { E2A, ebcdic } from '../binary';
import { detect } from '../detect';
import { writeSEGY } from './segy';
import type { Bytes, ParsedFile } from '../types';

export interface TPFile {
  bytes: Bytes;
  name: string;
  fmt: string;
}

/** Extract the seismic files contained in a tape image. */
export function parseTpimage(b: Bytes): TPFile[] {
  const r32be = (o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  const files: TPFile[] = [];
  let pos = 0;
  let pendingName: string | null = null;
  // Bound the fan-out: a crafted tape image with thousands of tiny data blocks
  // would otherwise materialize an unbounded array of copied buffers (and run
  // detect() per block) before any result is shown. Cap both the embedded-file
  // count and the cumulative extracted bytes; stop extracting once either is hit.
  const MAX_FILES = 4096;
  const MAX_TOTAL_BYTES = 1024 * 1024 * 1024; // 1 GB of extracted data blocks
  let totalBytes = 0;

  while (pos + 4 <= b.length) {
    const blen = r32be(pos);
    if (blen === 0) {
      pos += 4; // tape mark
      continue;
    }
    if (pos + 4 + blen > b.length) break;
    const blockData = b.slice(pos + 4, pos + 4 + blen);
    pos += 4 + blen;

    // ANSI/IBM label blocks are exactly 80 bytes starting with a known tag.
    if (blen === 80) {
      const tag = String.fromCharCode(blockData[0], blockData[1], blockData[2], blockData[3]);
      if (['HDR1', 'HDR2', 'EOF1', 'EOF2', 'VOL1', 'EOV1'].includes(tag)) {
        if (tag === 'HDR1') {
          const raw = blockData.slice(4, 21);
          const ascii = Array.from(raw)
            .map((c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : ''))
            .join('')
            .trim();
          pendingName = ascii || ebcdic(raw).replace(/[^ -~]/g, '').trim() || 'file';
        }
        continue;
      }
      // EBCDIC VOL1 label (0xE5='V', 0xD6='O', 0xD3='L')
      if (blockData[0] === 0xe5 && blockData[1] === 0xd6 && blockData[2] === 0xd3) continue;
    }

    // Actual seismic data — identify by content (the name has no extension, so
    // detect() falls through to magic-byte sniffing rather than forcing SEG-2).
    const dname = pendingName || 'block';
    const fmt = detect(blockData, dname);
    if (fmt === 'TPIMAGE') continue; // skip nested
    pendingName = null;
    const ext = fmt === 'SEG-2' ? '.dat' : fmt === 'SEG-D' ? '.segd' : fmt === 'SU' ? '.su' : '.segy';
    files.push({ bytes: blockData, name: dname + ext, fmt });
    totalBytes += blockData.length;
    // Stop once we've extracted enough files / bytes — a representative set is
    // still returned; the rest of a pathological image is ignored, not slurped.
    if (files.length >= MAX_FILES || totalBytes >= MAX_TOTAL_BYTES) break;
  }
  return files;
}

// ───────────────────────── TPIMAGE writer ─────────────────────────
//
// Packs the parsed file into a single tape image: convert it to an inner seismic
// format (default SEG-Y Rev 1), then wrap it in the same block/record framing
// parseTpimage reads back — a 4-byte big-endian length prefix per block, tape
// marks (00 00 00 00) between groups, optional ANSI (ASCII) or IBM (EBCDIC)
// VOL1/HDR1/HDR2/EOF1/EOF2 label blocks, and a double tape mark for end-of-tape.
// Ported faithfully from the SeisConv reference writeTapeImage (~line 2564).
//
// CAVEAT: this is a single-file tape image (one embedded seismic file). The
// container framing is faithful to the reference, but real LTO/SCSI tape images
// vary in label conventions; the labels here are the reference's de-facto layout,
// not a strict ANSI X3.27 / IBM standard-label implementation.

/** ASCII → EBCDIC (CP037-ish) table, inverse of E2A. Unmapped → 0x40 (space). */
const A2E: Uint8Array = (() => {
  const t = new Uint8Array(256).fill(0x40);
  for (let i = 0; i < 256; i++) t[E2A[i]] = i;
  return t;
})();

/** Encode an ASCII string to EBCDIC bytes (non-mapped chars → 0x40 space). */
function toEBCDIC(str: string): Bytes {
  return new Uint8Array(Array.from(str).map((c) => A2E[c.charCodeAt(0)] || 0x40));
}

/** Build an 80-byte label block, ASCII or EBCDIC, padded/truncated to 80. */
function makeLbl80(str: string, asEbcdic: boolean): Bytes {
  const padded = str.slice(0, 80).padEnd(80, ' ');
  if (asEbcdic) return toEBCDIC(padded);
  const out = new Uint8Array(80);
  for (let i = 0; i < 80; i++) out[i] = padded.charCodeAt(i) & 0xff;
  return out;
}

/**
 * Write the parsed file as a tape image. The data is first converted to an inner
 * seismic format (`innerFmt`, default 'segy1' → SEG-Y Rev 1) and then wrapped in
 * the tape-image container. `label` picks the volume-label encoding: 'none' (raw
 * data blocks + tape marks only), 'ansi' (ASCII VOL1/HDR/EOF labels) or 'ibm'
 * (the same labels in EBCDIC). `volSerial` is the 6-char volume serial.
 */
export function writeTapeImage(
  pd: ParsedFile,
  opts?: { label?: 'none' | 'ansi' | 'ibm'; volSerial?: string; innerFmt?: string },
): Bytes {
  const labelMode = opts?.label ?? 'ansi';
  const innerFmt = opts?.innerFmt ?? 'segy1';
  const asEbcdic = labelMode === 'ibm';
  const vol = (opts?.volSerial || 'SEI001').toUpperCase().padEnd(6, ' ').slice(0, 6);

  // Convert the file to the inner format. Default is SEG-Y Rev 1; 'segy0' → Rev 0.
  const inner: Bytes = innerFmt === 'segy0' ? writeSEGY(pd, 0) : writeSEGY(pd, 1);
  const innerName = ((pd as ParsedFile & { _name?: string })._name || 'FILE0001').replace(/\.[^.]+$/, '');

  const MARK = new Uint8Array(4); // 4 zero bytes = tape mark
  const parts: Bytes[] = [];

  const block = (data: Bytes): void => {
    // [4-byte BE length][data]
    const hdr = new Uint8Array(4);
    new DataView(hdr.buffer).setUint32(0, data.length, false);
    parts.push(hdr, data);
  };
  const mark = (): void => {
    parts.push(new Uint8Array(MARK));
  };

  // VOL1 label
  if (labelMode !== 'none') {
    block(makeLbl80(`VOL1${vol} ${' '.repeat(26)}SEISCONV      ${' '.repeat(28)}1`, asEbcdic));
    mark();
  }

  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const jd = String(Math.floor((now.getTime() - new Date(now.getFullYear(), 0, 0).getTime()) / 86400000)).padStart(3, '0');
  const dateStr = ` ${yy}${jd}`;

  // Single embedded file (the converted input).
  const fname = (innerName || 'FILE0001').slice(0, 17).padEnd(17, ' ');
  const fseq = '0001';
  // Block length: 5-digit field max 99999; use 00000 (undefined) for larger files.
  const blkLen = inner.length <= 99999 ? String(inner.length).padStart(5, '0') : '00000';

  if (labelMode !== 'none') {
    // ANSI HDR1 (80 bytes): HDR1(4) + fileId(17) + volSerial(6) + fileSection(4) +
    //   fileSeq(4) + generation(4) + version(2) + createDate(6) + expireDate(6) +
    //   accessibility(1) + blockCount(6) + sysCode(13) + reserved(7)
    const hdr1 = `HDR1${fname}${vol}0001${fseq}000100${dateStr}${dateStr} 000000SEISCONV`;
    // ANSI HDR2 (80 bytes): HDR2(4) + recFmt(1) + blockLen(5) + recLen(5) + rest(65)
    const hdr2 = `HDR2U${blkLen}00000`;
    block(makeLbl80(hdr1, asEbcdic));
    block(makeLbl80(hdr2, asEbcdic));
    mark(); // tape mark after header group
  }

  // Data block — whole file as one block.
  block(inner);
  mark(); // tape mark after data

  if (labelMode !== 'none') {
    // EOF1/EOF2 same structure as HDR1/HDR2 but blockCount=000001.
    const eof1 = `EOF1${fname}${vol}0001${fseq}000100${dateStr}${dateStr} 000001SEISCONV`;
    const eof2 = `EOF2U${blkLen}00000`;
    block(makeLbl80(eof1, asEbcdic));
    block(makeLbl80(eof2, asEbcdic));
    mark(); // tape mark after EOF group
  }

  // Double tape mark = logical end of tape.
  mark();
  mark();

  // Concatenate.
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
