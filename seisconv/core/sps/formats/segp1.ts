// seisconv-core / sps / formats — SEG-P1 positioning parser (READ-ONLY).
//
// SEG-P1 is the (now deprecated) SEG post-plot positioning point format: a fixed
// 80-column ASCII record per shot/receiver point carrying a line name, a point
// (shotpoint) number, geographic lat/long AND a projected UTM easting/northing +
// elevation, preceded by an 'H'-prefixed free-text header block (up to 20 records)
// that may name the ellipsoid / grid / UTM zone.
//
// It maps onto the SAME SPSData model as SPS so every downstream view (geometry,
// fold, QC, export) is format-agnostic. There is NO writer: SEG-P1 is deprecated,
// so this module is read-only by design.
//
// Documented column layout (1-based, per the SEG-P1 spec / IHS AccuMap reference):
//   col  1      record identifier (space, or a vendor S/R/V/E code)
//   cols 2-17   line name           (left-justified ASCII)
//   cols 18-25  shotpoint / point   (integer)
//   col  26     reshoot code        (space or A-Z)
//   cols 27-35  latitude            "ddmmssssh"  (h = N/S)   — hundredths-of-sec
//   cols 36-45  longitude           "dddmmssssh" (h = E/W)
//   cols 46-53  UTM easting         (integer, DECIMETRES)
//   cols 54-61  UTM northing        (integer, DECIMETRES)
//   cols 62-66  elevation           (integer, DECIMETRES)
//   cols 67-80  optional time / extra text
//
// PURE: no DOM, no Node — runs in the worker AND in unit tests.

import { spsExtractProjection, type SPSData, type SPSPoint, type SPSHeader, type SPSProjection } from '../parse';

// ── DoS bounds (mirror the binary parsers' MAX_TRACES / MAX_SAMPLES discipline) ──
/** Hard cap on total point records materialized from one file. */
const MAX_POINTS = 2_000_000;
/** Hard cap on the per-line length we will inspect/store (a conformant record is
 *  80 cols; this bounds a hostile multi-MB single line without touching real data). */
const MAX_LINE_LEN = 4096;
/** SEG-P1's header block is "up to twenty records"; bound how many H lines we
 *  retain so a file that is ALL 'H' lines can't grow the header payload unbounded. */
const MAX_HEADERS = 4096;

/** A fresh, empty SPSData. */
function emptySPSData(): SPSData {
  return { sources: [], receivers: [], xrefs: [], headers: [], errors: [], skipped: 0, layout: null };
}

/** Fixed-column slice, end-exclusive, 0-based, trimmed. */
function col(s: string, a: number, b: number): string {
  return s.substring(a, b).trim();
}

/** Parse an integer field; returns NaN when blank/garbage (never throws). */
function intField(s: string, a: number, b: number): number {
  const v = col(s, a, b);
  if (!v) return NaN;
  // SEG-P1 numeric fields are signed integers; tolerate a leading sign and stray
  // non-digits by extracting the leading signed-integer token.
  const m = /^[+-]?\d+/.exec(v);
  return m ? parseInt(m[0], 10) : NaN;
}

/**
 * Parse a SEG-P1 packed geographic field "DDMMSSss[h]" (latitude, 2-digit degrees)
 * or "DDDMMSSss[h]" (longitude, 3-digit degrees), where SSss is seconds in
 * hundredths and h ∈ {N,S,E,W}. Returns signed decimal degrees, or null when the
 * field is blank / not in that form (e.g. a vendor that left it empty).
 *
 * `degDigits` is 2 for latitude, 3 for longitude.
 */
function parsePackedDMS(field: string, degDigits: number): number | null {
  let s = (field || '').trim();
  if (!s) return null;
  let sign = 1;
  // Trailing hemisphere letter (preferred) or a leading +/- sign.
  const hemi = s.slice(-1).toUpperCase();
  if (hemi === 'N' || hemi === 'S' || hemi === 'E' || hemi === 'W') {
    if (hemi === 'S' || hemi === 'W') sign = -1;
    s = s.slice(0, -1).trim();
  } else if (s[0] === '+' || s[0] === '-') {
    if (s[0] === '-') sign = -1;
    s = s.slice(1);
  }
  // Some vendors write a decimal-degree form "gg.ggggg" / "ggg.ggggg" instead of
  // the packed integer form — honour a plain decimal when present.
  if (s.includes('.') && !/^\d+$/.test(s.replace('.', ''))) return null;
  if (s.includes('.')) {
    const dec = parseFloat(s);
    return isFinite(dec) ? sign * dec : null;
  }
  // Packed integer form: need at least degDigits + 4 (MMSS) digits to be meaningful.
  if (!/^\d+$/.test(s)) return null;
  if (s.length < degDigits + 2) return null;
  const deg = parseInt(s.slice(0, degDigits), 10);
  const min = parseInt(s.slice(degDigits, degDigits + 2), 10);
  // Remaining digits are seconds in hundredths: "SSss" → SS.ss.
  const secRaw = s.slice(degDigits + 2);
  const sec = secRaw ? parseInt(secRaw, 10) / Math.pow(10, Math.max(0, secRaw.length - 2)) : 0;
  if (!isFinite(deg) || !isFinite(min) || !isFinite(sec)) return null;
  const v = deg + min / 60 + sec / 3600;
  return isFinite(v) ? sign * v : null;
}

