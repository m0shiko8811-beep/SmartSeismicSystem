import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { PermissionsAndroid, Platform } from 'react-native';
import { BleManager, Device, State as BleState } from 'react-native-ble-plx';
import { GpsMessage, NmeaMessage, Waypoint, WsStatus } from '../types/gps';
import { appendWaypoint, clearWaypoints, loadWaypoints, saveWaypoints } from '../services/storage';

// ── BLE constants ─────────────────────────────────────
const SERVICE_UUID   = '12340000-0000-1000-8000-00805f9b34fb';
const GPS_CHAR_UUID  = '12340001-0000-1000-8000-00805f9b34fb';
const CMD_CHAR_UUID  = '12340002-0000-1000-8000-00805f9b34fb';
const RTCM_CHAR_UUID = '12340003-0000-1000-8000-00805f9b34fb';
const DEVICE_NAME    = 'GPS-Survey';

// Singleton manager — must not be recreated on re-render
const bleManager = new BleManager();

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

// GPS JSON and commands are pure ASCII — plain btoa/atob is sufficient
const b64encode = (str: string): string => btoa(str);
const b64decode = (b64: string): string => atob(b64);

interface GpsContextValue {
  gps: GpsMessage | null;
  bleStatus: WsStatus;
  waypoints: Waypoint[];
  sendCmd: (cmd: object) => void;
  saveWaypoint: (label: string) => Promise<boolean>;
  startAvg: (label: string) => void;
  cancelAvg: () => void;
  deleteAllWaypoints: () => Promise<void>;
  syncFromDevice: () => void;
  // kept for Settings NTRIP — sends a JSON command over BLE (no HTTP)
  sendNtripConfig: (config: { host: string; port: string; mnt: string; usr: string; pwd: string }) => void;
}

const GpsContext = createContext<GpsContextValue | null>(null);

