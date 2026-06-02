export interface ShotRecord {
  id: number;
  ts: string;
  lat: number;
  lon: number;
  alt: number;
  hdop: number;
  fixQ: number;
  line: number;
  sp: number;
  bad?: boolean;
}

export interface ShotConfig {
  line: number;
  sp: number;
  step: number;
  debounce: number;
  edge: 'falling' | 'rising';
}
