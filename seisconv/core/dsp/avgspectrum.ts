// seisconv-core / dsp — average amplitude spectrum.
//
// Mean of per-trace single-sided amplitude spectra over a record (or a trace
// sub-window). A standard SEG-Y QC view: the survey's average frequency content
// reveals the source bandwidth, ground roll, notches, and aliasing at a glance.
// Pure — no DOM, no deps. Reuses amplitudeSpectrum (FFT + Hann) from ./fft.

import { amplitudeSpectrum, nextPow2 } from './fft';
import { resampleLinear } from './interpolate';

export interface AvgSpectrum {
  freqs: Float32Array; // Hz, length N/2
  amp: Float32Array; // mean single-sided amplitude across traces, length N/2
  nyquist: number; // Hz
  nTraces: number; // how many traces actually contributed to the mean
}

/**
 * Mean amplitude spectrum across `traces`. Each trace is transformed by
 * {@link amplitudeSpectrum} (Hann-windowed, zero-padded), then accumulated into a
 * running mean. So every trace's bins LINE UP regardless of its own length, all
 * spectra share a COMMON N = nextPow2(maxNSamples): a trace whose own padded
 * length differs is resampled onto that common N/2-bin grid before averaging.
 * `siUs` is the sample interval (µs); the freq axis is derived from it.
 *
 * `traceStart`/`traceEnd` (end exclusive) restrict the averaging window; both
 * default to the full set. Indices are clamped/ordered so a bad request is safe.
 */
export function averageSpectrum(
  traces: Float32Array[],
  siUs: number,
  opts: { traceStart?: number; traceEnd?: number } = {},
): AvgSpectrum {
  const nTotal = traces.length;
  let t0 = Math.max(0, Math.min(nTotal, (opts.traceStart ?? 0) | 0));
  let t1 = Math.max(0, Math.min(nTotal, (opts.traceEnd ?? nTotal) | 0));
  if (t1 <= t0) { t0 = 0; t1 = nTotal; }

  // Common transform length: pad every trace to nextPow2(maxNSamples) so all the
  // per-trace half-spectra share the same N/2 bins and the same Hz axis.
  let maxN = 0;
  for (let t = t0; t < t1; t++) {
    const s = traces[t];
    if (s && s.length > maxN) maxN = s.length;
  }
  const N = nextPow2(Math.max(2, maxN));
  const half = N >> 1;
  const fs = siUs > 0 ? 1e6 / siUs : 1; // sample rate (Hz)

  const acc = new Float64Array(half); // running sum of per-trace amplitudes
  let nTraces = 0;
  for (let t = t0; t < t1; t++) {
    const s = traces[t];
    if (!s || s.length === 0) continue;
    const sp = amplitudeSpectrum(s, siUs);
    // amplitudeSpectrum pads to nextPow2(s.length); when that differs from the
    // common N its bins won't align, so resample its amp curve onto the common
    // half-length grid. When they match this is a cheap copy.
    const a = sp.amp.length === half ? sp.amp : resampleLinear(sp.amp, half);
    for (let k = 0; k < half; k++) acc[k] += a[k];
    nTraces++;
  }

  const amp = new Float32Array(half);
  const freqs = new Float32Array(half);
  const inv = nTraces > 0 ? 1 / nTraces : 1;
  for (let k = 0; k < half; k++) {
    amp[k] = acc[k] * inv;
    freqs[k] = (k * fs) / N;
  }
  return { freqs, amp, nyquist: fs / 2, nTraces };
}
