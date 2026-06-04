// SeisConv — stateful parse/convert/render worker.
//
// Long-lived: it parses a file ONCE, holds the ParsedFile in worker memory, and
// answers many requests (summary, a single trace, a decimated section, convert)
// without re-reading or re-parsing. Heavy work stays off the UI thread; sample
// buffers are returned as transferables (zero structured-clone copy).
//
// Protocol: every request has a numeric `id`; the reply echoes that `id`.

import { parentPort } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import JSZip from 'jszip';
import { applyAGC, computeSemblance, detectSPSType, EPSG_DB, getWriter, mergeSPSData, normFactorPercentile, parseAny, parseSPSText, projToLatLon, reprojectSPS, resampleLinear, runSPSQC, type AGCType, type ParsedFile, type QCParams, type SPSData, type SPSPoint } from '../core';

if (!parentPort) throw new Error('parse.worker must run as a worker thread');
const port = parentPort;

let current: ParsedFile | null = null;
let currentSPS: SPSData | null = null;
let currentSPSFiles: { name: string; text: string; type: 'S' | 'R' | 'X' | 'mixed' }[] = [];

interface Req {
  id: number;
  type: 'open' | 'trace' | 'section' | 'convert' | 'openSPS' | 'spsPoints' | 'spsQC' | 'spsReproject' | 'batchConvert' | 'semblance' | 'spsLatLon';
  path?: string;
  paths?: string[];
  qc?: QCParams;
  code?: string;
  velMin?: number;
  velMax?: number;
  velStep?: number;
  index?: number;
  format?: string;
  maxTraces?: number;
  maxSamples?: number;
  agc?: boolean;
  agcType?: AGCType;
  agcWindowMs?: number;
}

function summarize(pf: ParsedFile) {
  return {
    format: pf.format,
    revision: pf.revision,
    traceCount: pf.traceCount,
    samplesTrace: pf.bh.samplesTrace ?? pf.traces[0]?.nSamples ?? null,
    sampleInt: pf.bh.sampleInt ?? null,
    errors: pf.errors,
  };
}

/** Convert many files and bundle the results into a ZIP (async). */
async function doBatchConvert(req: Req): Promise<void> {
  const { id } = req;
  try {
    const writer = getWriter(req.format!);
    if (!writer) {
      port.postMessage({ id, ok: false, error: `unknown output format: ${req.format}` });
      return;
    }
    const zip = new JSZip();
    const results: { name: string; ok: boolean; traces?: number; error?: string }[] = [];
    for (const p of req.paths ?? []) {
      const name = basename(p);
      try {
        const pf = parseAny(new Uint8Array(readFileSync(p)), name);
        zip.file(`${name.replace(/\.[^.]+$/, '')}.${writer.ext}`, writer.write(pf));
        results.push({ name, ok: true, traces: pf.traceCount });
      } catch (e) {
        results.push({ name, ok: false, error: (e as Error).message });
      }
    }
    const zipBytes = (await zip.generateAsync({ type: 'arraybuffer' })) as ArrayBuffer;
    port.postMessage({ id, ok: true, zip: zipBytes, results }, [zipBytes]);
  } catch (e) {
    port.postMessage({ id, ok: false, error: (e as Error).message });
  }
}

