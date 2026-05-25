export interface GpsMessage {
  type: 'gps';
  lat: number;
  lon: number;
  alt: number;
  sats: number;
  fix: boolean;
  hdop: number;
  fixQ: number;
  age: number;
  nmea: string;
  gsa: string;
  rmc: string;
  dist2last: number | null;
  lastWPLat: number;
  lastWPLon: number;
  averaging: boolean;
  avgCount: number;
  avgTotal: number;
  avgDone: boolean;
  lastAvg: AvgResult | null;
  wpCount: number;
  ntripState: 'idle' | 'connecting' | 'streaming';
  ntripBytes: number;
  cfg: {
    line: number;
    sta: number;
    step: number;
    up: boolean;
    ant_h: number;
  };
}

export interface NmeaMessage {
  type: 'nmea';
  gga: string;
  gsa: string;
  rmc: string;
}

export interface AvgResult {
  label: string;
  lat: number;
  lon: number;
  alt: number;
  hdop: number;
  ts: string;
  next_line: number;
  next_sta: number;
}

export interface Waypoint {
  id: number;
  label: string;
  lat: number;
  lon: number;
  alt: number;
  hdop: number;
  fixQ: number;
  ts: string;
}

export interface NtripConfig {
  host: string;
  port: string;
  mnt: string;
  usr: string;
  pwd: string;
}

export interface UTMResult {
  zone: number;
  band: string;
  easting: number;
  northing: number;
  label: string;
}

export type WsStatus = 'connecting' | 'connected' | 'disconnected';
