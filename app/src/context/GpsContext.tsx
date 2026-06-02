import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { PermissionsAndroid, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { BleManager, Device, State as BleState } from 'react-native-ble-plx';
import { GpsMessage, GsvMessage, NmeaMessage, RefPoint, Waypoint, WsStatus } from '../types/gps';
import { ShotConfig, ShotRecord } from '../shots/types';
import { getAccSettings, setAccSettings } from '../services/storage';
import { appendLog } from '../services/activityLog';
import NtripClient from '../services/ntrip';
import { appendNmea } from '../services/nmeaLog';
import { StakeoutTarget, loadStakeout, saveStakeout, loadStakeoutIdx, saveStakeoutIdx, parseStakeoutCSV } from '../services/stakeout';
import { destinationPoint, bearing as calcBearing, haversineDist, parseGSV } from '../services/calculations';
import * as FileSystem from 'expo-file-system/legacy';
import { playShotSound } from '../services/sounds';

// ── BLE constants ─────────────────────────────────────
const SERVICE_UUID   = '12340000-0000-1000-8000-00805f9b34fb';
const GPS_CHAR_UUID  = '12340001-0000-1000-8000-00805f9b34fb';
const CMD_CHAR_UUID  = '12340002-0000-1000-8000-00805f9b34fb';
const RTCM_CHAR_UUID = '12340003-0000-1000-8000-00805f9b34fb';
const DEVICE_NAME    = 'GPS-Survey';

const bleManager = new BleManager();
const REQUIRED_CHAR_UUIDS = [GPS_CHAR_UUID, CMD_CHAR_UUID, RTCM_CHAR_UUID];

async function requestBlePermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  const api = Platform.Version as number;
  if (api >= 31) {
    const results = await PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
      PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
    ]);
    return Object.values(results).every(r => r === PermissionsAndroid.RESULTS.GRANTED);
  }
  const r = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION);
  return r === PermissionsAndroid.RESULTS.GRANTED;
}

const b64encode = (str: string): string => btoa(str);
const b64decode = (b64: string): string => atob(b64);

export type NtripConnState = 'idle' | 'connecting' | 'streaming' | 'error';

interface GpsContextValue {
  gps: GpsMessage | null;
  bleStatus: WsStatus;
  waypoints: Waypoint[];
  accFilterEnabled: boolean;
  setAccFilterEnabled: (v: boolean) => void;
  sendCmd: (cmd: object) => void;
  saveWaypoint: (label: string, lat?: number, lon?: number, notes?: string, photoUri?: string) => Promise<boolean>;
  startAvg: (label: string) => void;
  cancelAvg: () => void;
  deleteAllWaypoints: () => void;
  deleteLastWaypoints: (n: number) => void;
  syncFromDevice: () => void;
  sendNtripConfig: (config: { host: string; port: string; mnt: string; usr: string; pwd: string }) => void;
  ntripConnState: NtripConnState;
  ntripKB: number;
  ntripError: string | null;
  ntripRetryIn: number | null;
  startNtrip: (cfg: { host: string; port: string; mnt: string; usr: string; pwd: string }) => void;
  stopNtrip: () => void;
  mapTargetPos: { lat: number; lon: number } | null;
  setMapTargetPos: (pos: { lat: number; lon: number } | null) => void;
  avgResult: import('../types/gps').AvgResult | null;
  clearAvgResult: () => void;
  flaggedLabels: Set<string>;
  toggleFlag: (label: string) => void;
  deleteWaypointByLabel: (label: string) => void;
  voiceEnabled: boolean;
  setVoiceEnabled: (v: boolean) => void;
  sessionName: string;
  setSessionName: (name: string) => void;
  stakeoutTargets: StakeoutTarget[];
  stakeoutIdx: number;
  setStakeoutIdx: (i: number) => void;
  loadStakeoutFromCSV: (csv: string) => void;
  clearStakeout: () => void;
  refPoints: RefPoint[];
  loadRefPointsFromCSV: (csv: string) => void;
  clearRefPoints: () => void;
  ntripStreamingStartedAt: number | null;
  predictedNextPos: { lat: number; lon: number } | null;
  shots: ShotRecord[];
  shotCfg: ShotConfig;
  setShotCfg: (cfg: ShotConfig) => void;
  clearShots: () => void;
  deleteShot: (id: number) => void;
  markShotBad: (id: number, bad: boolean) => void;
  shotPlan: RefPoint[];
  loadShotPlanFromCSV: (csv: string) => void;
  clearShotPlan: () => void;
}