port.on('message', (req: Req) => {
  const { id, type } = req;
  try {
    if (type === 'open') {
      const bytes = new Uint8Array(readFileSync(req.path!));
      current = parseAny(bytes, basename(req.path!));
      port.postMessage({ id, ok: true, summary: summarize(current) });
      return;
    }

    if (type === 'batchConvert') {
      void doBatchConvert(req);
      return;
    }

    if (type === 'openSPS') {
      let merged: SPSData | null = null;
      currentSPSFiles = [];
      for (const p of req.paths ?? []) {
        const text = readFileSync(p, 'utf8');
        const name = basename(p);
        currentSPSFiles.push({ name, text, type: detectSPSType(name, text) });
        const sps = parseSPSText(text);
        merged = merged ? mergeSPSData(merged, sps) : sps;
      }
      currentSPS = merged;
      port.postMessage({
        id,
        ok: true,
        summary: {
          sources: merged?.sources.length ?? 0,
          receivers: merged?.receivers.length ?? 0,
          xrefs: merged?.xrefs.length ?? 0,
          layout: merged?.layout ?? null,
          projection: merged?.projection ?? null,
          errors: merged?.errors ?? [],
        },
      });
      return;
    }

    if (type === 'spsPoints') {
      if (!currentSPS) {
        port.postMessage({ id, ok: false, error: 'no SPS loaded' });
        return;
      }
      const S = currentSPS.sources;
      const R = currentSPS.receivers;
      const srcE = new Float32Array(S.length);
      const srcN = new Float32Array(S.length);
      for (let i = 0; i < S.length; i++) {
        srcE[i] = S[i].easting;
        srcN[i] = S[i].northing;
      }
      const rcvE = new Float32Array(R.length);
      const rcvN = new Float32Array(R.length);
      for (let i = 0; i < R.length; i++) {
        rcvE[i] = R[i].easting;
        rcvN[i] = R[i].northing;
      }
      port.postMessage({ id, ok: true, srcE, srcN, rcvE, rcvN }, [srcE.buffer, srcN.buffer, rcvE.buffer, rcvN.buffer]);
      return;
    }

    if (type === 'spsQC') {
      if (!currentSPS) {
        port.postMessage({ id, ok: false, error: 'no SPS loaded' });
        return;
      }
      const results = runSPSQC(currentSPS, req.qc ?? {});
      port.postMessage({ id, ok: true, results: results.map((r) => ({ sev: r.sev, cat: r.cat, msg: r.msg })) });
      return;
    }

    if (type === 'spsReproject') {
      if (!currentSPS || !currentSPS.projection) {
        port.postMessage({ id, ok: false, error: 'no SPS / source projection' });
        return;
      }
      const tgt = EPSG_DB.find((c) => c.code === req.code);
      if (!tgt) {
        port.postMessage({ id, ok: false, error: `unknown CRS: ${req.code}` });
        return;
      }
      const tag = tgt.code.replace(':', '');
      const files = currentSPSFiles.map((f) => ({
        name: f.name.replace(/(\.[^.]+)?$/, `_${tag}$1`),
        text: reprojectSPS(f.text.split('\n'), tgt, f.type === 'X' ? 'X' : f.type === 'R' ? 'R' : 'S', currentSPS!.projection!),
      }));
      port.postMessage({ id, ok: true, files });
      return;
    }

    if (type === 'spsLatLon') {
      if (!currentSPS || !currentSPS.projection) {
        port.postMessage({ id, ok: false, error: 'no SPS / source projection' });
        return;
      }
      const proj = currentSPS.projection as unknown as Parameters<typeof projToLatLon>[2];
      const conv = (pts: SPSPoint[]) => {
        const lon = new Float32Array(pts.length);
        const lat = new Float32Array(pts.length);
        for (let i = 0; i < pts.length; i++) {
          if (isFinite(pts[i].easting) && isFinite(pts[i].northing)) {
            const ll = projToLatLon(pts[i].easting, pts[i].northing, proj, 0);
            lon[i] = ll.lon;
            lat[i] = ll.lat;
          } else {
            lon[i] = NaN;
            lat[i] = NaN;
          }
        }
        return { lon, lat };
      };
      const s = conv(currentSPS.sources);
      const r = conv(currentSPS.receivers);
      port.postMessage({ id, ok: true, srcLon: s.lon, srcLat: s.lat, rcvLon: r.lon, rcvLat: r.lat }, [s.lon.buffer, s.lat.buffer, r.lon.buffer, r.lat.buffer]);
      return;
    }

    if (!current) {
      port.postMessage({ id, ok: false, error: 'no file open' });
      return;
    }

    if (type === 'trace') {
      const i = Math.max(0, Math.min(current.traceCount - 1, (req.index ?? 0) | 0));
      const tr = current.traces[i];
      const samples = tr?.samples ? tr.samples.slice() : new Float32Array(0);
      port.postMessage(
        {
          id,
          ok: true,
          index: i,
          nSamples: tr?.nSamples ?? 0,
          sampleInt: current.bh.sampleInt ?? 0,
          hdr: tr?.hdr ?? {},
          samples,
        },
        [samples.buffer],
      );
      return;
    }

    if (type === 'section') {
      const maxTraces = req.maxTraces ?? 1500;
      const maxSamples = req.maxSamples ?? 1500;
      const si = current.bh.sampleInt ?? 2000;
      const tc = current.traceCount;
      const traceStep = Math.max(1, Math.ceil(tc / maxTraces));

      // First pass: collect decimated columns + a global normalization factor.
      const columns: Float32Array[] = [];
      let norm = 0;
      for (let t = 0; t < tc; t += traceStep) {
        const tr = current.traces[t];
        if (!tr?.samples) continue;
        let s = tr.samples;
        if (req.agc) s = applyAGC(s, req.agcWindowMs ?? 200, si, req.agcType ?? 'rms');
        const nf = normFactorPercentile(s, 0.95);
        if (nf > norm) norm = nf;
        // Time-preserving downsample (clean vertical axis for VD; good enough for wiggle).
        columns.push(s.length > maxSamples ? resampleLinear(s, maxSamples) : s);
      }
      if (norm <= 0) norm = 1;

      const numTraces = columns.length;
      const colLen = numTraces ? columns[0].length : 0;
      // Flatten into one transferable matrix (numTraces × colLen), row = trace.
      const data = new Float32Array(numTraces * colLen);
      for (let c = 0; c < numTraces; c++) {
        const col = columns[c];
        const base = c * colLen;
        const n = Math.min(colLen, col.length);
        for (let k = 0; k < n; k++) data[base + k] = col[k];
      }
      port.postMessage({ id, ok: true, numTraces, colLen, norm, sampleInt: si, traceStep, data }, [data.buffer]);
      return;
    }

    if (type === 'convert') {
      const writer = getWriter(req.format!);
      if (!writer) {
        port.postMessage({ id, ok: false, error: `unknown output format: ${req.format}` });
        return;
      }
      const out = writer.write(current);
      const ab = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
      port.postMessage({ id, ok: true, bytes: ab, ext: writer.ext }, [ab]);
      return;
    }

    if (type === 'semblance') {
      const gather = current.traces.filter((tr) => tr.samples).slice(0, 96);
      if (!gather.length) {
        port.postMessage({ id, ok: false, error: 'no traces with samples' });
        return;
      }
      const sr = computeSemblance(gather, current.bh.sampleInt ?? 2000, req.velMin ?? 1000, req.velMax ?? 5000, req.velStep ?? 50);
      port.postMessage({ id, ok: true, semb: sr.semb, vels: sr.vels, nT: sr.nT, dt: sr.dt, siUs: sr.siUs, offNote: sr.offNote }, [sr.semb.buffer as ArrayBuffer]);
      return;
    }

    port.postMessage({ id, ok: false, error: `unknown request type: ${type}` });
  } catch (e) {
    port.postMessage({ id, ok: false, error: (e as Error).message });
  }
});
