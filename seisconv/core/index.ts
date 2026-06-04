// seisconv-core — public API barrel
//
// Pure, framework-free seismic conversion + processing library. Safe to import
// from Electron (Node main/worker), a browser, or plain Node. No DOM / Electron /
// React dependencies.

import type { Bytes, ParsedFile } from './types';
import { parseWithRegistry } from './formats/registry';

export * from './types';
export * from './binary';
export * from './base64';
export { detect } from './detect';
export { parseSEGY, writeSEGY, WRITER_TAG } from './formats/segy';
export { parseSEGD } from './formats/segd';
export { parseSEG2 } from './formats/seg2';
export { parseSU, writeSU } from './formats/su';
export * from './coords';
export * from './formats/registry';
export * from './dsp/interpolate';

/**
 * Detect and parse any supported seismic file. Dispatches through the format
 * registry, so supported formats grow by registering a module (see
 * `formats/registry.ts`) — no change here.
 */
export function parseAny(b: Bytes, name?: string): ParsedFile {
  return parseWithRegistry(b, name);
}
