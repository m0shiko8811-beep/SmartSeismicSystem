import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { Waypoint } from '../types/gps';
import { latLonToUTM, hdopToAccuracy, fixQualityName } from './calculations';

function timestamp(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}_${String(d.getHours()).padStart(2,'0')}${String(d.getMinutes()).padStart(2,'0')}`;
}

export function generateCSV(waypoints: Waypoint[]): string {
  const header = 'Label,Latitude,Longitude,Altitude_m,UTM_Zone,UTM_E,UTM_N,DateTime,Est_Acc_m,HDOP,Fix_Quality,Raw_GGA,Raw_GSA,Raw_RMC';
  const rows = waypoints.map(wp => {
    const utm = latLonToUTM(wp.lat, wp.lon);
    const acc = hdopToAccuracy(wp.hdop).toFixed(2);
    const fq = fixQualityName(wp.fixQ);
    return [
      wp.label, wp.lat.toFixed(7), wp.lon.toFixed(7), wp.alt.toFixed(2),
      utm.label, utm.easting, utm.northing,
      wp.ts, acc, wp.hdop.toFixed(2), fq,
      `"${wp.nmea}"`, `"${wp.gsa}"`, `"${wp.rmc}"`
    ].join(',');
  });
  return [header, ...rows].join('\n');
}

export function generateKML(waypoints: Waypoint[]): string {
  const placemarks = waypoints.map(wp => `  <Placemark>
    <name>${wp.label}</name>
    <description>Alt: ${wp.alt.toFixed(1)}m | HDOP: ${wp.hdop.toFixed(2)} | ${wp.ts}</description>
    <Point><coordinates>${wp.lon.toFixed(7)},${wp.lat.toFixed(7)},${wp.alt.toFixed(2)}</coordinates></Point>
  </Placemark>`).join('\n');
  const coords = waypoints.map(wp => `${wp.lon.toFixed(7)},${wp.lat.toFixed(7)},${wp.alt.toFixed(2)}`).join(' ');
  const line = waypoints.length > 1 ? `  <Placemark>
    <name>Survey Line</name>
    <LineString><altitudeMode>absolute</altitudeMode><coordinates>${coords}</coordinates></LineString>
  </Placemark>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
  <name>GPS Survey</name>
${placemarks}
${line}
</Document>
</kml>`;
}

export async function exportAndShare(waypoints: Waypoint[], format: 'csv' | 'kml'): Promise<void> {
  if (waypoints.length === 0) throw new Error('No waypoints to export');
  const ts = timestamp();
  const content = format === 'csv' ? generateCSV(waypoints) : generateKML(waypoints);
  const ext = format === 'csv' ? 'csv' : 'kml';
  const mime = format === 'csv' ? 'text/csv' : 'application/vnd.google-earth.kml+xml';
  const path = `${FileSystem.documentDirectory}survey_${ts}.${ext}`;
  await FileSystem.writeAsStringAsync(path, content, { encoding: FileSystem.EncodingType.UTF8 });
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(path, { mimeType: mime, dialogTitle: `Share survey_${ts}.${ext}` });
  } else {
    throw new Error('Sharing not available on this device');
  }
}