/**
 * Derive an {@link SPSProjection} from the SEG-P1 'H' header block when it names a
 * UTM zone / datum. The header is free text, so we keyword-scan: a UTM zone, a
 * north/south hemisphere, and a coarse datum/ellipsoid token. When nothing
 * recognizable is present we return undefined so the user's CRS picker fills it.
 *
 * We reuse the SPS H-record machinery by synthesizing the few H-codes
 * {@link spsExtractProjection} understands (H18 projection type, H19 UTM zone,
 * H12 datum) — keeping a single source of truth for projection inference.
 */
function projectionFromHeaderText(headerLines: string[]): SPSProjection | undefined {
  const text = headerLines.join('\n');
  const up = text.toUpperCase();
  const synth: SPSHeader[] = [];

  // UTM zone, e.g. "UTM ZONE 36N", "UTM 31 NORTH", "ZONE 50S".
  const zoneM = /\bUTM[^0-9]{0,12}?(?:ZONE\s*)?(\d{1,2})\s*([NS]|NORTH|SOUTH)?/i.exec(up)
    || /\bZONE\s*(\d{1,2})\s*([NS]|NORTH|SOUTH)\b/i.exec(up);
  const isUTM = /\bUTM\b/.test(up);
  if (isUTM) {
    synth.push({ code: 'H18', val: 'UTM', raw: '' });
    if (zoneM) {
      const zone = parseInt(zoneM[1], 10);
      const h = (zoneM[2] || '').toUpperCase();
      const south = h === 'S' || h === 'SOUTH';
      if (zone >= 1 && zone <= 60) {
        synth.push({ code: 'H19', val: `${zone} ${south ? 'South' : 'North'}`, raw: '' });
      }
    }
  } else if (/TRANSVERSE\s+MERCATOR/.test(up) || /\bTM\b/.test(up)) {
    synth.push({ code: 'H18', val: 'Transverse Mercator', raw: '' });
  }

  // Datum / ellipsoid keyword (coarse — the H12 free-text parser tolerates it).
  let datum: string | null = null;
  if (/\bWGS\s*-?\s*84\b/.test(up)) datum = 'WGS84';
  else if (/\bNAD\s*-?\s*83\b/.test(up)) datum = 'NAD83';
  else if (/\bNAD\s*-?\s*27\b/.test(up)) datum = 'NAD27';
  else if (/\bGRS\s*-?\s*80\b/.test(up)) datum = 'GRS80';
  else if (/\bCLARKE\b/.test(up)) datum = 'Clarke';
  else if (/\bED\s*-?\s*50\b/.test(up)) datum = 'ED50';
  if (datum) synth.push({ code: 'H12', val: datum, raw: '' });

  if (!synth.length) return undefined;
  const proj = spsExtractProjection(synth);
  proj.source = 'segp1-header';
  return proj;
}

/**
 * Classify a SEG-P1 record's identifier column into a source/receiver rtype.
 * SEG-P1 post-plot files most commonly use a blank id (shotpoints) — so the
 * default is 'S'. Some vendors stamp a single-letter code; we honour the obvious
 * ones (R = receiver, V/G = geophone group → receiver; S/E = energy/source).
 * `headerDefault` lets a header keyword bias an all-blank file.
 */
function classifyRtype(idChar: string, headerDefault: 'S' | 'R'): 'S' | 'R' {
  const c = (idChar || '').trim().toUpperCase();
  if (c === 'R' || c === 'V' || c === 'G') return 'R';
  if (c === 'S' || c === 'E') return 'S';
  return headerDefault;
}

