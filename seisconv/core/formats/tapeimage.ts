// seisconv-core — TPIMAGE (tape image) reader.
//
// Some acquisition systems (Inova/ION "Stand Alone Mode") store seismic data as
// a tape image: 4-byte big-endian block-length prefixes, ANSI/IBM label blocks
// (VOL1/HDR1/EOF1…), and the actual SEG-Y/SEG-2/SU data in between. This extracts
// the embedded files. Ported verbatim from the SeisConv reference.

import { ebcdic } from '../binary';
import { detect } from '../detect';
import type { Bytes } from '../types';

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
  }
  return files;
}
