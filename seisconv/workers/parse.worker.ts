// SeisConv — parse/convert worker.
//
// Runs the pure-TS core on a worker thread so multi-hundred-MB files never block
// the UI. Reads the file with Node fs (no browser size cap), parses/encodes via
// `core`, and returns either a lightweight summary or the converted bytes
// (transferred zero-ish-copy back to the main process).

import { parentPort } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parseAny, getWriter } from '../core';

interface ParseTask {
  type: 'parse';
  path: string;
}
interface ConvertTask {
  type: 'convert';
  path: string;
  format: 'segy1' | 'segy0' | 'su';
}
type Task = ParseTask | ConvertTask;

if (!parentPort) throw new Error('parse.worker must run as a worker thread');
const port = parentPort;

port.on('message', (task: Task) => {
  try {
    const bytes = new Uint8Array(readFileSync(task.path));
    const pf = parseAny(bytes, basename(task.path));

    if (task.type === 'parse') {
      port.postMessage({
        format: pf.format,
        revision: pf.revision,
        traceCount: pf.traceCount,
        samplesTrace: pf.bh.samplesTrace ?? pf.traces[0]?.nSamples ?? null,
        sampleInt: pf.bh.sampleInt ?? null,
        errors: pf.errors,
      });
      return;
    }

    if (task.type === 'convert') {
      const writer = getWriter(task.format);
      if (!writer) {
        port.postMessage({ ok: false, error: `unknown output format: ${task.format}` });
        return;
      }
      const out = writer.write(pf);
      const ext = writer.ext;
      const base = basename(task.path).replace(/\.[^.]+$/, '');
      // Copy out to a standalone ArrayBuffer and transfer it (no structured-clone copy).
      const ab = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
      port.postMessage({ ok: true, bytes: ab, suggestedName: `${base}.${ext}` }, [ab]);
      return;
    }

    port.postMessage({ ok: false, error: 'unknown task type' });
  } catch (e) {
    port.postMessage({ ok: false, error: (e as Error).message });
  }
});
