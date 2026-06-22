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
import { applyAGC, computeSemblance, detectSPSType, EPSG_DB, getWriter, groupByLine, mergeSPSData, normFactorPercentile, parseAny, parseSPSText, projToLatLon, reprojectSPS, resampleLinear, runSPSQC, type AGCType, type ParsedFile, type QCParams, type SPSData, type SPSPoint } from '../core';

if (!parentPort) throw new Error('parse.worker must run as a worker thread');
const port = parentPort;

let current: ParsedFile | null = null;
let currentSPS: SPSData | null = null;
let currentSPSFiles: { name: string; text: string; type: 'S' | 'R' | 'X' | 'mixed' }[] = [];

interface Req {
  id: number;
  type: 'open' | 'trace' | 'section' | 'convert' | 'convertPath' | 'reset' | 'openSPS' | 'spsGeometry' | 'spsXrefLines' | 'spsFold' | 'spsQC' | 'spsPointDetail' | 'spsReproject' | 'spsExport' | 'semblance';
  path?: string;
  paths?: string[];
  qc?: QCParams;
  code?: string;
  // spsExport: which artifact to produce + optional QC params for the QC report.
  kind?: 'kml' | 'geojson' | 'csv' | 'qcreport';
  qcParams?: QCParams;
  // spsPointDetail lookup key: pick the matching S/R point by line + point (+ idx).
  rtype?: 'S' | 'R';
  lineName?: string;
  point?: number;
  idx?: string;
  geo?: boolean;
  velMin?: number;
  velMax?: number;
  velStep?: number;
  index?: number;
  format?: string;
  maxTraces?: number;
  maxSamples?: number;
  // Optional visible sub-window for the section view (full-data indices). When
  // present, only this trace/sample range is decimated/returned, so zooming
  // re-fetches the visible region at full detail instead of magnifying pixels.
  traceStart?: number;
  traceEnd?: number;
  sampStart?: number;
  sampEnd?: number;
  agc?: boolean;
  agcType?: AGCType;
  agcWindowMs?: number;
  // spsFold: CMP bin dimensions (projected units, e.g. metres).
  binX?: number;
  binY?: number;
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

// ── SPS exports (CSV / GeoJSON / KML / QC-report) ──
//
// All of these read from the in-worker `currentSPS`. Geographic outputs reproject
// projected E/N to WGS84 lon/lat with the SAME projToLatLon spsGeometry uses; when
// the SPS header carries no projection they fall back to raw E/N (GeoJSON keeps the
// numbers + flags it; KML refuses, since it is geographic-only by spec).

type SPSExportProj = Parameters<typeof projToLatLon>[2];

/** Number → fixed string, blank for non-finite (keeps CSV cells / coords clean). */
function nz(v: unknown, dp = 6): string {
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return isFinite(n) ? n.toFixed(dp) : '';
}

/** Quote a CSV cell only when it contains a comma, quote, or newline (RFC-4180). */
function csvCell(v: unknown): string {
  if (v == null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function csvRow(cells: unknown[]): string {
  return cells.map(csvCell).join(',');
}

/** Escape the five XML metacharacters for KML text/attribute content. */
function xmlEsc(v: unknown): string {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** Project a point's E/N to lon/lat when `proj` is set; else echo raw E/N as lon/lat. */
function toLonLat(p: SPSPoint, proj: SPSExportProj | undefined): { lon: number; lat: number } {
  if (proj && isFinite(p.easting) && isFinite(p.northing)) {
    const ll = projToLatLon(p.easting, p.northing, proj, isFinite(p.elevation) ? p.elevation : 0);
    return { lon: ll.lon, lat: ll.lat };
  }
  return { lon: p.easting, lat: p.northing };
}

function buildSPSCsv(d: SPSData): { name: string; text: string }[] {
  const srcHdr = ['rtype', 'lineName', 'point', 'idx', 'easting', 'northing', 'elevation', 'srcType', 'upholeMs', 'date', 'time', 'ffid'];
  const rcvHdr = ['rtype', 'lineName', 'point', 'idx', 'easting', 'northing', 'elevation', 'staticMs'];
  const srcLines = [csvRow(srcHdr)];
  for (const s of d.sources) {
    srcLines.push(csvRow([s.rtype, s.lineName, s.point, s.idx, nz(s.easting, 3), nz(s.northing, 3), nz(s.elevation, 3), s.srcType ?? '', s.upholeMs ?? '', s.date ?? '', s.time ?? '', s.ffid ?? '']));
  }
  const rcvLines = [csvRow(rcvHdr)];
  for (const r of d.receivers) {
    rcvLines.push(csvRow([r.rtype, r.lineName, r.point, r.idx, nz(r.easting, 3), nz(r.northing, 3), nz(r.elevation, 3), r.staticMs ?? '']));
  }

  // X-refs: include the channel range only when present (SPS2.1 records carry it).
  const hasCh = d.xrefs.some((x) => x.fromCh != null || x.toCh != null);
  const xHdr = ['srcLine', 'srcPt', 'ffid', 'rcvLineFrom', 'rcvPtFrom', 'rcvPtTo', ...(hasCh ? ['fromCh', 'toCh'] : []), 'layout'];
  const xLines = [csvRow(xHdr)];
  for (const x of d.xrefs) {
    const row: unknown[] = [x.srcLine ?? '', x.srcPt ?? '', x.ffid ?? '', x.rcvLineFrom ?? '', x.rcvPtFrom ?? '', x.rcvPtTo ?? ''];
    if (hasCh) row.push(x.fromCh ?? '', x.toCh ?? '');
    row.push(x.layout ?? '');
    xLines.push(csvRow(row));
  }

  return [
    { name: 'sources.csv', text: srcLines.join('\n') + '\n' },
    { name: 'receivers.csv', text: rcvLines.join('\n') + '\n' },
    { name: 'xrefs.csv', text: xLines.join('\n') + '\n' },
  ];
}

function buildSPSGeoJSON(d: SPSData): { name: string; text: string }[] {
  const proj = (d.projection && d.projection.type ? d.projection : undefined) as unknown as SPSExportProj | undefined;
  const geographic = !!proj;
  const features: unknown[] = [];

  const pointFeature = (p: SPSPoint) => {
    const { lon, lat } = toLonLat(p, proj);
    if (!isFinite(lon) || !isFinite(lat)) return;
    const props: Record<string, unknown> = { rtype: p.rtype, lineName: p.lineName, point: p.point, idx: p.idx, easting: p.easting, northing: p.northing, elevation: p.elevation };
    if (p.rtype === 'S') { props.srcType = p.srcType; props.upholeMs = p.upholeMs; props.ffid = p.ffid; }
    else props.staticMs = p.staticMs;
    features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: props });
  };
  for (const s of d.sources) pointFeature(s);
  for (const r of d.receivers) pointFeature(r);

  // One LineString per survey line (sources then receivers), points ordered.
  const lineFeatures = (pts: SPSPoint[], rtype: 'S' | 'R') => {
    const groups = groupByLine(pts);
    for (const name of Object.keys(groups)) {
      const coords: number[][] = [];
      for (const p of groups[name]) {
        const { lon, lat } = toLonLat(p, proj);
        if (isFinite(lon) && isFinite(lat)) coords.push([lon, lat]);
      }
      if (coords.length >= 2) features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: { rtype, lineName: name, kind: 'surveyLine' } });
    }
  };
  lineFeatures(d.sources, 'S');
  lineFeatures(d.receivers, 'R');