const GpsContext = createContext<GpsContextValue | null>(null);

export function GpsProvider({ children }: { children: React.ReactNode }) {
  const [gps, setGps]                       = useState<GpsMessage | null>(null);
  const [bleStatus, setBleStatus]           = useState<WsStatus>('disconnected');
  const [waypoints, setWaypoints]           = useState<Waypoint[]>([]);
  const [accFilterEnabled, setAccFilterState] = useState(true);
  const [ntripConnState, setNtripConnState] = useState<NtripConnState>('idle');
  const [ntripKB, setNtripKB]               = useState(0);
  const [ntripError, setNtripError]         = useState<string | null>(null);
  const [ntripRetryIn, setNtripRetryIn]     = useState<number | null>(null);
  const [flaggedLabels, setFlaggedLabels]   = useState<Set<string>>(new Set());
  const [mapTargetPos, setMapTargetPos]     = useState<{ lat: number; lon: number } | null>(null);
  const [avgResult, setAvgResult]           = useState<import('../types/gps').AvgResult | null>(null);
  const [voiceEnabled, setVoiceEnabledState] = useState(true);
  const [sessionName, setSessionNameState]  = useState('');
  const [stakeoutTargets, setStakeoutTargets] = useState<StakeoutTarget[]>([]);
  const [stakeoutIdx, setStakeoutIdxState]  = useState(0);
  const [refPoints, setRefPoints]           = useState<RefPoint[]>([]);
  const [ntripStreamingStartedAt, setNtripStreamingStartedAt] = useState<number | null>(null);
  const [shots, setShots]                   = useState<ShotRecord[]>([]);
  const [shotCfg, setShotCfgState]          = useState<ShotConfig>({ line: 1001, sp: 1, step: 1, debounce: 500, edge: 'falling' });
  const [shotPlan, setShotPlan]             = useState<RefPoint[]>([]);

  const waypointsRef   = useRef<Waypoint[]>([]);
  waypointsRef.current = waypoints;
  const sessionNameRef = useRef(sessionName);
  sessionNameRef.current = sessionName;

  const deviceRef        = useRef<Device | null>(null);
  const scanningRef      = useRef(false);
  const connectingRef    = useRef(false);
  const reconnectTimer   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelayMs = useRef(1000);
  const monitorRef       = useRef<{ remove: () => void } | null>(null);
  const ntripRef          = useRef<NtripClient | null>(null);
  const ntripBytesRef     = useRef(0);
  const ntripCfgRef       = useRef<{ host: string; port: string; mnt: string; usr: string; pwd: string } | null>(null);
  const ntripRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ntripRetryDelayRef = useRef(5000);
  const ntripRetryCountRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const latestGgaRef     = useRef<string | null>(null);
  const prevFixRef       = useRef<boolean | null>(null);
  const prevFixQRef      = useRef<number>(-1);
  const stableFixQRef    = useRef<number>(-1);
  const rawFixQRef       = useRef<number>(-1);
  const fixQDropTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Persist accFilterEnabled ───────────────────────
  const setAccFilterEnabled = useCallback((v: boolean) => {
    setAccFilterState(v);
    getAccSettings().then(({ minAcc, maxAcc }) =>
      setAccSettings(minAcc, maxAcc, v).catch(() => {})
    );
  }, []);

  const setVoiceEnabled = useCallback((v: boolean) => {
    setVoiceEnabledState(v);
    AsyncStorage.setItem('voice_enabled', String(v)).catch(() => {});
  }, []);

  const setSessionName = useCallback((name: string) => {
    setSessionNameState(name);
    AsyncStorage.setItem('session_name', name).catch(() => {});
  }, []);

  const setStakeoutIdx = useCallback((i: number) => {
    setStakeoutIdxState(i);
    saveStakeoutIdx(i).catch(() => {});
  }, []);

  const loadStakeoutFromCSV = useCallback((csv: string) => {
    const targets = parseStakeoutCSV(csv);
    setStakeoutTargets(targets);
    setStakeoutIdxState(0);
    saveStakeout(targets).catch(() => {});
    saveStakeoutIdx(0).catch(() => {});
  }, []);

  const clearStakeout = useCallback(() => {
    setStakeoutTargets([]);
    setStakeoutIdxState(0);
    saveStakeout([]).catch(() => {});
    saveStakeoutIdx(0).catch(() => {});
  }, []);

  const loadRefPointsFromCSV = useCallback((csv: string) => {
    const lines = csv.trim().split(/\r?\n/);
    const pts: RefPoint[] = [];
    for (const line of lines) {
      const parts = line.split(',').map(p => p.trim().replace(/^["']|["']$/g, ''));
      if (parts.length < 3) continue;
      const lat = parseFloat(parts[1]), lon = parseFloat(parts[2]);
      if (!isFinite(lat) || !isFinite(lon)) continue;
      pts.push({ label: parts[0] || `R${pts.length + 1}`, lat, lon });
    }
    setRefPoints(pts);
    AsyncStorage.setItem('ref_points', JSON.stringify(pts)).catch(() => {});
  }, []);

  const clearRefPoints = useCallback(() => {
    setRefPoints([]);
    AsyncStorage.removeItem('ref_points').catch(() => {});
  }, []);

  // ── Predicted next station position ───────────────
  const predictedNextPos = React.useMemo(() => {
    if (waypoints.length < 2) return null;
    // Find the two most recent waypoints from the same line
    const lineMap = new Map<string, { wp: Waypoint; sta: number }[]>();
    for (const wp of waypoints) {
      const sep = wp.label.indexOf(':');
      if (sep < 0) continue;
      const line = wp.label.substring(0, sep);
      const sta  = parseInt(wp.label.substring(sep + 1));
      if (isNaN(sta)) continue;
      if (!lineMap.has(line)) lineMap.set(line, []);
      lineMap.get(line)!.push({ wp, sta });
    }
    // Pick the line with the most recent saved point
    let bestLine: { wp: Waypoint; sta: number }[] | null = null;
    let bestLastId = -1;
    for (const pts of lineMap.values()) {
      if (pts.length < 2) continue;
      const maxId = Math.max(...pts.map(p => p.wp.id));
      if (maxId > bestLastId) { bestLastId = maxId; bestLine = pts; }
    }
    if (!bestLine || bestLine.length < 2) return null;
    const sorted = [...bestLine].sort((a, b) => a.sta - b.sta);
    const a = sorted[sorted.length - 2].wp;
    const b = sorted[sorted.length - 1].wp;
    const brg  = calcBearing(a.lat, a.lon, b.lat, b.lon);
    const dist = haversineDist(a.lat, a.lon, b.lat, b.lon);
    if (dist < 0.5) return null;
    return destinationPoint(b.lat, b.lon, brg, dist);
  }, [waypoints]);

  // ── Send JSON command over CMD_CHAR ────────────────
  const sendCmd = useCallback((cmd: object) => {
    const dev = deviceRef.current;
    if (!dev) return;
    dev.writeCharacteristicWithResponseForService(
      SERVICE_UUID, CMD_CHAR_UUID, b64encode(JSON.stringify(cmd))
    ).catch(e => { if (__DEV__) console.log('[BLE] sendCmd error:', e); });
  }, []);

  // ── Write RTCM chunk over BLE ──────────────────────
  const writeRtcm = useCallback((chunk: Uint8Array) => {
    const dev = deviceRef.current;
    if (!dev) return;
    const b64 = btoa(String.fromCharCode(...chunk));
    dev.writeCharacteristicWithoutResponseForService(
      SERVICE_UUID, RTCM_CHAR_UUID, b64
    ).catch(() => {});
  }, []);

  // ── Handle incoming GPS_CHAR notification ──────────
  const handleNotify = useCallback((b64: string) => {
    let json: string;
    try { json = b64decode(b64); } catch { return; }
    let msg: any;
    try { msg = JSON.parse(json); } catch { return; }

    if (msg.type === 'gps') {
      const rawQ: number = typeof msg.fixQ === 'number' ? msg.fixQ : 0;
      rawFixQRef.current = rawQ;

      // Fix acquire / loss resets debounce state
      if (prevFixRef.current !== msg.fix) {
        prevFixRef.current = msg.fix;
        prevFixQRef.current = -1;
        stableFixQRef.current = msg.fix ? rawQ : -1;
        if (fixQDropTimerRef.current) { clearTimeout(fixQDropTimerRef.current); fixQDropTimerRef.current = null; }
        if (msg.fix) void appendLog('gps_fix_acquired', { sats: msg.sats, fixQ: rawQ, hdop: msg.hdop });
        else          void appendLog('gps_fix_lost');
      }

      if (msg.fix) {
        if (rawQ >= stableFixQRef.current) {
          // Upward or same — cancel any pending drop timer, commit immediately
          if (fixQDropTimerRef.current) { clearTimeout(fixQDropTimerRef.current); fixQDropTimerRef.current = null; }
          stableFixQRef.current = rawQ;
        } else if (!fixQDropTimerRef.current) {
          // Downward drop — wait 2 s before accepting; NEO-M9N briefly pulses 0 between RTCM epochs
          fixQDropTimerRef.current = setTimeout(() => {
            fixQDropTimerRef.current = null;
            const settled = rawFixQRef.current;
            if (settled !== stableFixQRef.current) {
              stableFixQRef.current = settled;
              if (prevFixQRef.current !== settled) {
                prevFixQRef.current = settled;
                void appendLog('gps_fixq_change', { fixQ: settled, hdop: 0 });
              }
              setGps(prev => prev ? { ...prev, fixQ: settled } : prev);
            }
          }, 2000);
        }
        // Log whenever stable fixQ changes (upward changes land here immediately)
        if (stableFixQRef.current !== prevFixQRef.current) {
          prevFixQRef.current = stableFixQRef.current;
          void appendLog('gps_fixq_change', { fixQ: stableFixQRef.current, hdop: msg.hdop });
        }
      }

      setGps(prev => ({
        ...(prev ?? {}), ...msg,
        fixQ: msg.fix ? stableFixQRef.current : rawQ,
      } as GpsMessage));
      // Sync shot config when device reports it
      if (msg.shot_cfg) {
        const c = msg.shot_cfg;
        setShotCfgState(prev =>
          prev.line === c.line && prev.sp === c.sp && prev.step === c.step &&
          prev.debounce === c.debounce && prev.edge === c.edge
            ? prev : { ...prev, ...c }
        );
      }
    } else if (msg.type === 'avg_done') {
      // Add averaged waypoint to local list immediately — don't wait for firmware wp flush
      const avgWp: Waypoint = {
        id:    Date.now(),
        label: msg.label,
        lat:   msg.lat, lon: msg.lon, alt: msg.alt,
        hdop:  msg.hdop,
        fixQ:  stableFixQRef.current >= 0 ? stableFixQRef.current : 0,
        ts:    msg.ts,
        session: sessionNameRef.current || undefined,
      };
      setWaypoints(prev =>
        prev.some(w => w.label === avgWp.label) ? prev : [...prev, avgWp]
      );
      // Use dedicated state — never reset by GPS JSON, so effect fires reliably
      setAvgResult({
        label:     msg.label,
        lat:       msg.lat,
        lon:       msg.lon,
        alt:       msg.alt,
        hdop:      msg.hdop,
        ts:        msg.ts,
        next_line: msg.next_line,
        next_sta:  msg.next_sta,
      });
      void appendLog('avg_done_rcvd', { label: msg.label, lat: msg.lat, lon: msg.lon, hdop: msg.hdop });
    } else if (msg.type === 'nmea') {
      const nmea = msg as NmeaMessage;
      latestGgaRef.current = nmea.gga;
      void appendNmea(nmea.gga, nmea.gsa, nmea.rmc);
      setGps(prev => prev ? { ...prev, nmea: nmea.gga, gsa: nmea.gsa, rmc: nmea.rmc } : prev);
    } else if (msg.type === 'gsv') {
      const gsv = msg as GsvMessage;
      const sats = parseGSV(gsv.sentences);
      setGps(prev => prev ? { ...prev, satellites: sats } : prev);
    } else if (msg.type === 'dbg') {
      void appendLog('esp32_dbg', { msg: msg.msg });
    } else if (msg.type === 'wp_done') {
      void appendLog('wp_list_synced', { count: msg.count });
    } else if (msg.type === 'wp') {
      const wp: Waypoint = {
        id:    msg.id ?? Date.now(),
        label: msg.label,
        lat:   msg.lat, lon: msg.lon, alt: msg.alt,
        hdop:  msg.hdop, fixQ: msg.fixQ, ts: msg.ts,
      };
      setWaypoints(prev => {
        const idx = prev.findIndex(w => w.label === wp.label);
        if (idx >= 0) {
          const updated = [...prev];
          updated[idx] = { ...updated[idx], ts: wp.ts, hdop: wp.hdop, fixQ: wp.fixQ };
          return updated;
        }
        return [...prev, wp];
      });
    } else if (msg.type === 'shot') {
      const shot: ShotRecord = {
        id: msg.id, ts: msg.ts,
        lat: msg.lat, lon: msg.lon, alt: msg.alt,
        hdop: msg.hdop, fixQ: msg.fixQ,
        line: msg.line, sp: msg.sp,
      };
      setShots(prev => prev.some(s => s.id === shot.id) ? prev : [...prev, shot]);
      playShotSound();
    } else if (msg.type === 'shot_done') {
      void appendLog('shot_list_synced', { count: msg.count });
    }
  }, []);

  const scheduleReconnect = useCallback(() => {
    connectingRef.current = false;
    // Cancel any pending reconnect before scheduling a new one — prevents storm
    if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    const delay = reconnectDelayMs.current;
    reconnectDelayMs.current = Math.min(delay * 2, 60000);
    void appendLog('ble_reconnect', { delayMs: delay });
    reconnectTimer.current = setTimeout(startScan, delay);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Connect to device and subscribe ───────────────
  const connectToDevice = useCallback(async (device: Device) => {
    // Guard: only one connection attempt at a time
    if (connectingRef.current || deviceRef.current) return;
    connectingRef.current = true;
    try {
      setBleStatus('connecting');
      void appendLog('ble_device_found', { name: device.name ?? 'unknown' });
      const connected = await device.connect();
      await connected.requestMTU(512);
      await connected.discoverAllServicesAndCharacteristics();

      // Verify expected characteristics exist before trusting this device
      const chars = await connected.characteristicsForService(SERVICE_UUID);
      const foundUUIDs = chars.map(c => c.uuid.toLowerCase());
      const allPresent = REQUIRED_CHAR_UUIDS.every(u => foundUUIDs.includes(u.toLowerCase()));
      if (!allPresent) {
        if (__DEV__) console.log('[BLE] Rejected device — missing required characteristics');
        await connected.cancelConnection().catch(() => {});
        setBleStatus('disconnected');
        scheduleReconnect();
        return;
      }

      deviceRef.current = connected;
      connectingRef.current = false;
      setBleStatus('connected');
      reconnectDelayMs.current = 1000; // reset backoff on successful connect
      scanningRef.current = false;
      void appendLog('ble_connected', { device: DEVICE_NAME });

      monitorRef.current = connected.monitorCharacteristicForService(
        SERVICE_UUID, GPS_CHAR_UUID,
        (err, char) => {
          if (err) { if (__DEV__) console.log('[BLE] monitor error:', err.message); return; }
          if (char?.value) handleNotify(char.value);
        }
      );

      // Firmware auto-flushes wp list on connect but races the subscription setup.
      // Request explicitly after 1s when we are guaranteed to receive notifications.
      setTimeout(() => {
        if (deviceRef.current) {
          deviceRef.current.writeCharacteristicWithResponseForService(
            SERVICE_UUID, CMD_CHAR_UUID, b64encode(JSON.stringify({ cmd: 'wp_list' }))
          ).catch(() => {});
        }
      }, 1000);

      connected.onDisconnected(() => {
        monitorRef.current?.remove();
        monitorRef.current = null;
        deviceRef.current = null;
        connectingRef.current = false;
        setBleStatus('disconnected');
        setGps(null);
        setAvgResult(null);
        stableFixQRef.current = -1;
        rawFixQRef.current = -1;
        if (fixQDropTimerRef.current) { clearTimeout(fixQDropTimerRef.current); fixQDropTimerRef.current = null; }
        void appendLog('ble_disconnected');
        if (__DEV__) console.log('[BLE] Disconnected — will rescan');
        scheduleReconnect();
      });

    } catch (e) {
      if (__DEV__) console.log('[BLE] connect error:', e);
      connectingRef.current = false;
      setBleStatus('disconnected');
      scheduleReconnect();
    }
  }, [handleNotify, scheduleReconnect]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Start BLE scan ────────────────────────────────
  const startScan = useCallback(async () => {
    if (scanningRef.current || deviceRef.current) return;
    const granted = await requestBlePermissions();
    if (!granted) { if (__DEV__) console.log('[BLE] permissions denied'); return; }

    const state = await bleManager.state();
    if (state !== BleState.PoweredOn) {
      bleManager.onStateChange(s => { if (s === BleState.PoweredOn) startScan(); }, true);
      return;
    }

    scanningRef.current = true;
    setBleStatus('connecting');
    void appendLog('ble_scan_start');

    bleManager.startDeviceScan([SERVICE_UUID], null, (err, device) => {
      if (err) { scanningRef.current = false; return; }
      if (device?.name === DEVICE_NAME) {
        bleManager.stopDeviceScan();
        scanningRef.current = false;
        connectToDevice(device);
      }
    });

    setTimeout(() => {
      if (scanningRef.current) {
        bleManager.stopDeviceScan();
        scanningRef.current = false;
        setBleStatus('disconnected');
        scheduleReconnect();
      }
    }, 20000);
  }, [connectToDevice, scheduleReconnect]);

  useEffect(() => {
    void appendLog('app_start');
    getAccSettings().then(({ accFilterEnabled }) => setAccFilterState(accFilterEnabled));
    AsyncStorage.getItem('flagged_waypoints').then(v => {
      if (v) { try { setFlaggedLabels(new Set(JSON.parse(v))); } catch {} }
    });
    AsyncStorage.getItem('voice_enabled').then(v => { if (v != null) setVoiceEnabledState(v !== 'false'); });
    AsyncStorage.getItem('session_name').then(v => { if (v) setSessionNameState(v); });
    loadStakeout().then(t => { if (t.length) setStakeoutTargets(t); });
    loadStakeoutIdx().then(setStakeoutIdxState);
    AsyncStorage.getItem('ref_points').then(v => {
      if (v) { try { setRefPoints(JSON.parse(v)); } catch {} }
    });
    AsyncStorage.getItem('shot_plan').then(v => {
      if (v) { try { setShotPlan(JSON.parse(v)); } catch (e) { void appendLog('shot_plan_parse_error', { error: String(e) }); } }
    });
    startScan();
    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      monitorRef.current?.remove();
      bleManager.stopDeviceScan();
      deviceRef.current?.cancelConnection().catch(() => {});
      ntripRef.current?.disconnect();
    };
  }, [startScan]);

  // ── NTRIP retry countdown ticker ──────────────────
  const startRetryCountdown = useCallback((delayMs: number) => {
    if (ntripRetryCountRef.current) clearInterval(ntripRetryCountRef.current);
    let remaining = Math.ceil(delayMs / 1000);
    setNtripRetryIn(remaining);
    ntripRetryCountRef.current = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        clearInterval(ntripRetryCountRef.current!);
        ntripRetryCountRef.current = null;
        setNtripRetryIn(null);
      } else {
        setNtripRetryIn(remaining);
      }
    }, 1000);
  }, []);

  // ── NTRIP client ───────────────────────────────────
  const startNtrip = useCallback((cfg: { host: string; port: string; mnt: string; usr: string; pwd: string }) => {
    // Clear any pending retry
    if (ntripRetryTimerRef.current) { clearTimeout(ntripRetryTimerRef.current); ntripRetryTimerRef.current = null; }
    if (ntripRetryCountRef.current) { clearInterval(ntripRetryCountRef.current); ntripRetryCountRef.current = null; }
    setNtripRetryIn(null);

    ntripRef.current?.disconnect();
    ntripCfgRef.current = cfg;         // remember for auto-reconnect
    ntripRetryDelayRef.current = 5000; // reset backoff on fresh user-initiated connect
    ntripBytesRef.current = 0;
    setNtripKB(0);
    setNtripError(null);
    setNtripConnState('connecting');
    void appendLog('ntrip_start', { host: cfg.host, mnt: cfg.mnt });

    const scheduleRetry = (reason: string) => {
      if (!ntripCfgRef.current) return; // user stopped — no retry
      const delay = ntripRetryDelayRef.current;
      ntripRetryDelayRef.current = Math.min(delay * 2, 60000);
      void appendLog('ntrip_retry_sched', { delaySec: Math.round(delay / 1000), reason });
      setNtripConnState('connecting');
      startRetryCountdown(delay);
      ntripRetryTimerRef.current = setTimeout(() => {
        ntripRetryTimerRef.current = null;
        if (ntripCfgRef.current) startNtrip(ntripCfgRef.current);
      }, delay);
    };

    const client = new NtripClient({
      host:       cfg.host,
      port:       parseInt(cfg.port, 10) || 2101,
      mountpoint: cfg.mnt,
      username:   cfg.usr,
      password:   cfg.pwd,
      onTcpConnected: () => {
        void appendLog('ntrip_tcp_connected', { host: cfg.host, port: cfg.port });
      },
      onRequestSent: () => {
        void appendLog('ntrip_request_sent', { host: cfg.host, mnt: cfg.mnt });
      },
      onServerData: (preview: string) => {
        void appendLog('ntrip_server_data', { preview });
      },
      onConnected: () => {
        ntripRetryDelayRef.current = 5000; // reset backoff on success
        setNtripConnState('streaming');
        setNtripStreamingStartedAt(Date.now());
        void appendLog('ntrip_connected', { host: cfg.host, mnt: cfg.mnt });
      },
      onRtcm: (chunk) => {
        writeRtcm(chunk);
        const prevBytes = ntripBytesRef.current;
        ntripBytesRef.current += chunk.length;
        setNtripKB(ntripBytesRef.current / 1024);
        const prevKb = Math.floor(prevBytes / (100 * 1024));
        const curKb  = Math.floor(ntripBytesRef.current / (100 * 1024));
        if (curKb > prevKb) void appendLog('ntrip_kb100', { kb: Math.round(ntripBytesRef.current / 1024) });
      },
      onError: (err) => {
        if (__DEV__) console.log('[NTRIP] error:', err);
        setNtripError(err);
        setNtripStreamingStartedAt(null);
        void appendLog('ntrip_error', { err });
        scheduleRetry(err);
      },
      onDisconnected: () => {
        setNtripStreamingStartedAt(null);
        void appendLog('ntrip_disconnected');
        scheduleRetry('connection closed');
      },
      getGga: () => latestGgaRef.current,
    });
    ntripRef.current = client;
    client.connect();
  }, [writeRtcm, startRetryCountdown]); // eslint-disable-line react-hooks/exhaustive-deps

  const stopNtrip = useCallback(() => {
    ntripCfgRef.current = null;        // prevent auto-reconnect
    if (ntripRetryTimerRef.current) { clearTimeout(ntripRetryTimerRef.current); ntripRetryTimerRef.current = null; }
    if (ntripRetryCountRef.current) { clearInterval(ntripRetryCountRef.current); ntripRetryCountRef.current = null; }
    setNtripRetryIn(null);
    ntripRef.current?.disconnect();
    ntripRef.current = null;
    setNtripConnState('idle');
    setNtripError(null);
    setNtripKB(0);
    setNtripStreamingStartedAt(null);
    ntripBytesRef.current = 0;
    void appendLog('ntrip_stopped');
  }, []);

  const clearAvgResult = useCallback(() => setAvgResult(null), []);

  const toggleFlag = useCallback((label: string) => {
    setFlaggedLabels(prev => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label); else next.add(label);
      AsyncStorage.setItem('flagged_waypoints', JSON.stringify([...next])).catch(() => {});
      return next;
    });
  }, []);

  const deleteWaypointByLabel = useCallback((label: string) => {
    const wp = waypointsRef.current.find(w => w.label === label);
    if (wp) sendCmd({ cmd: 'wp_delete', id: wp.id });
    setWaypoints(prev => prev.filter(w => w.label !== label));
    void appendLog('wp_deleted', { label });
  }, [sendCmd]);

  // ── Public API ────────────────────────────────────
  const saveWaypoint = useCallback(async (label: string, lat?: number, lon?: number, notes?: string, photoUri?: string): Promise<boolean> => {
    // Copy photo to permanent storage if provided
    let storedPhotoUri: string | undefined;
    if (photoUri) {
      const safeLabel = label.replace(/[^a-zA-Z0-9_\-]/g, '_');
      const dest = `${FileSystem.documentDirectory}photo_${safeLabel}_${Date.now()}.jpg`;
      try { await FileSystem.copyAsync({ from: photoUri, to: dest }); storedPhotoUri = dest; } catch { storedPhotoUri = undefined; }
    }
    if (lat !== undefined && lon !== undefined) {
      const wp: Waypoint = {
        id: Date.now(), label,
        lat, lon, alt: 0,
        hdop: 99, fixQ: 0,
        ts: new Date().toISOString(),
        session: sessionName || undefined,
        notes: notes || undefined,
        photoUri: storedPhotoUri,
      };
      setWaypoints(prev => [...prev, wp]);
      sendCmd({ cmd: 'wp_save_at', label, lat, lon, alt: 0, hdop: 99.0 });
      void appendLog('wp_saved_at', { label, lat, lon });
      setMapTargetPos(null);
      return true;
    }
    if (!gps?.fix) return false;
    const wp: Waypoint = {
      id: Date.now(), label,
      lat: gps.lat, lon: gps.lon, alt: gps.alt,
      hdop: gps.hdop, fixQ: gps.fixQ,
      ts: new Date().toISOString(),
      session: sessionName || undefined,
      notes: notes || undefined,
      photoUri: storedPhotoUri,
    };
    setWaypoints(prev => [...prev, wp]);
    sendCmd({ cmd: 'wp_save', label });
    void appendLog('wp_saved', { label, lat: gps.lat, lon: gps.lon, fixQ: gps.fixQ });
    return true;
  }, [gps, sendCmd, sessionName]);

  const startAvg = useCallback((label: string) => {
    sendCmd({ cmd: 'avg_start', label });
    void appendLog('avg_started', { label });
  }, [sendCmd]);

  const cancelAvg = useCallback(() => {
    sendCmd({ cmd: 'avg_cancel' });
    void appendLog('avg_cancelled');
  }, [sendCmd]);

  const deleteAllWaypoints = useCallback(() => {
    setWaypoints([]);
    sendCmd({ cmd: 'wp_clear' });
    void appendLog('wp_cleared');
  }, [sendCmd]);

  const deleteLastWaypoints = useCallback((n: number) => {
    if (n <= 0) return;
    setWaypoints(prev => prev.slice(0, Math.max(0, prev.length - n)));
    sendCmd({ cmd: 'wp_delete_last', n });
    void appendLog('wp_retake', { n });
  }, [sendCmd]);

  const syncFromDevice = useCallback(() => {
    setWaypoints([]);
    sendCmd({ cmd: 'wp_list' });
  }, [sendCmd]);

  const sendNtripConfig = useCallback((cfg: { host: string; port: string; mnt: string; usr: string; pwd: string }) => {
    sendCmd({ cmd: 'ntrip_cfg', ...cfg });
    void appendLog('ntrip_sent', { host: cfg.host, mnt: cfg.mnt });
  }, [sendCmd]);

  const setShotCfg = useCallback((cfg: ShotConfig) => {
    setShotCfgState(cfg);
    sendCmd({ shot_cfg: true, line: cfg.line, sp: cfg.sp, step: cfg.step, debounce: cfg.debounce, edge: cfg.edge });
  }, [sendCmd]);

  const clearShots = useCallback(() => {
    setShots([]);
    sendCmd({ shot_clear: true });
    void appendLog('shot_cleared');
  }, [sendCmd]);

  const deleteShot = useCallback((id: number) => {
    sendCmd({ shot_delete: true, id });
    // Firmware deletes the shot and renumbers the remaining ids to 1..n by
    // position. Mirror that exactly so app and device ids stay in lockstep
    // (otherwise the next delete would hit the wrong shot), while keeping any
    // local flags (e.g. `bad`) on the surviving records.
    setShots(prev => prev.filter(s => s.id !== id).map((s, i) => ({ ...s, id: i + 1 })));
  }, [sendCmd]);

  const markShotBad = useCallback((id: number, bad: boolean) => {
    setShots(prev => prev.map(s => s.id === id ? { ...s, bad } : s));
  }, []);

  const loadShotPlanFromCSV = useCallback((csv: string) => {
    const lines = csv.trim().split(/\r?\n/);
    const pts: RefPoint[] = [];
    for (const line of lines) {
      const parts = line.split(',').map(p => p.trim().replace(/^["']|["']$/g, ''));
      if (parts.length < 3) continue;
      const lat = parseFloat(parts[1]), lon = parseFloat(parts[2]);
      if (!isFinite(lat) || !isFinite(lon)) continue;
      pts.push({ label: parts[0] || `SP${pts.length + 1}`, lat, lon });
    }
    setShotPlan(pts);
    AsyncStorage.setItem('shot_plan', JSON.stringify(pts)).catch(() => {});
  }, []);

  const clearShotPlan = useCallback(() => {
    setShotPlan([]);
    AsyncStorage.removeItem('shot_plan').catch(() => {});
  }, []);

  return (
    <GpsContext.Provider value={{
      gps, bleStatus, waypoints,
      accFilterEnabled, setAccFilterEnabled,
      sendCmd, saveWaypoint, startAvg, cancelAvg,
      deleteAllWaypoints, deleteLastWaypoints,
      syncFromDevice, sendNtripConfig,
      ntripConnState, ntripKB, ntripError, ntripRetryIn, startNtrip, stopNtrip,
      mapTargetPos, setMapTargetPos,
      avgResult, clearAvgResult,
      flaggedLabels, toggleFlag, deleteWaypointByLabel,
      voiceEnabled, setVoiceEnabled,
      sessionName, setSessionName,
      stakeoutTargets, stakeoutIdx, setStakeoutIdx,
      loadStakeoutFromCSV, clearStakeout,
      refPoints, loadRefPointsFromCSV, clearRefPoints,
      ntripStreamingStartedAt,
      predictedNextPos,
      shots, shotCfg, setShotCfg, clearShots, deleteShot, markShotBad,
      shotPlan, loadShotPlanFromCSV, clearShotPlan,
    }}>
      {children}
    </GpsContext.Provider>
  );
}

export function useGps() {
  const ctx = useContext(GpsContext);
  if (!ctx) throw new Error('useGps must be inside GpsProvider');
  return ctx;
}