/**
 * Parse SEG-P1 positioning text into the shared {@link SPSData} model.
 *
 * Malformed input NEVER throws — problems land in `errors` / `skipped`. Obeys the
 * codebase DoS rules (MAX_POINTS, per-line + header caps; no allocation from an
 * unbounded attacker-controlled count/length).
 */
export function parseSegP1(text: string): SPSData {
  const out = emptySPSData();
  if (typeof text !== 'string' || !text) return out;

  const rawLines = text.replace(/\r/g, '').split('\n');
  if (rawLines.length && rawLines[0].charCodeAt(0) === 0xfeff) rawLines[0] = rawLines[0].slice(1);

  const headerLines: string[] = [];
  let truncatedHeaders = false;

  // First pass over the leading 'H' block to learn a default source/receiver bias.
  // (SEG-P1 is overwhelmingly a shotpoint file; the header rarely overrides this.)
  let headerDefault: 'S' | 'R' = 'S';

  for (let li = 0; li < rawLines.length; li++) {
    const rawFull = rawLines[li];
    if (!rawFull || !rawFull.trim()) continue;

    // Bound the per-line work — never inspect/store more than MAX_LINE_LEN chars.
    const raw = rawFull.length > MAX_LINE_LEN ? rawFull.slice(0, MAX_LINE_LEN) : rawFull;
    const first = raw[0].toUpperCase();

    // ── header block ──
    if (first === 'H') {
      if (headerLines.length < MAX_HEADERS) {
        const hVal = raw.slice(1).trim();
        headerLines.push(raw);
        out.headers.push({ code: 'H', val: hVal, raw });
        if (/\bRECEIVER\b/i.test(hVal) && !/\bSOURCE\b/i.test(hVal)) headerDefault = 'R';
      } else {
        truncatedHeaders = true;
      }
      continue;
    }

    // Skip blank-id comment leaders that aren't data (e.g. '*', '!').
    if (first === '*' || first === '!' || first === '#') continue;

    // ── point record ──
    if (out.sources.length + out.receivers.length >= MAX_POINTS) {
      out.errors.push(`SEG-P1: record cap (${MAX_POINTS}) reached — remaining records ignored.`);
      break;
    }

    // Pad to the fixed 80 columns so short lines read as blank tails (never throw).
    const ln = raw.length < 80 ? raw.padEnd(80, ' ') : raw;

    const lineName = col(ln, 1, 17);
    const point = intField(ln, 17, 25);
    const idxChar = col(ln, 25, 26); // reshoot code → used as idx
    const lat = parsePackedDMS(col(ln, 26, 35), 2);
    const lon = parsePackedDMS(col(ln, 35, 45), 3);
    // Easting / Northing / Elevation are integers in DECIMETRES → meters = /10.
    const eDm = intField(ln, 45, 53);
    const nDm = intField(ln, 53, 61);
    const zDm = intField(ln, 61, 66);

    const hasGrid = isFinite(eDm) && isFinite(nDm) && (Math.abs(eDm) > 0 || Math.abs(nDm) > 0);
    const hasGeo = lat != null && lon != null;

    if (!isFinite(point) && !hasGrid && !hasGeo) {
      // Nothing usable on this line — count it as skipped and keep going.
      out.skipped++;
      out.errors.push(`L${li + 1}: SEG-P1 record — no point/coords parsed: [${col(ln, 0, 26)}]`);
      continue;
    }

    const easting = hasGrid ? eDm / 10 : NaN;
    const northing = hasGrid ? nDm / 10 : NaN;
    const elevation = isFinite(zDm) ? zDm / 10 : NaN;

    const rtype = classifyRtype(col(ln, 0, 1), headerDefault);

    const pt: SPSPoint = {
      rtype,
      lineName,
      point: isFinite(point) ? point : 0,
      idx: idxChar || '',
      easting: isFinite(easting) ? easting : 0,
      northing: isFinite(northing) ? northing : 0,
      elevation: isFinite(elevation) ? elevation : 0,
      raw,
      lineNum: li + 1,
    };
    if (rtype === 'S') out.sources.push(pt);
    else out.receivers.push(pt);
  }

  if (truncatedHeaders) out.errors.push(`SEG-P1: header cap (${MAX_HEADERS}) reached — extra H records ignored.`);
  if (out.skipped > 0) out.errors.unshift(`${out.skipped} record(s) skipped (SEG-P1 parse failed)`);

  out.layout = 'SEG-P1';
  const proj = projectionFromHeaderText(headerLines);
  if (proj) out.projection = proj;
  return out;
}