  const fc: Record<string, unknown> = { type: 'FeatureCollection', features };
  if (geographic) fc.crs = { type: 'name', properties: { name: 'urn:ogc:def:crs:OGC:1.3:CRS84' } };
  else fc.crsNote = 'projected, not WGS84 — coordinates are raw easting/northing (no projection in SPS header)';
  return [{ name: 'survey.geojson', text: JSON.stringify(fc, null, 2) + '\n' }];
}

function buildSPSKml(d: SPSData): { ok: boolean; files: { name: string; text: string }[]; error?: string } {
  const proj = (d.projection && d.projection.type ? d.projection : undefined) as unknown as SPSExportProj | undefined;
  if (!proj) return { ok: false, files: [], error: 'KML export needs a projected CRS in the SPS header' };

  const placemark = (p: SPSPoint, styleId: string): string => {
    const { lon, lat } = toLonLat(p, proj);
    if (!isFinite(lon) || !isFinite(lat)) return '';
    const elev = isFinite(p.elevation) ? p.elevation : 0;
    const name = `${p.lineName}/${p.point}${p.idx ? '.' + p.idx : ''}`;
    return [
      '      <Placemark>',
      `        <name>${xmlEsc(name)}</name>`,
      `        <styleUrl>#${styleId}</styleUrl>`,
      `        <Point><coordinates>${lon},${lat},${elev}</coordinates></Point>`,
      '      </Placemark>',
    ].join('\n');
  };

  const srcMarks = d.sources.map((p) => placemark(p, 'srcStyle')).filter(Boolean).join('\n');
  const rcvMarks = d.receivers.map((p) => placemark(p, 'rcvStyle')).filter(Boolean).join('\n');

  const kml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<kml xmlns="http://www.opengis.net/kml/2.2">',
    '  <Document>',
    '    <name>SeisConv survey</name>',
    '    <Style id="srcStyle"><IconStyle><color>ff0000ff</color><scale>0.8</scale>',
    '      <Icon><href>http://maps.google.com/mapfiles/kml/shapes/star.png</href></Icon></IconStyle></Style>',
    '    <Style id="rcvStyle"><IconStyle><color>ffff9900</color><scale>0.7</scale>',
    '      <Icon><href>http://maps.google.com/mapfiles/kml/shapes/placemark_circle.png</href></Icon></IconStyle></Style>',
    '    <Folder>',
    '      <name>Sources</name>',
    srcMarks,
    '    </Folder>',
    '    <Folder>',
    '      <name>Receivers</name>',
    rcvMarks,
    '    </Folder>',
    '  </Document>',
    '</kml>',
    '',
  ].join('\n');
  return { ok: true, files: [{ name: 'survey.kml', text: kml }] };
}

