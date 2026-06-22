// seisconv-core — public API barrel
//
// Pure, framework-free seismic conversion + processing library. Safe to import
// from Electron (Node main/worker), a browser, or plain Node. No DOM / Electron /
// React dependencies.

import type { Bytes, ParsedFile } from './types';
import { parseWithRegistry } from './formats/registry';
import { detect } from './detect';
import { parseTpimage } from './formats/tapeimage';

export * from './types';
export * from './binary';
export * from './base64';
export { detect } from './detect';
export { parseSEGY, writeSEGY, WRITER_TAG } from './formats/segy';
export { parseSEGD, writeSEGD } from './formats/segd';
export { parseSEG2, writeSEG2 } from './formats/seg2';
export { parseSU, writeSU } from './formats/su';
export * from './formats/ascii';
export * from './coords';
export * from './formats/registry';
export * from './formats/tapeimage';
export * from './dsp/interpolate';
export * from './dsp/agc';
export * from './dsp/fft';
export * from './dsp/correlate';
export * from './dsp/semblance';
export * from './dsp/avgspectrum';
export * from './dsp/spectrogram';
export * from './dsp/fk';
export * from './render/colormaps';
export * from './render/model';
export * from './sps/parse';
export * from './sps/qc';
export * from './sps/reproject';
export * from './export/xlsx';
export * from './export/ods';

/**
 * Detect and parse any supported seismic file. Dispatches through the format
 * registry, so supported formats grow by registering a module (see
 * `formats/registry.ts`) — no change here.
 */
export function parseAny(b: Bytes, name?: string): ParsedFile {
  if (detect(b, name) === 'TPIMAGE') {
    const extracted = parseTpimage(b);
    if (!extracted.length) {
      return { format: 'TPIMAGE', revision: 0, bh: {}, traces: [], traceCount: 0, errors: ['No seismic files found in tape image'] };
    }
    const first = parseAny(extracted[0].bytes, extracted[0].name);
    return { ...first, format: 'TPIMAGE→' + first.format };
  }
  return parseWithRegistry(b, name);
}
