import TcpSocket from 'react-native-tcp-socket';

interface NtripConfig {
  host: string;
  port: number;
  mountpoint: string;
  username: string;
  password: string;
  onConnected: () => void;
  onRtcm: (chunk: Uint8Array) => void;
  onError: (err: string) => void;
  onDisconnected: () => void;
  onTcpConnected?: () => void;
  onRequestSent?: () => void;
  onServerData?: (preview: string) => void;
  getGga: () => string | null;
}

const MAX_BLE_CHUNK    = 500;
const GGA_INTERVAL_MS  = 5000;
const MAX_SESSION_BYTES = 200 * 1024 * 1024; // 200 MB safety limit

export default class NtripClient {
  private cfg: NtripConfig;
  private socket: ReturnType<typeof TcpSocket.createConnection> | null = null;
  private alive = false;
  private ggaTimer: ReturnType<typeof setInterval> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private headerDone = false;
  private pendingBuf: number[] = [];
  private sessionBytes = 0;

  constructor(cfg: NtripConfig) {
    this.cfg = cfg;
  }

  connect() {
    this.alive = true;
    this.headerDone = false;
    this.pendingBuf = [];
    this.sessionBytes = 0;

    // 15-second timeout: fire onError if no server response arrives
    this.connectTimer = setTimeout(() => {
      if (this.alive && !this.headerDone) {
        this.cfg.onError('NTRIP timeout: no server response in 15s (check host/port/network)');
        this.disconnect();
      }
    }, 15000);

    const auth = btoa(`${this.cfg.username}:${this.cfg.password}`);
    const request = [
      `GET /${this.cfg.mountpoint} HTTP/1.1`,
      `Host: ${this.cfg.host}`,
      `User-Agent: NTRIP RNClient/1.0`,
      `Authorization: Basic ${auth}`,
      `Ntrip-Version: Ntrip/1.0`,
      `Connection: close`,
      ``,
      ``,
    ].join('\r\n');

    this.socket = TcpSocket.createConnection(
      { host: this.cfg.host, port: this.cfg.port, noDelay: true } as any,
      () => {
        this.cfg.onTcpConnected?.();
        // Use write callback to confirm data was handed to the kernel
        this.socket!.write(request, 'utf8', (err?: Error) => {
          if (!this.alive) return;
          if (err) {
            this.cfg.onError(`NTRIP write failed: ${err.message}`);
            this.disconnect();
          } else {
            this.cfg.onRequestSent?.();
          }
        });
      }
    );

    this.socket.on('data', (data: any) => {
      if (!this.alive) return;
      // Normalize to number array for easy processing
      const arr: number[] = typeof data === 'string'
        ? Array.from(data, (c: string) => c.charCodeAt(0))
        : Array.from(data as Uint8Array);

      if (this.headerDone) {
        this._dispatch(arr);
        return;
      }

      // Log first server response for diagnostics
      if (this.pendingBuf.length === 0 && arr.length > 0) {
        const preview = arr.slice(0, 40).map(b =>
          b >= 32 && b < 127 ? String.fromCharCode(b) : `\\x${b.toString(16).padStart(2,'0')}`
        ).join('');
        this.cfg.onServerData?.(preview);
      }

      // Accumulate until we find the end of headers
      for (const b of arr) this.pendingBuf.push(b);
      const parsed = this._parseHeader(this.pendingBuf);
      if (!parsed) return;

      const { header, restStart } = parsed;
      const rest = this.pendingBuf.slice(restStart);
      this.pendingBuf = [];

      const firstLine = header.split('\r\n')[0].trim();
      const ok = firstLine === 'ICY 200 OK' ||
                 /^HTTP\/\d+\.\d+ 200/.test(firstLine);
      if (!ok) {
        const msg = firstLine.startsWith('SOURCETABLE')
          ? 'Mountpoint not found or base station offline (caster returned source table)'
          : `NTRIP rejected: ${firstLine}`;
        this.cfg.onError(msg);
        this.disconnect();
        return;
      }

      this.headerDone = true;
      if (this.connectTimer) { clearTimeout(this.connectTimer); this.connectTimer = null; }
      this.cfg.onConnected();
      this.ggaTimer = setInterval(() => this._sendGga(), GGA_INTERVAL_MS);
      if (rest.length > 0) this._dispatch(rest);
    });

    this.socket.on('error', (err: any) => {
      if (!this.alive) return;
      this.cfg.onError(String(err?.message ?? err));
      this._cleanup();
    });

    this.socket.on('close', () => {
      if (!this.alive) return;
      if (!this.headerDone) {
        // Server closed before completing handshake
        this.cfg.onError('NTRIP connection closed by server before completing handshake');
      }
      this._cleanup();
      this.cfg.onDisconnected();
    });
  }

  disconnect() {
    this.alive = false;
    this._cleanup();
    this.cfg.onDisconnected();
  }

  private _cleanup() {
    if (this.ggaTimer)    { clearInterval(this.ggaTimer);    this.ggaTimer    = null; }
    if (this.connectTimer){ clearTimeout(this.connectTimer); this.connectTimer = null; }
    try { this.socket?.destroy(); } catch {}
    this.socket = null;
  }

  private _sendGga() {
    if (!this.alive || !this.headerDone) return;
    const gga = this.cfg.getGga();
    if (gga) {
      try { this.socket?.write(gga + '\r\n'); } catch {}
    }
  }

  private _parseHeader(buf: number[]): { header: string; restStart: number } | null {
    // Standard HTTP / NTRIP 2.0: \r\n\r\n
    for (let i = 0; i <= buf.length - 4; i++) {
      if (buf[i] === 0x0d && buf[i+1] === 0x0a && buf[i+2] === 0x0d && buf[i+3] === 0x0a) {
        return { header: buf.slice(0, i).map(b => String.fromCharCode(b)).join(''), restStart: i + 4 };
      }
    }
    // NTRIP 1.0: ICY 200 OK\r\n followed immediately by binary RTCM (no blank line)
    for (let i = 0; i <= buf.length - 2; i++) {
      if (buf[i] === 0x0d && buf[i+1] === 0x0a) {
        const firstLine = buf.slice(0, i).map(b => String.fromCharCode(b)).join('');
        if (firstLine.startsWith('ICY ')) {
          // If the byte right after \r\n looks binary (not a printable header), accept single-line
          const nextByte = buf[i + 2];
          if (nextByte === undefined || nextByte < 32 || nextByte > 126) {
            return { header: firstLine, restStart: i + 2 };
          }
        }
        break; // first \r\n reached without ICY — wait for \r\n\r\n
      }
    }
    return null;
  }

  private _dispatch(data: number[]) {
    this.sessionBytes += data.length;
    if (this.sessionBytes > MAX_SESSION_BYTES) {
      this.cfg.onError('RTCM session limit exceeded (200 MB)');
      this.disconnect();
      return;
    }
    for (let i = 0; i < data.length; i += MAX_BLE_CHUNK) {
      this.cfg.onRtcm(new Uint8Array(data.slice(i, i + MAX_BLE_CHUNK)));
    }
  }
}
