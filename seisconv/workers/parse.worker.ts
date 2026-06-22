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
import { applyAGC, averageSpectrum, buildPositioningExport, computeSemblance, crsFromSpec, detectPositioningFormat, detectSPSType, EPSG_DB, fkSpectrum, generateProjHeaders, getWriter, groupByLine, hRecCode, mergeSPSData, nextPow2, normFactorPercentile, parseAny, parsePositioning, parseSPSText, projToLatLon, PROJ_HEADER_CODES, reprojectSPS, resampleLinear, runSPSQC, spectrogram, spsHeaderDesc, type AGCType, type BinGrid, type CRSSpec, type ParsedFile, type QCParams, type SPSData, type SPSHeader, type SPSPoint } from '../core';

if (!parentPort) throw new Error('parse.worker must run as a worker thread');
const port = parentPort;

let current: ParsedFile | null = null;
let currentSPS: SPSData | null = null;
let currentSPSFiles: { name: string; text: string; type: 'S' | 'R' | 'X' | 'mixed' }[] = [];
// A P6/11 bin grid loaded alongside (or instead of) the point survey. Held
// separately from currentSPS since it is a grid, not a list of S/R points.
let currentBinGrid: BinGrid | null = null;

interface Req {
  id: number;
  type: 'open' | 'trace' | 'extractTrace' | 'section' | 'convert' | 'convertPath' | 'convertTraces' | 'reset' | 'openSPS' | 'spsClear' | 'binGrid' | 'spsGeometry' | 'spsXrefLines' | 'spsFold' | 'spsQC' | 'spsPointDetail' | 'spsSourceList' | 'spsReproject' | 'spsExport' | 'spsHeaderList' | 'spsApplyHeaders' | 'spsSaveCorrected' | 'semblance' | 'avgSpectrum' | 'spectrogram' | 'fk';
  path?: string;
  // spsApplyHeaders: scope ('shared' = all loaded files, else a file name) + the
  // edit/add/remove batch and an optional CRS rewrite. Mirrors the IPC contract.
  scope?: 'shared' | string;
  // `oldVal` (when present) targets a specific record by code+value so two
  // records sharing a code aren't edited/removed together. A `string` remove is
  // still accepted for code-only drops (back-compat).
  edits?: { code: string; val: string; oldVal?: string }[];
  adds?: { code: string; desc?: string; val: string }[];
  removes?: (string | { code: string; oldVal?: string })[];
  crs?: CRSSpec;
  paths?: string[];
  qc?: QCParams;
  code?: string;
  // spsExport: which artifact to produce + optional QC params for the QC report.
  // 'p111' / 'coordcsv' re-serialize the point survey via buildPositioningExport.
  kind?: 'kml' | 'geojson' | 'csv' | 'qcreport' | 'p111' | 'coordcsv';
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
  // convertTraces (Trace Workbench EXPORT): the collected traces + the sample
  // interval (µs) to stamp on the synthetic file (the collection's first trace).
  traces?: { samples: Float32Array; nSamples: number; hdr?: Record<string, number | string> }[];
  sampleInt?: number;
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
  // Spectrum Analysis tab: spectrogram STFT params (winLen/hop in samples) + the
  // f-k trace spacing (dx, projected distance units). traceStart/traceEnd above
  // double as the avgSpectrum averaging window.
  winLen?: number;
  hop?: number;
  dx?: number;
}

function summarize(pf: ParsedFile) {
  // Byte order for the File-summary panel: SEG-Y / SU carry a DETECTED `littleEndian`
  // flag (auto-detection); SEG-2 is little-endian by spec, SEG-D big-endian by spec.
  const f = (pf.format || '').toUpperCase();
  const le = pf.bh.littleEndian;
  const byteOrder =
    f.includes('SEG-Y') || f === 'SU' ? (le ? 'little-endian' : 'big-endian')
      : f.includes('SEG-2') ? 'little-endian'
        : f.includes('SEG-D') ? 'big-endian'
          : '—';
  return {
    format: pf.format,
    revision: pf.revision,
    traceCount: pf.traceCount,
    samplesTrace: pf.bh.samplesTrace ?? pf.traces[0]?.nSamples ?? null,
    sampleInt: pf.bh.sampleInt ?? null,
    byteOrder,
    errors: pf.errors,
  };
}

