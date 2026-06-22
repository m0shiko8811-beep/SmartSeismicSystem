// seisconv-core — format detection
//
// Identifies the container format from filename extension + magic bytes.
// Ported verbatim from the SeisConv reference.

import { bcd2 } from './binary';
import type { Bytes, SeismicFormat } from './types';

/** Detect the seismic format of `b`, using `name` (filename) for the extension hint. */
export function detect(b: Bytes, name?: string): SeismicFormat {
  const ext = (name || '').toLowerCase().split('.').pop();

  if (ext === 'tpimage') {
    // Some acquisition systems (Inova/ION "Stand Alone Mode") save SEG-Y as
    // .tpimage — check magic bytes before committing to TPIMAGE.
    if ((b[0] === 0xc3 || b[0] === 0xc1 || b[0] === 0x40 || b[0] === 0x43) && b.length >= 3600) return 'SEG-Y';
    if ((b[0] === 0x3a && b[1] === 0x55) || (b[0] === 0x55 && b[1] === 0x3a)) return 'SEG-2';
    return 'TPIMAGE';
  }
  if (ext === 'su') return 'SU'; // Seismic Unix — headerless, no magic bytes
  if (ext === 'dat' || ext === 'seg2' || ext === 'bat') return 'SEG-2'; // .dat = Geode, .bat = legacy

  // Tpimage magic: first 4 bytes = BE block length 80, then "VOL1".
  if (b.length >= 88) {
    const bl = (b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3];
    if (bl === 80 && b[4] === 0x56 && b[5] === 0x4f && b[6] === 0x4c && b[7] === 0x31) return 'TPIMAGE';
  }
  if ((b[0] === 0x3a && b[1] === 0x55) || (b[0] === 0x55 && b[1] === 0x3a)) return 'SEG-2';
  if ((b[0] === 0xc3 || b[0] === 0xc1 || b[0] === 0x40 || b[0] === 0x43) && b.length >= 3600) return 'SEG-Y';

  const fc = bcd2(b[2]) * 100 + bcd2(b[3]);
  if ([8058, 8068, 8048, 8015, 32, 8032, 4, 8064].includes(fc)) return 'SEG-D';
  // A blob large enough to hold a SEG-Y text+binary header is still a plausible
  // (header-only-recognisable) SEG-Y; anything smaller matched no signature, so
  // report UNKNOWN rather than forcing it through parseSEGY (which would emit a
  // misleading '<3600 bytes' error instead of 'unsupported file').
  if (b.length >= 3600) return 'SEG-Y';
  return 'UNKNOWN';
}
