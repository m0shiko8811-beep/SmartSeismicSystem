// seisconv-core / dsp — NMO semblance (velocity analysis).
//
// Hyperbolic-moveout semblance over a velocity scan: for each (velocity, time)
// it NMO-corrects the gather and measures coherency (0..1). Uses header offsets
// when present, else a synthetic 25 m spacing. Ported from the SeisConv reference.

import type { Trace } from '../types';

export interface SemblanceResult {
  /** nV × nT, row-major (row = velocity), values 0..1. */
  semb: Float32Array;
  vels: number[];
  nT: number;
  dt: number;
  velMin: number;
  velMax: number;
  siUs: number;
  hasOffsets: boolean;
  offNote: string;
}

export function computeSemblance(traces: Trace[], siUs: number, velMin: number, velMax: number, velStep: number): SemblanceResult {
  const dt = siUs * 1e-6; // seconds
  const nT = traces[0]?.nSamples ?? 0;
  const vels: number[] = [];
  for (let v = velMin; v <= velMax; v += velStep) vels.push(v);
  const nV = vels.length;

  // Offsets from headers, else synthetic (midpoint-centered, 25 m spacing).
  const rawOff = traces.map((tr) => {
    const o = tr.hdr?.offset;
    const n = typeof o === 'number' ? o : o != null ? parseFloat(o) : NaN;
    return isFinite(n) ? Math.abs(n) : null;
  });
  const validOff = rawOff.filter((x) => x !== null && x > 0);
  const hasOff = validOff.length > traces.length * 0.5;
  const offsets = rawOff.map((off, i) => (hasOff && off !== null && off > 0 ? off : Math.abs(i - traces.length / 2) * 25));

  const semb = new Float32Array(nV * nT);
  for (let vi = 0; vi < nV; vi++) {
    const v2 = vels[vi] * vels[vi];
    for (let ti = 0; ti < nT; ti++) {
      const t0 = ti * dt;
      const t02 = t0 * t0;
      let sumA = 0;
      let sumA2 = 0;
      let n = 0;
      for (let j = 0; j < traces.length; j++) {
        const s = traces[j].samples;
        if (!s) continue;
        const x = offsets[j];
        const tNmo = Math.sqrt(Math.max(0, t02 + (x * x) / v2));
        const si = Math.round(tNmo / dt);
        if (si >= 0 && si < nT) {
          const amp = s[si];
          sumA += amp;
          sumA2 += amp * amp;
          n++;
        }
      }
      if (n > 0 && sumA2 > 1e-10) semb[vi * nT + ti] = (sumA * sumA) / (n * sumA2);
    }
  }

  return { semb, vels, nT, dt, velMin, velMax, siUs, hasOffsets: hasOff, offNote: hasOff ? 'using header offsets' : 'synthetic offsets (25m spacing)' };
}