export function GpsProvider({ children }: { children: React.ReactNode }) {
  const [gps, setGps]             = useState<GpsMessage | null>(null);
  const [bleStatus, setBleStatus] = useState<WsStatus>('disconnected');
  const [waypoints, setWaypoints] = useState<Waypoint[]>([]);

  const deviceRef      = useRef<Device | null>(null);
  const scanningRef    = useRef(false);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const monitorRef     = useRef<{ remove: () => void } | null>(null);

  // ── Send a JSON command over CMD_CHAR ──────────────
  const sendCmd = useCallback((cmd: object) => {
    const dev = deviceRef.current;
    if (!dev) return;
    dev.writeCharacteristicWithResponseForService(
      SERVICE_UUID, CMD_CHAR_UUID, b64encode(JSON.stringify(cmd))
    ).catch(e => console.log('[BLE] sendCmd error:', e));
  }, []);

  // ── Handle incoming GPS_CHAR notification ──────────
  const handleNotify = useCallback((b64: string) => {
    let json: string;
    try { json = b64decode(b64); } catch { return; }
    let msg: any;
    try { msg = JSON.parse(json); } catch { return; }

    if (msg.type === 'gps') {
      setGps(prev => ({ ...(prev ?? {}), ...msg } as GpsMessage));
    } else if (msg.type === 'nmea') {
      const nmea = msg as NmeaMessage;
      setGps(prev => prev ? { ...prev, nmea: nmea.gga, gsa: nmea.gsa, rmc: nmea.rmc } : prev);
    } else if (msg.type === 'wp') {
      // Waypoint received from device wp list sync
      const wp: Waypoint = {
        id:    msg.id ?? Date.now(),
        label: msg.label,
        lat:   msg.lat,  lon: msg.lon, alt: msg.alt,
        hdop:  msg.hdop, fixQ: msg.fixQ, ts: msg.ts,
      };
      setWaypoints(prev => {
        const idx = prev.findIndex(w => w.label === wp.label);
        let updated: Waypoint[];
        if (idx >= 0) {
          // Update existing entry with device's GPS timestamp and accuracy
          updated = [...prev];
          updated[idx] = { ...updated[idx], ts: wp.ts, hdop: wp.hdop, fixQ: wp.fixQ };
        } else {
          updated = [...prev, wp];
        }
        saveWaypoints(updated).catch(() => {});
        return updated;
      });
    }
    // wp_done: list complete — nothing extra needed
  }, []);

  // ── Connect to device and subscribe ───────────────
  const connectToDevice = useCallback(async (device: Device) => {
    try {
      setBleStatus('connecting');
      const connected = await device.connect();
      await connected.requestMTU(512);
      await connected.discoverAllServicesAndCharacteristics();
      deviceRef.current = connected;
      setBleStatus('connected');
      scanningRef.current = false;

      monitorRef.current = connected.monitorCharacteristicForService(
        SERVICE_UUID, GPS_CHAR_UUID,
        (err, char) => {
          if (err) { console.log('[BLE] monitor error:', err.message); return; }
          if (char?.value) handleNotify(char.value);
        }
      );

      // On disconnect: clean up and restart scan
      connected.onDisconnected(() => {
        monitorRef.current?.remove();
        monitorRef.current = null;
        deviceRef.current = null;
        setBleStatus('disconnected');
        setGps(null);
        console.log('[BLE] Disconnected — will rescan');
        reconnectTimer.current = setTimeout(startScan, 3000);
      });

    } catch (e) {
      console.log('[BLE] connect error:', e);
      setBleStatus('disconnected');
      reconnectTimer.current = setTimeout(startScan, 5000);
    }
  }, [handleNotify]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Start BLE scan ────────────────────────────────
  const startScan = useCallback(async () => {
    if (scanningRef.current || deviceRef.current) return;
    const granted = await requestBlePermissions();
    if (!granted) { console.log('[BLE] permissions denied'); return; }

    // Wait for BLE radio to be on
    const state = await bleManager.state();
    if (state !== BleState.PoweredOn) {
      bleManager.onStateChange(s => {
        if (s === BleState.PoweredOn) startScan();
      }, true);
      return;
    }

    scanningRef.current = true;
    setBleStatus('connecting');
    console.log('[BLE] Scanning for', DEVICE_NAME);

    bleManager.startDeviceScan([SERVICE_UUID], null, (err, device) => {
      if (err) { console.log('[BLE] scan error:', err); scanningRef.current = false; return; }
      if (device?.name === DEVICE_NAME) {
        bleManager.stopDeviceScan();
        scanningRef.current = false;
        connectToDevice(device);
      }
    });

    // Stop scan after 20 s if not found, retry
    setTimeout(() => {
      if (scanningRef.current) {
        bleManager.stopDeviceScan();
        scanningRef.current = false;
        setBleStatus('disconnected');
        reconnectTimer.current = setTimeout(startScan, 5000);
      }
    }, 20000);
  }, [connectToDevice]);

  useEffect(() => {
    loadWaypoints().then(setWaypoints);
    startScan();
    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      monitorRef.current?.remove();
      bleManager.stopDeviceScan();
      deviceRef.current?.cancelConnection().catch(() => {});
    };
  }, [startScan]);

  // ── Public API ────────────────────────────────────
  const saveWaypoint = useCallback(async (label: string): Promise<boolean> => {
    if (!gps?.fix) return false;
    const wp: Waypoint = {
      id: Date.now(), label,
      lat: gps.lat, lon: gps.lon, alt: gps.alt,
      hdop: gps.hdop, fixQ: gps.fixQ,
      ts: new Date().toISOString(),
    };
    const updated = await appendWaypoint(wp);
    setWaypoints(updated);
    sendCmd({ cmd: 'wp_save', label });
    return true;
  }, [gps, sendCmd]);

  const startAvg = useCallback((label: string) => {
    sendCmd({ cmd: 'avg_start', label });
  }, [sendCmd]);

  const cancelAvg = useCallback(() => {
    sendCmd({ cmd: 'avg_cancel' });
  }, [sendCmd]);

  const deleteAllWaypoints = useCallback(async () => {
    await clearWaypoints();
    setWaypoints([]);
    sendCmd({ cmd: 'wp_clear' });
  }, [sendCmd]);

  const syncFromDevice = useCallback(() => {
    sendCmd({ cmd: 'wp_list' });
  }, [sendCmd]);

  const sendNtripConfig = useCallback((cfg: { host: string; port: string; mnt: string; usr: string; pwd: string }) => {
    sendCmd({ cmd: 'ntrip_cfg', ...cfg });
  }, [sendCmd]);

  return (
    <GpsContext.Provider value={{
      gps, bleStatus, waypoints,
      sendCmd, saveWaypoint, startAvg, cancelAvg,
      deleteAllWaypoints, syncFromDevice, sendNtripConfig,
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