/** Map a detectPositioningFormat id to a short human label for the stats badge. */
function fmtLabel(id: string): string {
  switch (id) {
    case 'sps': return 'SPS';
    case 'segp1': return 'SEG-P1';
    case 'p111': return 'P1/11';
    case 'p611': return 'P6/11';
    case 'coordcsv': return 'Coord CSV';
    default: return id.toUpperCase();
  }
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

// ── SPS H-record (header) editing ──
//
// All edits preserve the fixed-column SPS H-record format: cols 1-4 hold the
// 4-char code, cols 5-32 the description, cols 33-80 (0-based 32..79) the DATA
// field, terminated with `;`. The parser (parseSPSText) reads code = cols 1-4
// and val = everything from col 33 with a trailing `;…` stripped, so we write
// the value into cols 33-80, left/space-pad the whole line to 80, and re-add `;`.

/** Read the DATA field (cols 33-80) of an H-record line the way parseSPSText does:
 *  everything from col 33 on, with a trailing `;…` stripped, then trimmed. Used to
 *  disambiguate two records that share a code but differ in value. */
function hRecData(raw: string): string {
  const ln = raw || '';
  let data = ln.length > 32 ? ln.substring(32) : '';
  const semi = data.indexOf(';');
  if (semi >= 0) data = data.substring(0, semi);
  return data.trim();
}

/** Rewrite the DATA field (cols 33-80) of an H-record line, keeping cols 1-32
 *  (code + description) intact and re-terminating with `;`. Pads to 80. */
function rewriteHData(raw: string, val: string): string {
  const ln = (raw || '').padEnd(32, ' ');
  const prefix = ln.substring(0, 32); // code + description columns, untouched
  const data = (val ?? '').trim();
  return (prefix + data + ';').padEnd(80, ' ').substring(0, 80);
}

/** Build a fresh H-record line for an ADD: code in cols 1-4, description in
 *  cols 5-32, value in cols 33-80, `;`-terminated, padded to 80. */
function buildHRecord(code: string, desc: string | undefined, val: string): string {
  const c = (code || '').substring(0, 4);
  const label = (desc && desc.trim()) || spsHeaderDesc(code);
  // cols 1-32 = code (1-4) + description (5-32). Code may be 3 or 4 chars; pad
  // the code field so the description starts no earlier than col 5.
  const head = (c.padEnd(c.length >= 4 ? 4 : 4, ' ') + ' ' + label).substring(0, 32).padEnd(32, ' ');
  return (head + (val ?? '').trim() + ';').padEnd(80, ' ').substring(0, 80);
}

/**
 * Apply one file's H-record edit batch to its raw text, preserving fixed columns.
 *  - `edits`: rewrite the DATA field of every H-record whose code matches.
 *  - `crs`:   replace the projection H-records (PROJ_HEADER_CODES) in place from
 *             generateProjHeaders; any missing ones are appended (header-only —
 *             S/R coordinate lines are never touched).
 *  - `removes`: drop H-records whose code matches.
 *  - `adds`:  insert new H-records after the last existing H-record.
 * Returns the new file text.
 */
function applyHeaderEditsToText(
  text: string,
  edits: { code: string; val: string; oldVal?: string }[],
  adds: { code: string; desc?: string; val: string }[],
  removes: (string | { code: string; oldVal?: string })[],
  crsLines: Record<string, string> | null,
): string {
  const hadCRLF = /\r\n/.test(text);
  const eol = hadCRLF ? '\r\n' : '\n';
  // Split on either newline style; keep blank lines so structure is preserved.
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  // Strip a leading BOM from line 0 (parseSPSText does the same).
  if (lines.length && lines[0].charCodeAt(0) === 0xfeff) lines[0] = lines[0].slice(1);

  // Edits/removes can carry an optional `oldVal` so a record is matched by
  // code+value, not code alone — without it, two records sharing a code (e.g. two
  // H22x lines with different content) would all be rewritten/dropped together.
  // Keys: `code` for the code-only entries (back-compat: Admin/CRS upserts, adds
  // reconcile) and `code oldVal` for the value-discriminated ones.
  const SEP = ' ';
  const editByCode = new Map<string, string>();
  const editByCodeVal = new Map<string, string>();
  for (const e of edits || []) {
    if (e.oldVal != null) editByCodeVal.set(e.code + SEP + e.oldVal, e.val);
    else editByCode.set(e.code, e.val);
  }
  const removeCodes = new Set<string>();
  const removeCodeVals = new Set<string>();
  for (const r of removes || []) {
    if (typeof r === 'string') removeCodes.add(r);
    else if (r.oldVal != null) removeCodeVals.add(r.code + SEP + r.oldVal);
    else removeCodes.add(r.code);
  }
  // CRS rewrite codes still pending insertion (those not matched in place).
  const crsPending = new Set(crsLines ? Object.keys(crsLines) : []);

  const out: string[] = [];
  let lastHIdx = -1;
  for (const raw of lines) {
    const code = hRecCode(raw);
    if (code) {
      const cv = code + SEP + hRecData(raw);
      const removed = removeCodes.has(code) || removeCodeVals.has(cv);
      // CRS projection-record rewrite takes precedence over a plain edit.
      if (crsLines && crsLines[code] != null) {
        if (removed) { continue; } // user removed it → skip even under CRS
        out.push(crsLines[code]);
        crsPending.delete(code);
        lastHIdx = out.length - 1;
        continue;
      }
      if (removed) continue; // drop this H-record
      if (editByCodeVal.has(cv)) {
        out.push(rewriteHData(raw, editByCodeVal.get(cv)!));
        lastHIdx = out.length - 1;
        continue;
      }
      if (editByCode.has(code)) {
        out.push(rewriteHData(raw, editByCode.get(code)!));
        lastHIdx = out.length - 1;
        continue;
      }
      out.push(raw);
      lastHIdx = out.length - 1;
      continue;
    }
    out.push(raw);
  }

  // Records to insert after the last existing H-record: any CRS codes not found
  // in the file (header-only addition) followed by the explicit `adds`.
  const inserts: string[] = [];
  if (crsLines) {
    for (const code of PROJ_HEADER_CODES) {
      if (crsPending.has(code) && !removeCodes.has(code)) inserts.push(crsLines[code]);
    }
  }
  for (const a of adds || []) inserts.push(buildHRecord(a.code, a.desc, a.val));

  if (inserts.length) {
    if (lastHIdx >= 0) out.splice(lastHIdx + 1, 0, ...inserts);
    else out.unshift(...inserts); // no H block at all → prepend
  }

  return out.join(eol);
}

/** Re-parse + re-merge all currentSPSFiles into a fresh merged SPSData. */
function reparseMergeAll(files: { name: string; text: string }[]): SPSData | null {
  let merged: SPSData | null = null;
  for (const f of files) {
    const sps = parseSPSText(f.text);
    merged = merged ? mergeSPSData(merged, sps) : sps;
  }
  return merged;
}

/** Build the {code,val,raw,desc} header list from a parsed SPSData's H block. */
function headerListFromSPS(sps: SPSData | null): { code: string; val: string; raw: string; desc: string }[] {
  if (!sps) return [];
  return sps.headers.map((h: SPSHeader) => ({ code: h.code, val: h.val, raw: h.raw, desc: spsHeaderDesc(h.code, h.raw) }));
}

/** Whether the loaded SPS files' H blocks actually differ (by code+val). A
 *  single file (or none) never "differs". */
function spsFilesDiffer(files: { name: string; text: string }[]): boolean {
  if (files.length < 2) return false;
  const sig = (text: string): string => {
    const hs = parseSPSText(text).headers;
    return hs.map((h) => `${h.code}=${h.val}`).join('\n');
  };
  const first = sig(files[0].text);
  for (let i = 1; i < files.length; i++) if (sig(files[i].text) !== first) return true;
  return false;
}

function buildSPSExport(d: SPSData, kind: 'kml' | 'geojson' | 'csv' | 'qcreport' | 'p111' | 'coordcsv', qcParams: QCParams): { ok: boolean; files: { name: string; text: string }[]; error?: string } {
  if (kind === 'csv') return { ok: true, files: buildSPSCsv(d) };
  if (kind === 'geojson') return { ok: true, files: buildSPSGeoJSON(d) };
  if (kind === 'kml') return buildSPSKml(d);
  if (kind === 'qcreport') return { ok: true, files: buildSPSQCReport(d, qcParams) };
  // Positioning-format re-serialization (P1/11, coordinate CSV) lives in
  // core/sps/formats — dispatch through the single buildPositioningExport door.
  if (kind === 'p111' || kind === 'coordcsv') return { ok: true, files: buildPositioningExport(kind, d) };
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
      currentBinGrid = null;
      port.postMessage({ id, ok: true });
      return;
    }

    // Clear ONLY the SPS survey state, leaving any open seismic file untouched
    // (distinct from 'reset', which also drops `current`). Backs the SPS tab's
    // dedicated "Clear SPS" control so the user can start a fresh survey without
    // closing the file they're converting/inspecting.
    if (type === 'spsClear') {
      currentSPS = null;
      currentSPSFiles = [];
      currentBinGrid = null;
      port.postMessage({ id, ok: true });
      return;
    }

    // Return the loaded P6/11 bin grid (or null when none is loaded). The grid is
    // populated by openSPS when a positioning file resolves to kind:'bingrid'.
    if (type === 'binGrid') {
      port.postMessage({ id, ok: true, grid: currentBinGrid });
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
      // ACCUMULATE: each Load APPENDS to the in-worker survey instead of
      // replacing it. Seed `merged` from whatever's already loaded so a 2nd/3rd
      // Load adds its stations to the existing survey, and APPEND to
      // currentSPSFiles (never reset) so reproject/export see every loaded file.
      //
      // Every file is now routed through the positioning-format dispatch: the
      // format is detected per file (extension-first, then content) and parsed.
      // A point format (sps / segp1 / p111 / coordcsv) merges into currentSPS
      // exactly as before — the 'sps' path stays byte-identical, since detect
      // defaults to 'sps' and parsePositioning('sps') calls parseSPSText. A
      // bin-grid format (p611) populates currentBinGrid instead of the point list.
      let merged: SPSData | null = currentSPS;
      let lastGrid: BinGrid | null = null;
      // Collect the distinct positioning formats touched THIS call so the renderer
      // can badge what was loaded (e.g. "SPS · P1/11", "P6/11"). Order-preserving.
      const fmtsSeen: string[] = [];
      for (const p of req.paths ?? []) {
        const text = readFileSync(p, 'utf8');
        const name = basename(p);
        const fmt = detectPositioningFormat(name, text);
        if (!fmtsSeen.includes(fmt)) fmtsSeen.push(fmt);
        const parsed = parsePositioning(fmt, text);
        if (parsed.kind === 'bingrid') {
          // Bin grids are not point files: store the latest one and skip the
          // currentSPSFiles point-list (reproject/header-edit don't apply to it).
          currentBinGrid = parsed.grid;
          lastGrid = parsed.grid;
          continue;
        }
        // Skip a file that's already loaded with identical content: re-loading the
        // same set would otherwise add duplicate scope-selector entries and make
        // spsSaveCorrected zip two files with the same name. Point dedup in
        // mergeSPSData already collapses the stations, but the file list does not.
        if (currentSPSFiles.some((f) => f.name === name && f.text === text)) continue;
        currentSPSFiles.push({ name, text, type: detectSPSType(name, text) });
        merged = merged ? mergeSPSData(merged, parsed.data) : parsed.data;
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
          // Distinct positioning format(s) detected this Load, as display labels —
          // the SPS stats bar badges them so the user sees what was ingested.
          formats: fmtsSeen.map(fmtLabel),
          // Present only when a bin grid was loaded this call, so the renderer can
          // surface a P6/11 grid summary alongside (or instead of) the points.
          binGrid: lastGrid
            ? { nInline: lastGrid.nInline, nCrossline: lastGrid.nCrossline, originE: lastGrid.originE, originN: lastGrid.originN, binI: lastGrid.binI, binJ: lastGrid.binJ, inlineAzimuth: lastGrid.inlineAzimuth }
            : null,
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
        // Bound the inner range walk independently of pushes: a crafted X-file
        // range (from=0,to=1e9,incr=1) whose points never match would otherwise
        // run ~1e9 Map lookups and hang the single-threaded worker, since the
        // sxA-length break only fires when a segment is actually pushed.
        let rcvSteps = 0;
        for (let rp = from; rp <= to; rp += incr) {
          if (sxA.length >= MAX_SEG || ++rcvSteps > MAX_SEG) break;
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
        // Bound the inner range walk: MAX_PAIRS decimation is an xref-LIST stride
        // and never caps a single xref, so a crafted range (from=0,to=1e9,incr=1)
        // would run ~1e9 Map lookups and hang the worker. Cap iterations per xref.
        let rcvSteps = 0;
        for (let rp = from; rp <= to; rp += incr) {
          if (++rcvSteps > MAX_PAIRS) break;
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

    // Observer Log v2 SPS-linking: flatten currentSPS.sources to the lean record
    // the renderer binds log columns to (sps-role columns pull one srcField each).
    // Returns [] when no survey is loaded so the renderer can clear/disable the
    // link without special-casing the no-SPS state. upholeMs/staticMs/srcType are
    // optional on SPSPoint → coerced to null when absent (the contract type).
    if (type === 'spsSourceList') {
      const sources = (currentSPS?.sources ?? []).map((s) => ({
        lineName: s.lineName,
        point: s.point,
        idx: s.idx,
        easting: s.easting,
        northing: s.northing,
        elevation: s.elevation,
        upholeMs: s.upholeMs ?? null,
        staticMs: s.staticMs ?? null,
        srcType: s.srcType ?? null,
      }));
      port.postMessage({ id, ok: true, sources });
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

    // SPS HEADER VIEWER: return the shared H block as {code,val,raw,desc}, the
    // parsed projection, the loaded file list, and whether the files' H blocks
    // actually differ. Built from currentSPS (the merged survey) + currentSPSFiles.
    if (type === 'spsHeaderList') {
      const headers = headerListFromSPS(currentSPS);
      const proj = currentSPS?.projection ?? null;
      const projection = proj
        ? {
            type: proj.type, subtype: proj.subtype, zone: proj.zone, hemi: proj.hemi,
            datum: proj.datum, ellipsoid: proj.ellipsoid, units: proj.units,
            centralMeridian: proj.centralMeridian, latOrigin: proj.latOrigin,
            falseEasting: proj.falseEasting, falseNorthing: proj.falseNorthing,
            scaleFactor: proj.scaleFactor, desc: proj.desc,
          }
        : null;
      const files = currentSPSFiles.map((f) => ({ name: f.name, type: f.type }));
      const filesDiffer = spsFilesDiffer(currentSPSFiles);
      port.postMessage({ id, ok: true, headers, projection, files, filesDiffer });
      return;
    }

    // SPS HEADER EDITOR: apply an edit/add/remove batch (+ optional CRS rewrite)
    // to the H block of every targeted file (scope 'shared' = all loaded SPS
    // files, else the named file), rewrite currentSPSFiles raw text in place,
    // re-parse + re-merge, and return the refreshed header list. NEVER touches
    // S/R coordinate lines — the CRS rewrite is HEADER-ONLY.
    if (type === 'spsApplyHeaders') {
      if (!currentSPSFiles.length) {
        port.postMessage({ id, ok: false, error: 'no SPS loaded' });
        return;
      }
      const scope = req.scope ?? 'shared';
      // Bound the batch so a malformed/oversized IPC payload can't fan out into a
      // huge text rewrite (one 80-char line per add, × every targeted file). A
      // real header block has a few dozen records; cap generously.
      const MAX_HDR_OPS = 1000;
      const MAX_HDR_VAL = 4096; // per-value char cap (the line itself is clamped to 80)
      const clampVal = (v: string) => (typeof v === 'string' ? v.slice(0, MAX_HDR_VAL) : '');
      const edits = (req.edits ?? []).slice(0, MAX_HDR_OPS).map((e) => ({ code: e.code, val: clampVal(e.val), oldVal: e.oldVal }));
      const adds = (req.adds ?? []).slice(0, MAX_HDR_OPS).map((a) => ({ code: a.code, desc: a.desc, val: clampVal(a.val) }));
      const removes = (req.removes ?? []).slice(0, MAX_HDR_OPS);
      let crsLines: Record<string, string> | null = null;
      if (req.crs) {
        try { crsLines = generateProjHeaders(crsFromSpec(req.crs)); }
        catch (e) { port.postMessage({ id, ok: false, error: `CRS rewrite failed: ${(e as Error).message}` }); return; }
      }

      const targets = scope === 'shared' ? currentSPSFiles : currentSPSFiles.filter((f) => f.name === scope);
      if (scope !== 'shared' && !targets.length) {
        port.postMessage({ id, ok: false, error: `no loaded SPS file named '${scope}'` });
        return;
      }
      for (const f of targets) {
        f.text = applyHeaderEditsToText(f.text, edits, adds, removes, crsLines);
      }

      currentSPS = reparseMergeAll(currentSPSFiles);
      port.postMessage({ id, ok: true, headers: headerListFromSPS(currentSPS) });
      return;
    }

    // SPS HEADER EDITOR — save: hand the edited currentSPSFiles raw text back so
    // main.ts can ZIP + Save them (same flow as spsReproject). One {name,text}
    // per loaded file, names kept as-is.
    if (type === 'spsSaveCorrected') {
      if (!currentSPSFiles.length) {
        port.postMessage({ id, ok: false, error: 'no SPS loaded' });
        return;
      }
      const files = currentSPSFiles.map((f) => ({ name: f.name, text: f.text }));
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

    // Trace Workbench: parse a file LOCALLY (never touching `current`) and pull
    // ONE trace out of it. Mirrors convertPath's local-parse pattern so the
    // workbench can collect traces from arbitrary files without disturbing — or
    // requiring — the persistently-open file. Placed above the `!current` guard
    // because it needs no open file of its own.
    if (type === 'extractTrace') {
      const local = parseAny(new Uint8Array(readFileSync(req.path!)), basename(req.path!));
      const i = Math.max(0, Math.min(local.traceCount - 1, (req.index ?? 0) | 0));
      const tr = local.traces[i];
      const samples = tr?.samples ? tr.samples.slice() : new Float32Array(0);
      port.postMessage(
        {
          id,
          ok: true,
          name: basename(req.path!),
          index: i,
          traceCount: local.traceCount,
          nSamples: tr?.nSamples ?? 0,
          sampleInt: local.bh.sampleInt ?? 0,
          hdr: tr?.hdr ?? {},
          samples,
        },
        [samples.buffer],
      );
      return;
    }

    // Trace Workbench EXPORT: assemble a synthetic ParsedFile from the collected
    // traces and run it through the chosen writer — same SAVE flow as `convert`,
    // but the data comes from the request, not the persistently-open file. No
    // open file is required, so it sits above the `!current` guard. The writers
    // size the record from the LONGEST trace and clamp, so mixed-length traces
    // are safe; the sample interval defaults inside the writers (→ 2000 µs) when
    // the collection carried none.
    if (type === 'convertTraces') {
      const writer = getWriter(req.format!);
      if (!writer) {
        port.postMessage({ id, ok: false, error: `unknown output format: ${req.format}` });
        return;
      }
      const inTraces = req.traces ?? [];
      // Bound the synthetic file before the writer allocates its output buffer.
      // trc.length is renderer-supplied and otherwise uncapped, so a driven
      // renderer could force a multi-GB allocation in writeSU/writeSEGY. Reject
      // collections past a sane trace count or total-sample budget instead.
      const MAX_EXPORT_TRACES = 200_000;
      const MAX_EXPORT_SAMPLES = 200_000_000; // ~800 MB of f32 samples
      let totalSamples = 0;
      for (const t of inTraces) totalSamples += Math.max(0, (t.nSamples | 0));
      if (inTraces.length > MAX_EXPORT_TRACES || totalSamples > MAX_EXPORT_SAMPLES) {
        port.postMessage({ id, ok: false, error: `export collection too large (${inTraces.length} traces, ${totalSamples} samples)` });
        return;
      }
      const pf: ParsedFile = {
        format: 'SEG-Y',
        revision: 1,
        textHeader: '',
        bh: { sampleInt: req.sampleInt },
        traces: inTraces.map((t) => ({ hdr: t.hdr ?? {}, samples: t.samples, nSamples: t.nSamples })),
        traceCount: inTraces.length,
        errors: [],
      };
      const out = writer.write(pf);
      const ab = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
      port.postMessage({ id, ok: true, bytes: ab, ext: writer.ext }, [ab]);
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
      // True only when the request actually narrows the sample axis. Without this
      // flag, an un-zoomed request (s1 = fullSamps = bh.samplesTrace) would slice
      // — and so truncate — any variable-length trace whose nSamples exceeds
      // bh.samplesTrace, silently dropping its deep tail (a data-loss regression).
      const sampZoom = s0 > 0 || s1 < fullSamps;
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
        // Slice to the visible sample window only when the user actually zoomed
        // the sample axis; otherwise keep the full trace (its tail beyond
        // bh.samplesTrace must survive an un-zoomed render).
        if (sampZoom) s = s.subarray(Math.min(s0, s.length), Math.min(s1, s.length));
        const nf = normFactorPercentile(s, 0.95);
        if (nf > norm) norm = nf;
        // Time-preserving downsample (clean vertical axis for VD; good enough for wiggle).
        columns.push(s.length > maxSamples ? resampleLinear(s, maxSamples) : s);
      }
      if (norm <= 0) norm = 1;

      const numTraces = columns.length;
      // Use the LONGEST column, not columns[0]: with variable-length traces the
      // first windowed trace may be short/dead (e.g. 400 samples) while later
      // ones are full — sizing to columns[0] would truncate every longer trace.
      let colLen = 0;
      for (let c = 0; c < numTraces; c++) if (columns[c].length > colLen) colLen = columns[c].length;
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

    // ── Spectrum Analysis tab ──
    //
    // avgSpectrum + fk both consume the file's trace matrix; spectrogram pulls a
    // single trace. avgSpectrum + fk reuse the SAME stride-decimation the section
    // handler uses (cap the trace count, keep every Nth) but assemble UN-normalized
    // raw samples (true amplitudes matter for a spectrum). The trace caps below
    // mirror the section view's defaults so a huge survey can't blow the worker.

    if (type === 'avgSpectrum') {
      const si = current.bh.sampleInt ?? 2000;
      const tc = current.traceCount;
      // Averaging window (full-data indices, end exclusive); clamp + order.
      let t0 = Math.max(0, Math.min(tc, (req.traceStart ?? 0) | 0));
      let t1 = Math.max(0, Math.min(tc, (req.traceEnd ?? tc) | 0));
      if (t1 <= t0) { t0 = 0; t1 = tc; }
      // Decimate the trace COUNT if the window is huge (same idea as the section
      // handler's traceStep): keep at most MAX_TRACES, every Nth across the window.
      const MAX_TRACES = 4000;
      // Also cap each trace's sample length (like the fk handler) so averageSpectrum's
      // N = nextPow2(maxTraceLen) can't force a huge per-trace FFT from one over-long
      // trace; resample longer traces down to MAX_SAMPLES before averaging.
      const MAX_SAMPLES = 8192;
      const winTraces = t1 - t0;
      const stride = Math.max(1, Math.ceil(winTraces / MAX_TRACES));
      const traces: Float32Array[] = [];
      for (let t = t0; t < t1; t += stride) {
        const s = current.traces[t]?.samples;
        if (s) traces.push(s.length > MAX_SAMPLES ? resampleLinear(s, MAX_SAMPLES) : s);
      }
      if (!traces.length) {
        port.postMessage({ id, ok: false, error: 'no traces with samples' });
        return;
      }
      const r = averageSpectrum(traces, si, {});
      const decimated = stride > 1;
      const log = decimated
        ? `Average spectrum decimated: ${winTraces} traces > ${MAX_TRACES} cap; kept every ${stride}${stride === 2 ? 'nd' : stride === 3 ? 'rd' : 'th'} → ${r.nTraces} traces.`
        : `Average spectrum over ${r.nTraces} traces.`;
      port.postMessage(
        { id, ok: true, freqs: r.freqs, amp: r.amp, nyquist: r.nyquist, nTraces: r.nTraces, decimated, log },
        [r.freqs.buffer, r.amp.buffer] as ArrayBuffer[],
      );
      return;
    }

    if (type === 'spectrogram') {
      const si = current.bh.sampleInt ?? 2000;
      const i = Math.max(0, Math.min(current.traceCount - 1, (req.index ?? 0) | 0));
      const s = current.traces[i]?.samples;
      if (!s || s.length === 0) {
        port.postMessage({ id, ok: false, error: 'trace has no samples' });
        return;
      }
      // Cap the output grid (nFrames*nBins) so a long trace with a tiny hop can't
      // allocate a huge image; grow the hop just enough to fit the budget.
      const MAX_CELLS = 4_000_000;
      // Cap the window so nextPow2(winLen) can't force a multi-GB FFT buffer
      // (spectrogram allocates Float64Array(nextPow2(winLen)) for re AND im). A
      // window longer than the trace yields a single zero-padded frame anyway, so
      // clamp to the trace length and an absolute ceiling.
      const MAX_WIN = 65_536;
      let winLen = Math.max(2, Math.min(MAX_WIN, s.length, (req.winLen ?? 128) | 0));
      let hop = Math.max(1, (req.hop ?? (winLen >> 1)) | 0);
      const nBins = nextPow2(winLen) >> 1;
      const framesFor = (h: number) => (s.length >= winLen ? Math.floor((s.length - winLen) / h) + 1 : 1);
      if (framesFor(hop) * nBins > MAX_CELLS) {
        const maxFrames = Math.max(1, Math.floor(MAX_CELLS / nBins));
        hop = Math.max(hop, Math.ceil((s.length - winLen) / Math.max(1, maxFrames - 1)));
      }
      const r = spectrogram(s, si, { winLen, hop });
      port.postMessage(
        { id, ok: true, mag: r.mag, nFrames: r.nFrames, nBins: r.nBins, freqs: r.freqs, times: r.times, maxMag: r.maxMag, siUs: r.siUs },
        [r.mag.buffer, r.freqs.buffer, r.times.buffer] as ArrayBuffer[],
      );
      return;
    }

    if (type === 'fk') {
      const si = current.bh.sampleInt ?? 2000;
      const tc = current.traceCount;
      const fullSamps = current.bh.samplesTrace ?? current.traces[0]?.nSamples ?? 0;
      // Decimate trace count + sample count to keep the 2-D FFT (padded to pow2)
      // bounded. Reuse the section view's defaults as the working caps.
      const MAX_TRACES = 1024;
      const MAX_SAMPLES = 4096;
      const traceStep = Math.max(1, Math.ceil(tc / MAX_TRACES));
      // Build an un-normalized trace matrix (raw samples). Size to the LONGEST
      // selected trace (capped), zero-pad shorter ones — variable-length traces
      // must not be truncated to trace 0's length.
      const cols: Float32Array[] = [];
      for (let t = 0; t < tc; t += traceStep) {
        const s = current.traces[t]?.samples;
        if (!s) continue;
        cols.push(s.length > MAX_SAMPLES ? resampleLinear(s, MAX_SAMPLES) : s);
      }
      const nTraces = cols.length;
      if (!nTraces) {
        port.postMessage({ id, ok: false, error: 'no traces with samples' });
        return;
      }
      let nSamples = 0;
      for (let c = 0; c < nTraces; c++) if (cols[c].length > nSamples) nSamples = cols[c].length;
      const matrix = new Float32Array(nTraces * nSamples);
      for (let c = 0; c < nTraces; c++) {
        const col = cols[c];
        matrix.set(col.subarray(0, Math.min(nSamples, col.length)), c * nSamples);
      }
      // dx scales by the trace decimation: skipping traceStep traces multiplies
      // the effective spacing so the wavenumber axis stays physically correct.
      const dx = (req.dx && req.dx > 0 ? req.dx : 1) * traceStep;
      const r = fkSpectrum(matrix, nTraces, nSamples, si, dx);
      const decimated = traceStep > 1 || fullSamps > MAX_SAMPLES;
      const log = decimated
        ? `f-k decimated: ${nTraces} traces (every ${traceStep}${traceStep === 2 ? 'nd' : traceStep === 3 ? 'rd' : 'th'}), ${nSamples} samples/trace; grid ${r.nF}×${r.nKx}.`
        : `f-k spectrum: ${nTraces} traces × ${nSamples} samples; grid ${r.nF}×${r.nKx}.`;
      port.postMessage(
        { id, ok: true, mag: r.mag, nKx: r.nKx, nF: r.nF, kAxis: r.kAxis, fAxis: r.fAxis, maxMag: r.maxMag, decimated, log },
        [r.mag.buffer, r.kAxis.buffer, r.fAxis.buffer] as ArrayBuffer[],
      );
      return;
    }

    port.postMessage({ id, ok: false, error: `unknown request type: ${type}` });
  } catch (e) {
    port.postMessage({ id, ok: false, error: (e as Error).message });
  }
});
