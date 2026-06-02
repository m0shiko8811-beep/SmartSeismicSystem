import { Waypoint } from '../types/gps';
import { hdopToAccuracy } from './calculations';

export type QcIssueType = 'duplicate' | 'no_fix' | 'poor_accuracy' | 'station_gap';

export interface QcIssue {
  type: QcIssueType;
  label: string;
  detail: string;
}

export function qcCheck(waypoints: Waypoint[], maxAcc: number): QcIssue[] {
  const issues: QcIssue[] = [];
  const seen = new Map<string, number>();

  for (const wp of waypoints) {
    // Duplicate labels — report every occurrence after the first
    const prev = seen.get(wp.label);
    if (prev !== undefined) {
      issues.push({ type: 'duplicate', label: wp.label, detail: `Label used ${prev + 1} times` });
      seen.set(wp.label, prev + 1);
    } else {
      seen.set(wp.label, 1);
    }

    // No fix (fixQ=0)
    if (wp.fixQ === 0) {
      issues.push({ type: 'no_fix', label: wp.label, detail: 'Saved with no GPS fix (map-tap or no signal)' });
    }

    // Poor accuracy
    if (maxAcc > 0) {
      const acc = hdopToAccuracy(wp.hdop, wp.fixQ);
      if (acc > maxAcc) {
        issues.push({ type: 'poor_accuracy', label: wp.label, detail: `Accuracy ${acc.toFixed(1)} m exceeds filter ${maxAcc} m` });
      }
    }
  }

  // Station number gaps within each line
  const byLine = new Map<string, number[]>();
  for (const wp of waypoints) {
    const sep = wp.label.indexOf(':');
    if (sep < 0) continue;
    const line = wp.label.substring(0, sep);
    const sta  = parseInt(wp.label.substring(sep + 1));
    if (isNaN(sta)) continue;
    if (!byLine.has(line)) byLine.set(line, []);
    byLine.get(line)!.push(sta);
  }
  for (const [line, stations] of byLine) {
    const sorted = [...stations].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      const gap = sorted[i] - sorted[i - 1];
      if (gap > 1 && gap <= 20) {
        issues.push({
          type: 'station_gap',
          label: `${line}:${sorted[i - 1]}→${sorted[i]}`,
          detail: `Gap of ${gap} between stations`,
        });
      }
    }
  }

  return issues;
}