function buildSPSQCReport(d: SPSData, params: QCParams): { name: string; text: string }[] {
  const results = runSPSQC(d, params);
  let errors = 0, warns = 0, oks = 0;
  for (const r of results) { if (r.sev === 'error') errors++; else if (r.sev === 'warn') warns++; else oks++; }

  // A small comment-style header block (the data rows follow, machine-readable).
  const lines: string[] = [];
  lines.push('# SeisConv SPS QC report');
  lines.push(`# sources,${d.sources.length}`);
  lines.push(`# receivers,${d.receivers.length}`);
  lines.push(`# xrefs,${d.xrefs.length}`);
  lines.push(`# errors,${errors}`);
  lines.push(`# warnings,${warns}`);
  lines.push(`# ok,${oks}`);
  lines.push(csvRow(['severity', 'category', 'message', 'easting', 'northing']));
  for (const r of results) {
    const pt = r.pts && r.pts.length ? r.pts[0] : undefined;
    lines.push(csvRow([r.sev, r.cat, r.msg, pt ? nz(pt.easting, 3) : '', pt ? nz(pt.northing, 3) : '']));
  }
  return [{ name: 'sps_qc_report.csv', text: lines.join('\n') + '\n' }];
}

function buildSPSExport(d: SPSData, kind: 'kml' | 'geojson' | 'csv' | 'qcreport', qcParams: QCParams): { ok: boolean; files: { name: string; text: string }[]; error?: string } {
  if (kind === 'csv') return { ok: true, files: buildSPSCsv(d) };
  if (kind === 'geojson') return { ok: true, files: buildSPSGeoJSON(d) };
  if (kind === 'kml') return buildSPSKml(d);
  if (kind === 'qcreport') return { ok: true, files: buildSPSQCReport(d, qcParams) };
  return { ok: false, files: [], error: `unknown export kind: ${kind}` };
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

    if (type === 'reset') {
      current = null;
      currentSPS = null;
      currentSPSFiles = [];
      port.postMessage({ id, ok: true });
      return;
    }

    if (type === 'convertPath') {
      const writer = getWriter(req.format!);
      if (!writer) {
        port.postMessage({ id, ok: false, error: `unknown output format: ${req.format}` });
        return;
      }
      // Parse into a LOCAL variable — never overwrite the persistent `current`.
      const local = parseAny(new Uint8Array(readFileSync(req.path!)), basename(req.path!));
      const out = writer.write(local);
      const ab = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
      port.postMessage({ id, ok: true, bytes: ab, ext: writer.ext }, [ab]);
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

    if (type === 'spsGeometry') {
      if (!currentSPS) {
        port.postMessage({ id, ok: false, error: 'no SPS loaded' });
        return;
      }
      const proj = currentSPS.projection as unknown as Parameters<typeof projToLatLon>[2];
      const geo = !!req.geo && !!currentSPS.projection;
      const build = (pts: SPSPoint[]) => {
        const groups = groupByLine(pts);
        const names = Object.keys(groups);
        let total = 0;
        for (const n of names) total += groups[n].length;
        const x = new Float32Array(total);
        const y = new Float32Array(total);
        const line = new Int32Array(total);
        const pt = new Float32Array(total);
        let k = 0;
        names.forEach((n, li) => {
          for (const p of groups[n]) {
            let cx = p.easting;
            let cy = p.northing;
            if (geo && isFinite(cx) && isFinite(cy)) {
              const ll = projToLatLon(cx, cy, proj, 0);
              cx = ll.lon;
              cy = ll.lat;
            }
            x[k] = cx;
            y[k] = cy;
            line[k] = li;
            pt[k] = p.point;
            k++;
          }
        });
        return { x, y, line, pt, names };
      };
      const src = build(currentSPS.sources);
      const rcv = build(currentSPS.receivers);
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const g of [src, rcv]) {
        for (let i = 0; i < g.x.length; i++) {
          const a = g.x[i];
          const b = g.y[i];
          if (!isFinite(a) || !isFinite(b)) continue;
          if (a < minX) minX = a;
          if (a > maxX) maxX = a;
          if (b < minY) minY = b;
          if (b > maxY) maxY = b;
        }
      }
      const transfer = [src.x.buffer, src.y.buffer, src.line.buffer, src.pt.buffer, rcv.x.buffer, rcv.y.buffer, rcv.line.buffer, rcv.pt.buffer] as ArrayBuffer[];
      port.postMessage({ id, ok: true, geo, src, rcv, bbox: { minX, maxX, minY, maxY } }, transfer);
      return;
    }

    // X-ref "spider": one segment per (shot → live receiver) connection. Returns
    // parallel typed arrays of endpoint coords + a per-shot group id so the
    // renderer can emphasize a single clicked shot. Mirrors spsGeometry's geo
    // reprojection + transferable buffers.
    if (type === 'spsXrefLines') {
      if (!currentSPS) {
        port.postMessage({ id, ok: false, error: 'no SPS loaded' });
        return;
      }
      const proj = currentSPS.projection as unknown as Parameters<typeof projToLatLon>[2];
      const geo = !!req.geo && !!currentSPS.projection;
      const num = (v: unknown): number => (typeof v === 'number' ? v : parseFloat(String(v)));

      // Lookup maps: trimmed(line)|point → point. Sources keyed for shot resolve,
      // receivers keyed for range expansion.
      const srcMap = new Map<string, SPSPoint>();
      for (const s of currentSPS.sources) srcMap.set(`${(s.lineName || '').trim()}|${s.point}`, s);
      const rcvMap = new Map<string, SPSPoint>();
      for (const r of currentSPS.receivers) rcvMap.set(`${(r.lineName || '').trim()}|${r.point}`, r);

      // Cap total segments; if the survey would blow past it, decimate the xref
      // LIST (keep every Nth xref) so a representative spider still renders.
      const MAX_SEG = 50000;
      const xrefs = currentSPS.xrefs;
      // First count how many segments a full pass would emit, to pick a stride.
      let wouldEmit = 0;
      for (const x of xrefs) {
        const from = num(x.rcvPtFrom), to = num(x.rcvPtTo);
        if (!isFinite(from) || !isFinite(to)) continue;
        const incr = x.layout === 'SPS2.1' ? 1 : Math.max(1, num(x.rcvPtIncr) || 1);
        if (to >= from) wouldEmit += Math.floor((to - from) / incr) + 1;
      }
      const xrefStride = wouldEmit > MAX_SEG ? Math.ceil(wouldEmit / MAX_SEG) : 1;
      const decimated = xrefStride > 1;

      // Per-shot grouping: every distinct (srcLine|srcPt) becomes one group id so
      // the renderer can light up a clicked source's whole fan.
      const shotIndex = new Map<string, number>();
      const shotKeys: string[] = [];
      const sxA: number[] = [], syA: number[] = [], rxA: number[] = [], ryA: number[] = [], shotA: number[] = [];

      for (let xi = 0; xi < xrefs.length; xi++) {
        if (decimated && xi % xrefStride !== 0) continue;
        if (sxA.length >= MAX_SEG) break;
        const x = xrefs[xi];
        const srcKey = `${String(x.srcLine).trim()}|${num(x.srcPt)}`;
        const shot = srcMap.get(srcKey);
        if (!shot) continue;
        let sx = shot.easting, sy = shot.northing;
        if (!isFinite(sx) || !isFinite(sy)) continue;
        if (geo) { const ll = projToLatLon(sx, sy, proj, 0); sx = ll.lon; sy = ll.lat; }

        // Stable per-shot group id (first time we see this shot → new id).
        let gid = shotIndex.get(srcKey);
        if (gid === undefined) { gid = shotKeys.length; shotIndex.set(srcKey, gid); shotKeys.push(srcKey); }

        const rcvLine = String(x.rcvLineFrom).trim();
        const from = num(x.rcvPtFrom), to = num(x.rcvPtTo);
        if (!isFinite(from) || !isFinite(to) || to < from) continue;
        const incr = x.layout === 'SPS2.1' ? 1 : Math.max(1, num(x.rcvPtIncr) || 1);
        for (let rp = from; rp <= to; rp += incr) {
          if (sxA.length >= MAX_SEG) break;
          const rcv = rcvMap.get(`${rcvLine}|${rp}`);
          if (!rcv) continue;
          let rx = rcv.easting, ry = rcv.northing;
          if (!isFinite(rx) || !isFinite(ry)) continue;
          if (geo) { const ll = projToLatLon(rx, ry, proj, 0); rx = ll.lon; ry = ll.lat; }
          sxA.push(sx); syA.push(sy); rxA.push(rx); ryA.push(ry); shotA.push(gid);
        }
      }

      const sx = Float32Array.from(sxA);
      const sy = Float32Array.from(syA);
      const rx = Float32Array.from(rxA);
      const ry = Float32Array.from(ryA);
      const shot = Int32Array.from(shotA);
      const log = decimated
        ? `X-ref spider decimated: ~${wouldEmit} segments > ${MAX_SEG} cap; kept every ${xrefStride}${xrefStride === 2 ? 'nd' : xrefStride === 3 ? 'rd' : 'th'} xref → ${sx.length} segments.`
        : '';
      port.postMessage(
        { id, ok: true, geo, sx, sy, rx, ry, shot, shotKeys, decimated, log },
        [sx.buffer, sy.buffer, rx.buffer, ry.buffer, shot.buffer] as ArrayBuffer[],
      );
      return;
    }

    // FOLD / coverage bin map: count CMP midpoints ((shot+receiver)/2) per bin.
    // Reuses the EXACT xref-expansion logic from spsXrefLines (srcMap/rcvMap +
    // SPS2.1 incr-1 / legacy rcvPtIncr range walk), but instead of emitting a
    // segment per (shot, receiver) pair it accumulates the midpoint into a 2-D
    // bin grid. Always works in PROJECTED E/N (fold maps are a planning view).
    if (type === 'spsFold') {
      if (!currentSPS) {
        port.postMessage({ id, ok: false, error: 'no SPS loaded' });
        return;
      }
      const num = (v: unknown): number => (typeof v === 'number' ? v : parseFloat(String(v)));
      const binX = num(req.binX) > 0 ? num(req.binX) : 25;
      const binY = num(req.binY) > 0 ? num(req.binY) : 25;

      // Same lookup maps as spsXrefLines: trimmed(line)|point → SPSPoint.
      const srcMap = new Map<string, SPSPoint>();
      for (const s of currentSPS.sources) srcMap.set(`${(s.lineName || '').trim()}|${s.point}`, s);
      const rcvMap = new Map<string, SPSPoint>();
      for (const r of currentSPS.receivers) rcvMap.set(`${(r.lineName || '').trim()}|${r.point}`, r);

      const xrefs = currentSPS.xrefs;

      // Cap total CMP pairs. First count how many a full pass would emit, then
      // decimate the xref LIST by a stride (keep every Nth xref) if over.
      const MAX_PAIRS = 2_000_000;
      let wouldEmit = 0;
      for (const x of xrefs) {
        const from = num(x.rcvPtFrom), to = num(x.rcvPtTo);
        if (!isFinite(from) || !isFinite(to)) continue;
        const incr = x.layout === 'SPS2.1' ? 1 : Math.max(1, num(x.rcvPtIncr) || 1);
        if (to >= from) wouldEmit += Math.floor((to - from) / incr) + 1;
      }
      const xrefStride = wouldEmit > MAX_PAIRS ? Math.ceil(wouldEmit / MAX_PAIRS) : 1;
      const decimated = xrefStride > 1;

      // FIRST PASS: walk every (shot, receiver) pair, accumulate midpoints into a
      // flat buffer AND track the midpoint extent. We materialize midpoints once
      // (Float64) so the second binning pass is a cheap index loop.
      const mx: number[] = [];
      const my: number[] = [];
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (let xi = 0; xi < xrefs.length; xi++) {
        if (decimated && xi % xrefStride !== 0) continue;
        const x = xrefs[xi];
        const shot = srcMap.get(`${String(x.srcLine).trim()}|${num(x.srcPt)}`);
        if (!shot) continue;
        const sx = shot.easting, sy = shot.northing;
        if (!isFinite(sx) || !isFinite(sy)) continue;
        const rcvLine = String(x.rcvLineFrom).trim();
        const from = num(x.rcvPtFrom), to = num(x.rcvPtTo);
        if (!isFinite(from) || !isFinite(to) || to < from) continue;
        const incr = x.layout === 'SPS2.1' ? 1 : Math.max(1, num(x.rcvPtIncr) || 1);
        for (let rp = from; rp <= to; rp += incr) {
          const rcv = rcvMap.get(`${rcvLine}|${rp}`);
          if (!rcv) continue;
          const rx = rcv.easting, ry = rcv.northing;
          if (!isFinite(rx) || !isFinite(ry)) continue;
          const cx = (sx + rx) / 2, cy = (sy + ry) / 2;
          mx.push(cx); my.push(cy);
          if (cx < minX) minX = cx;
          if (cx > maxX) maxX = cx;
          if (cy < minY) minY = cy;
          if (cy > maxY) maxY = cy;
        }
      }

      const totalMid = mx.length;
      if (totalMid === 0 || !isFinite(minX)) {
        port.postMessage({ id, ok: false, error: 'no CMP midpoints (need matching S/R points referenced by X-refs)' });
        return;
      }

      // Grid dimensions, row-major (iy * nx + ix).
      const nx = Math.ceil((maxX - minX) / binX) + 1;
      const ny = Math.ceil((maxY - minY) / binY) + 1;

      // Guard: clamp total cells to a sane cap; ask for a bigger bin if exceeded.
      const MAX_CELLS = 4_000_000;
      if (nx * ny > MAX_CELLS) {
        const ext = `${Math.round(maxX - minX)} × ${Math.round(maxY - minY)} units`;
        port.postMessage({
          id, ok: false,
          error: `bin too small: ${nx} × ${ny} = ${nx * ny} cells exceeds the ${MAX_CELLS} cell cap for a ${ext} midpoint extent. Increase the bin size.`,
        });
        return;
      }

      // SECOND PASS: bin the midpoints.
      const fold = new Int32Array(nx * ny);
      let maxFold = 0;
      for (let i = 0; i < totalMid; i++) {
        let ix = Math.floor((mx[i] - minX) / binX);
        let iy = Math.floor((my[i] - minY) / binY);
        if (ix < 0) ix = 0; else if (ix >= nx) ix = nx - 1;
        if (iy < 0) iy = 0; else if (iy >= ny) iy = ny - 1;
        const v = ++fold[iy * nx + ix];
        if (v > maxFold) maxFold = v;
      }

      const log = decimated
        ? `Fold map decimated: ~${wouldEmit} CMP pairs > ${MAX_PAIRS} cap; kept every ${xrefStride}${xrefStride === 2 ? 'nd' : xrefStride === 3 ? 'rd' : 'th'} xref → ${totalMid} midpoints. Bin ${binX}×${binY}, grid ${nx}×${ny}, max fold ${maxFold}.`
        : `Fold map: ${totalMid} CMP midpoints, bin ${binX}×${binY}, grid ${nx}×${ny}, max fold ${maxFold}.`;

      port.postMessage(
        { id, ok: true, nx, ny, binX, binY, originX: minX, originY: minY, fold, maxFold, totalMid, decimated, log },
        [fold.buffer] as ArrayBuffer[],
      );
      return;
    }

    if (type === 'spsQC') {
      if (!currentSPS) {
        port.postMessage({ id, ok: false, error: 'no SPS loaded' });
        return;
      }
      const results = runSPSQC(currentSPS, req.qc ?? {});
      // Forward each finding's offending points as lightweight coords so the
      // renderer can locate + highlight them (the full SPSPoint stays here).
      port.postMessage({
        id,
        ok: true,
        results: results.map((r) => ({
          sev: r.sev,
          cat: r.cat,
          msg: r.msg,
          pts: (r.pts || []).map((p) => ({ rtype: p.rtype, lineName: p.lineName, point: p.point, easting: p.easting, northing: p.northing })),
        })),
      });
      return;
    }

    if (type === 'spsPointDetail') {
      if (!currentSPS) {
        port.postMessage({ id, ok: true, detail: null });
        return;
      }
      const rtype = req.rtype;
      const lineName = (req.lineName ?? '').trim();
      const point = req.point;
      const arr = rtype === 'S' ? currentSPS.sources : rtype === 'R' ? currentSPS.receivers : [];
      const match = arr.find(
        (p) => (p.lineName || '').trim() === lineName && p.point === point && (req.idx == null || (p.idx || '') === req.idx),
      );
      if (!match) {
        port.postMessage({ id, ok: true, detail: null });
        return;
      }
      // Return only the defined fields (source vs receiver carry different extras).
      const d: Record<string, unknown> = {
        rtype: match.rtype,
        lineName: match.lineName,
        point: match.point,
        idx: match.idx,
        easting: match.easting,
        northing: match.northing,
        elevation: match.elevation,
        raw: match.raw,
      };
      if (match.upholeMs !== undefined) d.upholeMs = match.upholeMs;
      if (match.srcType !== undefined) d.srcType = match.srcType;
      if (match.date !== undefined) d.date = match.date;
      if (match.time !== undefined) d.time = match.time;
      if (match.ffid !== undefined) d.ffid = match.ffid;
      if (match.staticMs !== undefined) d.staticMs = match.staticMs;
      port.postMessage({ id, ok: true, detail: d });
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

    // SPS geographic / tabular EXPORTS: turn the loaded survey into CSV / GeoJSON /
    // KML / a QC-report CSV. Single source of truth for coordinates is the SAME
    // projToLatLon used by spsGeometry — KML/GeoJSON go to WGS84 lon/lat when a
    // projected CRS is present in the SPS header, otherwise raw projected E/N.
    if (type === 'spsExport') {
      if (!currentSPS) {
        port.postMessage({ id, ok: false, error: 'no SPS loaded' });
        return;
      }
      const out = buildSPSExport(currentSPS, req.kind ?? 'csv', req.qcParams ?? {});
      port.postMessage({ id, ok: out.ok, files: out.files, error: out.error });
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
      // Full sample count (most files share a trace length; fall back to trace 0).
      const fullSamps = current.bh.samplesTrace ?? current.traces[0]?.nSamples ?? 0;

      // Visible sub-window in full-data indices. Defaults to the whole record so
      // the very first (un-zoomed) request behaves exactly as before. End indices
      // are exclusive; clamp + order them so a bad request can never throw.
      let t0 = Math.max(0, Math.min(tc, (req.traceStart ?? 0) | 0));
      let t1 = Math.max(0, Math.min(tc, (req.traceEnd ?? tc) | 0));
      if (t1 <= t0) { t0 = 0; t1 = tc; }
      let s0 = Math.max(0, Math.min(fullSamps, (req.sampStart ?? 0) | 0));
      let s1 = Math.max(0, Math.min(fullSamps, (req.sampEnd ?? fullSamps) | 0));
      if (s1 <= s0) { s0 = 0; s1 = fullSamps || 0; }
      const winTraces = t1 - t0;
      const winSamps = s1 - s0;
      const traceStep = Math.max(1, Math.ceil(winTraces / maxTraces));

      // First pass: collect decimated columns + a global normalization factor.
      // AGC is computed on the FULL trace (its window is time-based), then the
      // visible sample range is sliced out, then time-preserving downsampled.
      const columns: Float32Array[] = [];
      let norm = 0;
      for (let t = t0; t < t1; t += traceStep) {
        const tr = current.traces[t];
        if (!tr?.samples) continue;
        let s = tr.samples;
        if (req.agc) s = applyAGC(s, req.agcWindowMs ?? 200, si, req.agcType ?? 'rms');
        // Slice to the visible sample window (no-op when it's the whole trace).
        if (s0 > 0 || s1 < s.length) s = s.subarray(Math.min(s0, s.length), Math.min(s1, s.length));
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
      // Echo the window + full extents so the renderer can label axes and clamp.
      port.postMessage(
        { id, ok: true, numTraces, colLen, norm, sampleInt: si, traceStep, data, traceStart: t0, traceEnd: t1, sampStart: s0, sampEnd: s1, fullTraces: tc, fullSamples: fullSamps, winSamps },
        [data.buffer],
      );
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
