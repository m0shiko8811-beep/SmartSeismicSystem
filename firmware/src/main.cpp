/*
 * GPS Survey Tool v7 — BLE Edition
 * Developed by Moshe Fridin
 * ESP32 + NEO-M9N + HW-478 RGB LED
 *
 * Wiring:
 *   GPS TX  → GPIO 16  (ESP32 receives NMEA + UBX)
 *   GPS RX  → GPIO 17  (ESP32 sends RTCM corrections + UBX config)
 *   RGB R   → GPIO 25
 *   RGB G   → GPIO 26
 *   RGB B   → GPIO 27
 *   TRIGGER → GPIO 32  (seismic shot — connect hammer head; plate to GND)
 *
 * BLE GATT Service: 12340000-0000-1000-8000-00805f9b34fb
 *   GPS_CHAR  (notify+read) 12340001-… — GPS JSON ~1/sec, wp list on connect
 *   CMD_CHAR  (write)       12340002-… — JSON commands from phone
 *   RTCM_CHAR (write NR)    12340003-… — raw RTCM bytes phone→GPS serial
 */

#include <TinyGPSPlus.h>
#include <HardwareSerial.h>
#include <Preferences.h>
#include <LittleFS.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include <BLESecurity.h>
#include "trigger.h"

// ── BLE UUIDs ─────────────────────────────────────────
#define SERVICE_UUID   "12340000-0000-1000-8000-00805f9b34fb"
#define GPS_CHAR_UUID  "12340001-0000-1000-8000-00805f9b34fb"
#define CMD_CHAR_UUID  "12340002-0000-1000-8000-00805f9b34fb"
#define RTCM_CHAR_UUID "12340003-0000-1000-8000-00805f9b34fb"

// ── Pins ──────────────────────────────────────────────
#define GPS_MODULE_TX  16
#define GPS_MODULE_RX  17
#define LED_R  25
#define LED_G  26
#define LED_B  27

// ── GPS ───────────────────────────────────────────────
TinyGPSPlus    gps;
HardwareSerial GPS_Serial(1);

char  lastGGA[82]  = "";
char  lastGSA[82]  = "";
char  lastRMC[82]  = "";
// GSV: capture up to 4 sentences (covers ~16 sats per constellation)
char  lastGSV[4][82] = {};
int   gsvCount      = 0;
char  nmeaBuf[82];
int   nmeaIdx  = 0;

// ── UBX-NAV-PVT parser ────────────────────────────────
enum UBXState : uint8_t { U_IDLE, U_SYNC2, U_CLASS, U_ID, U_L1, U_L2, U_PAYLOAD, U_CKA, U_CKB };
static UBXState ubxSt     = U_IDLE;
static uint8_t  ubxCls, ubxId;
static uint16_t ubxLen, ubxIdx;
static uint8_t  ubxBuf[100];
static uint8_t  ubxCalcA, ubxCalcB, ubxRxCkA;

bool     ubxTimeValid  = false;
uint16_t ubxYear;
uint8_t  ubxMonth, ubxDay, ubxHour, ubxMin, ubxSec;
int32_t  ubxNano;
uint32_t lastUbxMillis = 0;

void processUBX(uint8_t c) {
  switch (ubxSt) {
    case U_IDLE:
      if (c == 0xB5) ubxSt = U_SYNC2;
      break;
    case U_SYNC2:
      ubxSt = (c == 0x62) ? U_CLASS : U_IDLE;
      break;
    case U_CLASS:
      ubxCls = c; ubxCalcA = c; ubxCalcB = c;
      ubxSt = U_ID;
      break;
    case U_ID:
      ubxId = c; ubxCalcA += c; ubxCalcB += ubxCalcA;
      ubxSt = U_L1;
      break;
    case U_L1:
      ubxLen = c; ubxCalcA += c; ubxCalcB += ubxCalcA;
      ubxSt = U_L2;
      break;
    case U_L2:
      ubxLen |= ((uint16_t)c << 8);
      ubxCalcA += c; ubxCalcB += ubxCalcA;
      ubxIdx = 0;
      if      (ubxLen == 0)    ubxSt = U_CKA;
      else if (ubxLen <= 100)  ubxSt = U_PAYLOAD;
      else                     ubxSt = U_IDLE;
      break;
    case U_PAYLOAD:
      if (ubxIdx < sizeof(ubxBuf)) ubxBuf[ubxIdx] = c;
      ubxCalcA += c; ubxCalcB += ubxCalcA;
      if (++ubxIdx >= ubxLen) ubxSt = U_CKA;
      break;
    case U_CKA:
      ubxRxCkA = c;
      ubxSt = U_CKB;
      break;
    case U_CKB: {
      bool ok = (ubxRxCkA == ubxCalcA) && (c == ubxCalcB);
      ubxSt = U_IDLE;
      if (!ok) break;
      // Parse UBX-NAV-PVT (class=0x01, id=0x07, len=92)
      if (ubxCls == 0x01 && ubxId == 0x07 && ubxLen == 92) {
        uint8_t vf = ubxBuf[11];
        if ((vf & 0x03) == 0x03) {  // validDate + validTime
          ubxYear  = (uint16_t)ubxBuf[4] | ((uint16_t)ubxBuf[5] << 8);
          ubxMonth = ubxBuf[6];
          ubxDay   = ubxBuf[7];
          ubxHour  = ubxBuf[8];
          ubxMin   = ubxBuf[9];
          ubxSec   = ubxBuf[10];
          ubxNano  = (int32_t)((uint32_t)ubxBuf[16]        |
                               ((uint32_t)ubxBuf[17] << 8)  |
                               ((uint32_t)ubxBuf[18] << 16) |
                               ((uint32_t)ubxBuf[19] << 24));
          ubxTimeValid  = true;
          lastUbxMillis = millis();
        }
      }
      break;
    }
  }
}

// Build timestamp — UBX millisecond precision, falls back to NMEA centiseconds
void buildTimestamp(char* ts, size_t len) {
  if (ubxTimeValid) {
    int32_t ms = ubxNano / 1000000;
    int     s  = (int)ubxSec;
    if (ms < 0) { ms += 1000; s--; }
    if (s  < 0) s = 0;
    snprintf(ts, len, "%04d-%02d-%02dT%02d:%02d:%02d.%03d",
      (int)ubxYear, (int)ubxMonth, (int)ubxDay,
      (int)ubxHour, (int)ubxMin, s, (int)ms);
  } else if (gps.date.isValid() && gps.time.isValid()) {
    snprintf(ts, len, "%04d-%02d-%02dT%02d:%02d:%02d.%02d0",
      gps.date.year(), gps.date.month(), gps.date.day(),
      gps.time.hour(), gps.time.minute(), gps.time.second(),
      (int)gps.time.centisecond());
  } else {
    strncpy(ts, "no-time", len);
  }
}

// Civil date <-> days since 1970-01-01 (proleptic Gregorian, UTC, TZ-free).
// Howard Hinnant's algorithms — let sub-second offsets carry correctly across
// second/minute/hour/day/month/year boundaries.
static long daysFromCivil(int y, int m, int d) {
  y -= m <= 2;
  long era = (y >= 0 ? y : y - 399) / 400;
  int  yoe = (int)(y - era * 400);
  int  doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + (d - 1);
  int  doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  return era * 146097L + doe - 719468L;
}
static void civilFromDays(long z, int* y, int* m, int* d) {
  z += 719468L;
  long era = (z >= 0 ? z : z - 146096) / 146097;
  int  doe = (int)(z - era * 146097);
  int  yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  int  doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  int  mp  = (5 * doy + 2) / 153;
  int  dd  = doy - (153 * mp + 2) / 5 + 1;
  int  mm  = mp + (mp < 10 ? 3 : -9);
  *d = dd;
  *m = mm;
  *y = yoe + (int)(era * 400) + (mm <= 2 ? 1 : 0);
}

// Build a millisecond-precise UTC timestamp at the instant capturedMillis was
// recorded, by offsetting from the last UBX-NAV-PVT epoch (no PPS pin needed).
// NOTE: absolute ms carries a small fixed bias (UART transport latency of the
// NAV-PVT message). Shot-to-shot RELATIVE timing is unaffected; for true
// absolute-ms accuracy, wire the receiver's PPS pin.
void buildTimestampAt(char* ts, size_t len, uint32_t capturedMillis) {
  // Fall back if we have no UBX time, or the last NAV-PVT is stale (>1.5 s) —
  // beyond that the offset model is unreliable.
  if (!ubxTimeValid || (uint32_t)(millis() - lastUbxMillis) > 1500u) {
    buildTimestamp(ts, len);
    return;
  }
  int32_t   offsetMs = (int32_t)(capturedMillis - lastUbxMillis); // small, wrap-safe
  long long epochSec = (long long)daysFromCivil((int)ubxYear, (int)ubxMonth, (int)ubxDay) * 86400LL
                     + (long long)ubxHour * 3600LL + (long long)ubxMin * 60LL + (long long)ubxSec;
  long long totalMs  = epochSec * 1000LL + (long long)(ubxNano / 1000000) + offsetMs;
  long long es       = totalMs / 1000;
  int       ms       = (int)(totalMs - es * 1000);
  if (ms < 0) { ms += 1000; es -= 1; }
  long day = (long)(es / 86400);
  int  sod = (int)(es - (long long)day * 86400);
  if (sod < 0) { sod += 86400; day -= 1; }
  int yy, mo, dd;
  civilFromDays(day, &yy, &mo, &dd);
  snprintf(ts, len, "%04d-%02d-%02dT%02d:%02d:%02d.%03d",
    yy, mo, dd, sod / 3600, (sod % 3600) / 60, sod % 60, ms);
}

// Send UBX commands to enable NAV-PVT output on UART1
void enableUBXNavPVT() {
  // CFG-VALSET (M9N new protocol): enable UBX-NAV-PVT on UART1 at 1Hz
  // CFG-MSGOUT-UBX_NAV_PVT_UART1 key = 0x20910007
  const uint8_t valset[] = {
    0xB5, 0x62, 0x06, 0x8A, 0x09, 0x00,
    0x00, 0x01, 0x00, 0x00,
    0x07, 0x00, 0x91, 0x20,
    0x01,
    0x53, 0x48
  };
  GPS_Serial.write(valset, sizeof(valset));
  delay(50);
  // Legacy CFG-MSG (backward compat)
  const uint8_t cfgmsg[] = {
    0xB5, 0x62, 0x06, 0x01, 0x08, 0x00,
    0x01, 0x07, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00,
    0x18, 0xE1
  };
  GPS_Serial.write(cfgmsg, sizeof(cfgmsg));
  Serial.println("[UBX] NAV-PVT enable sent");
}

// ── Survey config ─────────────────────────────────────
int   lineNum     = 1001;
int   stationNum  = 1;
int   stationStep = 1;
bool  countUp     = true;
float minAccM       = 0.0f;
float maxAccM       = 10.0f;
float antennaHeight = 0.0f;

// ── Last waypoint ─────────────────────────────────────
double lastWPLat = 0.0, lastWPLon = 0.0;
bool   hasLastWP = false;

// ── Waypoints ─────────────────────────────────────────
#define WP_FILE  "/waypoints.dat"
#define WP_MAX   200
struct WP {
  int    id;
  double lat, lon, alt;
  float  hdop;
  int    fixQ;
  char   ts[24];
  char   label[24];
};
WP   wpList[WP_MAX];
int  wpCount = 0;

// ── Point averaging ───────────────────────────────────
const int     AVG_TOTAL = 5;
const int     AVG_MS    = 800;
bool          averaging  = false;
int           avgCount   = 0;
double        avgLat=0, avgLon=0, avgAlt=0;
float         avgHdop    = 0;
unsigned long avgNextAt=0, avgTimeout=0;
String        avgLabel   = "";

// ── LED ───────────────────────────────────────────────
int           saveFlashSteps = 0;
unsigned long ledTimer       = 0;
bool          ledOn          = false;

// ── NTRIP ─────────────────────────────────────────────
volatile uint32_t ntripBytes  = 0;
volatile uint32_t ntripLastAt = 0;

// ── Preferences ───────────────────────────────────────
Preferences cfgPrefs;

// ── BLE state ─────────────────────────────────────────
BLEServer*         pServer   = nullptr;
BLECharacteristic* pGpsChar  = nullptr;
volatile bool      bleConnected   = false;
volatile bool      wpListPending  = false;
volatile int       wpListSendIdx  = 0;

// ── Prototypes ────────────────────────────────────────
void sendDbg(const String& msg);
void addWP(const char* lbl, bool adv);
void addWPManual(const char* lbl, double lat, double lon, double alt, float hdop, bool adv);
float   currentAcc();
bool    accInRange();
int     getFixQuality();
double  haversineDist(double, double, double, double);
void    setRGB(uint8_t r, uint8_t g, uint8_t b);
void    updateLED();
void    triggerSaveFlash();
void    saveWaypointsToFlash();
void    loadWaypointsFromFlash();
String  buildGpsJson();
void    handleCommand(const String& msg);

// ── Engineering debug over BLE ────────────────────────
void sendDbg(const String& msg) {
  Serial.println("[DBG] " + msg);
  if (bleConnected && pGpsChar) {
    String j = "{\"type\":\"dbg\",\"msg\":\"" + msg + "\"}";
    pGpsChar->setValue(j.c_str());
    pGpsChar->notify();
  }
}

// ── BLE Server Callbacks ──────────────────────────────
class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer*) override {
    bleConnected    = true;
    wpListPending   = true;
    wpListSendIdx   = 0;
    shotListPending = false;  // starts after wp list finishes
    shotListSendIdx = 0;
    Serial.println("[BLE] Phone connected");
    sendDbg("BLE connected");
  }
  void onDisconnect(BLEServer*) override {
    bleConnected = false;
    Serial.println("[BLE] Phone disconnected — restarting advertising");
    sendDbg("BLE disconnected");
    BLEDevice::startAdvertising();
  }
};

class CmdCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* c) override {
    std::string val = c->getValue();
    handleCommand(String(val.c_str()));
  }
};

class RtcmCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* c) override {
    std::string val = c->getValue();
    if (val.length() == 0 || val.length() > 512) return;
    GPS_Serial.write(reinterpret_cast<const uint8_t*>(val.data()), val.length());
    ntripBytes += val.length();
    ntripLastAt = millis();
  }
};

// ── Helpers ───────────────────────────────────────────
float currentAcc() {
  return gps.hdop.isValid() ? gps.hdop.value() / 100.0f * 2.5f : 99.0f;
}
bool accInRange() {
  float a = currentAcc();
  if (minAccM > 0 && a < minAccM) return false;
  if (maxAccM > 0 && maxAccM < 9.9f && a > maxAccM) return false;
  return true;
}
int getFixQuality() {
  if (strlen(lastGGA) < 10) return 0;
  const char* p = lastGGA; int c = 0;
  while (*p && c < 6) { if (*p++ == ',') c++; }
  if (c < 6 || *p == '\0') return 0;
  return atoi(p);
}
String jsonEsc(const String& s) {
  String r = s; r.replace("\\", "\\\\"); r.replace("\"", "\\\""); return r;
}
double haversineDist(double lat1, double lon1, double lat2, double lon2) {
  const double R = 6371000.0;
  double dLat = (lat2 - lat1) * DEG_TO_RAD;
  double dLon = (lon2 - lon1) * DEG_TO_RAD;
  double a = sin(dLat/2)*sin(dLat/2) +
             cos(lat1*DEG_TO_RAD)*cos(lat2*DEG_TO_RAD)*
             sin(dLon/2)*sin(dLon/2);
  return R * 2.0 * atan2(sqrt(a), sqrt(1.0 - a));
}

// ── Flash persistence ─────────────────────────────────
void saveWaypointsToFlash() {
  File f = LittleFS.open(WP_FILE, "w");
  if (!f) { Serial.println("[FS] open for write failed"); return; }
  for (int i = 0; i < wpCount; i++) {
    WP& w = wpList[i];
    f.printf("%s|%.7f|%.7f|%.2f|%.2f|%d|%s\n",
      w.label, w.lat, w.lon, w.alt, w.hdop, w.fixQ, w.ts);
  }
  f.close();
  Serial.printf("[FS] Saved %d waypoints\n", wpCount);
  sendDbg("Flash saved " + String(wpCount) + " WPs");
}

void loadWaypointsFromFlash() {
  File f = LittleFS.open(WP_FILE, "r");
  if (!f) { Serial.println("[FS] No waypoints file"); return; }
  wpCount = 0;
  while (f.available() && wpCount < WP_MAX) {
    String line = f.readStringUntil('\n'); line.trim();
    if (line.length() < 5) continue;
    WP& w = wpList[wpCount];
    char buf[256]; strncpy(buf, line.c_str(), 255); buf[255] = '\0';
    char* t = strtok(buf, "|");
    if (!t) continue; strncpy(w.label, t, 23); w.label[23] = '\0';
    t = strtok(NULL, "|"); if (!t) continue; w.lat  = atof(t);
    t = strtok(NULL, "|"); if (!t) continue; w.lon  = atof(t);
    t = strtok(NULL, "|"); if (!t) continue; w.alt  = atof(t);
    t = strtok(NULL, "|"); if (!t) continue; w.hdop = atof(t);
    t = strtok(NULL, "|"); if (!t) continue; w.fixQ = atoi(t);
    t = strtok(NULL, "|"); if (!t) continue; strncpy(w.ts, t, 23); w.ts[23] = '\0';
    // Extra fields (old format): ignored
    w.id = wpCount + 1;
    lastWPLat = w.lat; lastWPLon = w.lon; hasLastWP = true;
    wpCount++;
  }
  f.close();
  Serial.printf("[FS] Loaded %d waypoints\n", wpCount);
  sendDbg("Flash loaded " + String(wpCount) + " WPs");
}

// ── LED ───────────────────────────────────────────────
void setRGB(uint8_t r, uint8_t g, uint8_t b) {
  analogWrite(LED_R, r); analogWrite(LED_G, g); analogWrite(LED_B, b);
}
void triggerSaveFlash() { saveFlashSteps = 8; ledTimer = millis(); }
void updateLED() {
  unsigned long now = millis();
  if (saveFlashSteps > 0) {
    if (now - ledTimer > 60) {
      ledTimer = now; saveFlashSteps--;
      setRGB(0, saveFlashSteps % 2 == 0 ? 0 : 255, 0);
    }
    return;
  }
  bool  fix  = gps.location.isValid() && gps.location.age() < 3000;
  int   sats = gps.satellites.isValid() ? (int)gps.satellites.value() : 0;
  float hdop = gps.hdop.isValid() && gps.hdop.age() < 3000 ? gps.hdop.value() / 100.0f : 0;
  if (averaging) {
    if (now - ledTimer > 300) { ledTimer = now; ledOn = !ledOn; }
    setRGB(0, 0, ledOn ? 200 : 30); return;
  }
  if (!fix && sats == 0) { setRGB(160, 0, 0); return; }
  if (!fix) {
    if (now - ledTimer > 700) { ledTimer = now; ledOn = !ledOn; }
    setRGB(ledOn ? 160 : 15, 0, 0); return;
  }
  if (hdop <= 0 || hdop > 1.5f || sats < 6) {
    if (now - ledTimer > 600) { ledTimer = now; ledOn = !ledOn; }
    setRGB(ledOn ? 200 : 20, ledOn ? 80 : 8, 0); return;
  }
  if (accInRange()) {
    if (now - ledTimer > 400) { ledTimer = now; ledOn = !ledOn; }
    setRGB(0, ledOn ? 220 : 0, 0);
  } else {
    setRGB(70, 45, 0);
  }
}

// ── Waypoint save ─────────────────────────────────────
void addWP(const char* lbl, bool adv) {
  if (wpCount >= WP_MAX) return;
  WP& w = wpList[wpCount];
  w.id   = wpCount + 1;
  w.lat  = gps.location.lat();
  w.lon  = gps.location.lng();
  w.alt  = (gps.altitude.isValid() ? gps.altitude.meters() : 0) - antennaHeight;
  w.hdop = gps.hdop.isValid() ? gps.hdop.value() / 100.0f : 0;
  w.fixQ = getFixQuality();
  strncpy(w.label, lbl, 23); w.label[23] = '\0';
  buildTimestamp(w.ts, sizeof(w.ts));
  lastWPLat = w.lat; lastWPLon = w.lon; hasLastWP = true;
  wpCount++;
  if (adv) stationNum += countUp ? stationStep : -stationStep;
  triggerSaveFlash();
  Serial.printf("[WP] Saved %s: %.6f,%.6f FQ:%d ts:%s\n", lbl, w.lat, w.lon, w.fixQ, w.ts);
  sendDbg("WP+ " + String(lbl) + " fq" + String(w.fixQ) + " h" + String(w.hdop, 2));
  saveWaypointsToFlash();
  cfgPrefs.putInt("line", lineNum);
  cfgPrefs.putInt("sta",  stationNum);
}

void addWPManual(const char* lbl, double lat, double lon, double alt, float hdop, bool adv) {
  if (wpCount >= WP_MAX) return;
  WP& w = wpList[wpCount];
  w.id = wpCount + 1; w.lat = lat; w.lon = lon;
  w.alt = alt; w.hdop = hdop; w.fixQ = getFixQuality();
  strncpy(w.label, lbl, 23); w.label[23] = '\0';
  buildTimestamp(w.ts, sizeof(w.ts));
  lastWPLat = lat; lastWPLon = lon; hasLastWP = true;
  wpCount++;
  if (adv) stationNum += countUp ? stationStep : -stationStep;
  triggerSaveFlash();
  Serial.printf("[WP] Saved %s: %.6f,%.6f ts:%s\n", lbl, lat, lon, w.ts);
  sendDbg("WP+avg " + String(lbl) + " h" + String(hdop, 2));
  saveWaypointsToFlash();
  cfgPrefs.putInt("line", lineNum);
  cfgPrefs.putInt("sta",  stationNum);
}

// ── GPS JSON builder ──────────────────────────────────
String buildGpsJson() {
  bool ntActive = (ntripBytes > 0 && millis() - ntripLastAt < 5000);
  String j = "{\"type\":\"gps\"";
  j += ",\"lat\":"  + String(gps.location.lat(), 7);
  j += ",\"lon\":"  + String(gps.location.lng(), 7);
  j += ",\"alt\":"  + String((gps.altitude.isValid() ? gps.altitude.meters() : 0.0) - antennaHeight, 2);
  j += ",\"sats\":" + String(gps.satellites.isValid() ? (int)gps.satellites.value() : 0);
  j += ",\"fix\":"  + String(gps.location.isValid() ? "true" : "false");
  j += ",\"hdop\":" + String(gps.hdop.isValid() ? gps.hdop.value() / 100.0f : 0.0f, 2);
  j += ",\"fixQ\":" + String(getFixQuality());
  j += ",\"age\":"  + String(gps.location.isValid() ? (int)gps.location.age() : -1);
  j += ",\"dist2last\":";
  if (hasLastWP && gps.location.isValid())
    j += String(haversineDist(gps.location.lat(), gps.location.lng(), lastWPLat, lastWPLon), 1);
  else j += "null";
  j += ",\"lastWPLat\":" + String(lastWPLat, 7);
  j += ",\"lastWPLon\":" + String(lastWPLon, 7);
  j += ",\"averaging\":"  + String(averaging ? "true" : "false");
  j += ",\"avgCount\":"   + String(avgCount);
  j += ",\"avgTotal\":"   + String(AVG_TOTAL);
  j += ",\"avgDone\":false,\"lastAvg\":null"; // avg_done sent as separate notification
  j += ",\"wpCount\":"     + String(wpCount);
  j += ",\"ntripState\":\"" + String(ntActive ? "streaming" : "idle") + "\"";
  j += ",\"ntripBytes\":"  + String(ntripBytes);
  j += ",\"cfg\":{\"line\":" + String(lineNum);
  j += ",\"sta\":"   + String(stationNum);
  j += ",\"step\":"  + String(stationStep);
  j += ",\"up\":"    + String(countUp ? "true" : "false");
  j += ",\"ant_h\":" + String(antennaHeight, 3) + "}";
  j += ",\"shot_cfg\":{\"line\":" + String(shotCfg.line);
  j += ",\"sp\":"       + String(shotCfg.sp);
  j += ",\"step\":"     + String(shotCfg.step);
  j += ",\"debounce\":" + String(shotCfg.debounce);
  j += ",\"edge\":\""   + String(shotCfg.edgeFalling ? "falling" : "rising") + "\"}";
  j += ",\"shotCount\":" + String(shotCount);
  j += "}";
  return j;
}

// ── Command handler ───────────────────────────────────
void handleCommand(const String& msg) {
  Serial.printf("[CMD] %s\n", msg.c_str());

  auto strVal = [&](const char* key) -> String {
    String needle = String("\"") + key + "\":\"";
    int s = msg.indexOf(needle);
    if (s < 0) return "";
    int start = s + needle.length();
    int end   = msg.indexOf('"', start);
    return end > start ? msg.substring(start, end) : "";
  };
  auto intVal = [&](const char* key) -> int {
    String needle = String("\"") + key + "\":";
    int s = msg.indexOf(needle);
    if (s < 0) return -1;
    return msg.substring(s + needle.length()).toInt();
  };
  auto boolVal = [&](const char* key) -> int {
    String needle = String("\"") + key + "\":";
    int s = msg.indexOf(needle);
    if (s < 0) return -1;
    int vs = s + needle.length();
    if (msg.substring(vs, vs + 4) == "true")  return 1;
    if (msg.substring(vs, vs + 5) == "false") return 0;
    return -1;
  };
  auto strDbl = [&](const char* key) -> double {
    String needle = String("\"") + key + "\":";
    int s = msg.indexOf(needle);
    if (s < 0) return 0.0;
    return msg.substring(s + needle.length()).toDouble();
  };
  auto strFlt = [&](const char* key) -> float {
    String needle = String("\"") + key + "\":";
    int s = msg.indexOf(needle);
    if (s < 0) return 0.0f;
    return msg.substring(s + needle.length()).toFloat();
  };

  if (msg.indexOf("\"wp_save_at\"") >= 0) {
    String lbl = strVal("label");
    if (lbl.isEmpty()) lbl = String(lineNum) + ":" + String(stationNum);
    double lat  = strDbl("lat");
    double lon  = strDbl("lon");
    double alt  = strDbl("alt");
    float  hdop = strFlt("hdop");
    if (lat < -90.0 || lat > 90.0 || lon < -180.0 || lon > 180.0) {
      Serial.println("[CMD] wp_save_at ignored — coords out of range");
      sendDbg("wp_save_at: OOB");
    } else {
      addWPManual(lbl.c_str(), lat, lon, alt, hdop, true);
    }

  } else if (msg.indexOf("\"wp_save\"") >= 0) {
    String lbl = strVal("label");
    if (lbl.isEmpty()) lbl = String(lineNum) + ":" + String(stationNum);
    if (gps.location.isValid() && gps.location.age() < 5000)
      addWP(lbl.c_str(), true);
    else {
      Serial.println("[CMD] wp_save ignored — no valid fix");
      sendDbg("wp_save: no fix");
    }

  } else if (msg.indexOf("\"avg_start\"") >= 0) {
    String lbl = strVal("label");
    if (lbl.isEmpty()) lbl = String(lineNum) + ":" + String(stationNum);
    avgLabel = lbl;
    if (!averaging) {
      avgLat = avgLon = avgAlt = avgHdop = 0; avgCount = 0;
      averaging = true;
      avgNextAt = millis(); avgTimeout = millis() + 30000;
      sendDbg("avg_start: " + lbl);
    }

  } else if (msg.indexOf("\"avg_cancel\"") >= 0) {
    averaging = false; avgCount = 0;
    sendDbg("avg_cancel");

  } else if (msg.indexOf("\"wp_list\"") >= 0) {
    wpListPending = true;
    wpListSendIdx = 0;

  } else if (msg.indexOf("\"wp_clear\"") >= 0) {
    wpCount = 0; hasLastWP = false;
    LittleFS.remove(WP_FILE);
    // Station counter is owned by the phone — do NOT reset here
    Serial.println("[CMD] All waypoints cleared");
    sendDbg("wp_clear");

  } else if (msg.indexOf("\"wp_delete_last\"") >= 0) {
    int n = intVal("n");
    if (n > 0 && n <= wpCount) {
      wpCount -= n;
      if (wpCount > 0) {
        lastWPLat = wpList[wpCount - 1].lat;
        lastWPLon = wpList[wpCount - 1].lon;
        hasLastWP = true;
      } else {
        hasLastWP = false;
      }
      saveWaypointsToFlash();
      Serial.printf("[CMD] Deleted last %d WPs, now have %d\n", n, wpCount);
      sendDbg("del_last " + String(n) + " now=" + String(wpCount));
    }

  } else if (msg.indexOf("\"wp_delete\"") >= 0) {
    int id = intVal("id");
    if (id >= 1 && id <= wpCount) {
      for (int i = id - 1; i < wpCount - 1; i++) wpList[i] = wpList[i + 1];
      wpCount--;
      for (int i = 0; i < wpCount; i++) wpList[i].id = i + 1;
      saveWaypointsToFlash();
    }

  } else if (msg.indexOf("\"cfg\"") >= 0) {
    int ln = intVal("line");
    int sn = intVal("sta");
    int st = intVal("step");
    int up = boolVal("up");
    String antNeedle = "\"ant_h\":";
    int ai = msg.indexOf(antNeedle);
    if (ln >= 1000 && ln <= 9999) { lineNum     = ln; cfgPrefs.putInt("line",  lineNum);    }
    if (sn >= 0   && sn <= 9999) { stationNum  = sn; cfgPrefs.putInt("sta",   stationNum); }
    if (st >= 1   && st <= 100)  { stationStep = st; cfgPrefs.putInt("step",  stationStep);}
    if (up >= 0)  { countUp = up; cfgPrefs.putBool("up", countUp); }
    if (ai >= 0)  {
      float ah = msg.substring(ai + antNeedle.length()).toFloat();
      if (ah >= -5.0f && ah <= 5.0f) { antennaHeight = ah; cfgPrefs.putFloat("ant_h", antennaHeight); }
    }
    Serial.printf("[CMD] cfg: line=%d sta=%d step=%d up=%d ant_h=%.2f\n",
      lineNum, stationNum, stationStep, (int)countUp, antennaHeight);
    sendDbg("cfg L" + String(lineNum) + " S" + String(stationNum) + " step" + String(stationStep) + " ant" + String(antennaHeight, 2));

  } else if (msg.indexOf("\"acc_filter\"") >= 0) {
    String needle_min = "\"min\":";
    String needle_max = "\"max\":";
    int mn = msg.indexOf(needle_min);
    int mx = msg.indexOf(needle_max);
    if (mn >= 0) { float v = msg.substring(mn + needle_min.length()).toFloat(); if (v >= 0 && v <= 50) minAccM = v; }
    if (mx >= 0) { float v = msg.substring(mx + needle_max.length()).toFloat(); if (v >= 0 && v <= 50) maxAccM = v; }
    sendDbg("accFilter min=" + String(minAccM, 1) + " max=" + String(maxAccM, 1));

  } else if (msg.indexOf("\"shot_cfg\"") >= 0) {
    int    ln  = intVal("line");
    int    sp  = intVal("sp");
    int    st  = intVal("step");
    int    db  = intVal("debounce");
    String edg = strVal("edge");
    if (ln >= 1 && ln <= 9999)       { shotCfg.line    = ln; cfgPrefs.putInt ("sh_line", ln); }
    if (sp >= 0 && sp <= 9999)       { shotCfg.sp      = sp; cfgPrefs.putInt ("sh_sp",   sp); }
    if (st != 0 && abs(st) <= 100)   { shotCfg.step    = st; cfgPrefs.putInt ("sh_step", st); }
    if (db >= 50 && db <= 5000)      { shotCfg.debounce= db; cfgPrefs.putInt ("sh_deb",  db); }
    if (edg.length() > 0) {
      bool falling = (edg == "falling");
      if (falling != shotCfg.edgeFalling) {
        shotCfg.edgeFalling = falling;
        cfgPrefs.putBool("sh_edge", falling);
        updateTriggerInterrupt();
      }
    }
    Serial.printf("[SHOT_CFG] L%d SP%d step%+d deb%dms edge=%s\n",
      shotCfg.line, shotCfg.sp, shotCfg.step, shotCfg.debounce,
      shotCfg.edgeFalling ? "FALL" : "RISE");
    sendDbg("shot_cfg L" + String(shotCfg.line) + " SP" + String(shotCfg.sp) + " step" + String(shotCfg.step));

  } else if (msg.indexOf("\"shot_list\"") >= 0) {
    shotListPending = true;
    shotListSendIdx = 0;

  } else if (msg.indexOf("\"shot_clear\"") >= 0) {
    shotCount = 0;
    LittleFS.remove(SHOT_FILE);
    sendDbg("shot_clear");

  } else if (msg.indexOf("\"shot_delete\"") >= 0) {
    int id = intVal("id");
    if (id >= 1 && id <= shotCount) {
      for (int i = id - 1; i < shotCount - 1; i++) shotList[i] = shotList[i + 1];
      shotCount--;
      for (int i = 0; i < shotCount; i++) shotList[i].id = i + 1;
      saveShotsToFlash();
    }
  }
}

// ──────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  Serial.println("\n=== GPS Survey Tool v7 — Developed by Moshe Fridin ===");
  GPS_Serial.begin(38400, SERIAL_8N1, GPS_MODULE_TX, GPS_MODULE_RX);

  pinMode(LED_R, OUTPUT);
  pinMode(LED_G, OUTPUT);
  pinMode(LED_B, OUTPUT);
  setRGB(160, 0, 0);

  cfgPrefs.begin("survey", false);
  lineNum       = cfgPrefs.getInt("line",    1001);
  stationNum    = cfgPrefs.getInt("sta",     1);
  stationStep   = cfgPrefs.getInt("step",    1);
  countUp       = cfgPrefs.getBool("up",     true);
  antennaHeight = cfgPrefs.getFloat("ant_h", 0.0f);
  Serial.printf("[CFG] line=%d sta=%d step=%d dir=%s\n",
    lineNum, stationNum, stationStep, countUp ? "up" : "dn");

  if (LittleFS.begin(true)) {
    loadWaypointsFromFlash();
    loadShotsFromFlash();
  } else {
    Serial.println("[FS] LittleFS mount failed");
  }

  shotCfg.line        = cfgPrefs.getInt ("sh_line", lineNum);
  shotCfg.sp          = cfgPrefs.getInt ("sh_sp",   1);
  shotCfg.step        = cfgPrefs.getInt ("sh_step",  1);
  shotCfg.debounce    = cfgPrefs.getInt ("sh_deb",  500);
  shotCfg.edgeFalling = cfgPrefs.getBool("sh_edge", true);
  pinMode(TRIGGER_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(TRIGGER_PIN), onTrigger,
    shotCfg.edgeFalling ? FALLING : RISING);
  Serial.printf("[SHOT] GPIO%d edge=%s deb=%dms L%d SP%d step%+d\n",
    TRIGGER_PIN, shotCfg.edgeFalling ? "FALL" : "RISE",
    shotCfg.debounce, shotCfg.line, shotCfg.sp, shotCfg.step);

  // Wait for GPS to boot, then enable UBX-NAV-PVT
  delay(500);
  enableUBXNavPVT();

  // ── BLE setup ─────────────────────────────────────
  BLEDevice::init("GPS-Survey");
  BLEDevice::setMTU(512);

  // ── BLE security ──────────────────────────────────
  // Require bonding + encryption so the command/RTCM/telemetry characteristics
  // are NOT an open, unauthenticated interface (otherwise any device in BLE
  // range could send wp_clear / shot_clear / shot_cfg or inject RTCM). On first
  // connect the phone prompts to pair using this static passkey.
  // ⚠ Flashing this requires re-pairing the phone once (enter the passkey);
  //   verify the app still connects after pairing before relying on it in the field.
  const uint32_t blePasskey = 471129;   // change to your own 6-digit PIN
  BLESecurity* pSecurity = new BLESecurity();
  pSecurity->setStaticPIN(blePasskey);
  pSecurity->setAuthenticationMode(ESP_LE_AUTH_REQ_SC_BOND);
  pSecurity->setCapability(ESP_IO_CAP_OUT);
  pSecurity->setInitEncryptionKey(ESP_BLE_ENC_KEY_MASK | ESP_BLE_ID_KEY_MASK);

  pServer = BLEDevice::createServer();
  pServer->setCallbacks(new ServerCallbacks());

  BLEService* pSvc = pServer->createService(SERVICE_UUID);

  pGpsChar = pSvc->createCharacteristic(
    GPS_CHAR_UUID,
    BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY
  );
  pGpsChar->setAccessPermissions(ESP_GATT_PERM_READ_ENCRYPTED);
  pGpsChar->addDescriptor(new BLE2902());
  pGpsChar->setValue("{}");

  BLECharacteristic* pCmdChar = pSvc->createCharacteristic(
    CMD_CHAR_UUID,
    BLECharacteristic::PROPERTY_WRITE
  );
  pCmdChar->setAccessPermissions(ESP_GATT_PERM_WRITE_ENCRYPTED);
  pCmdChar->setCallbacks(new CmdCallbacks());

  BLECharacteristic* pRtcmChar = pSvc->createCharacteristic(
    RTCM_CHAR_UUID,
    BLECharacteristic::PROPERTY_WRITE_NR
  );
  pRtcmChar->setAccessPermissions(ESP_GATT_PERM_WRITE_ENCRYPTED);
  pRtcmChar->setCallbacks(new RtcmCallbacks());

  pSvc->start();

  BLEAdvertising* pAdv = BLEDevice::getAdvertising();
  pAdv->addServiceUUID(SERVICE_UUID);
  pAdv->setScanResponse(true);
  pAdv->setMinPreferred(0x06);
  BLEDevice::startAdvertising();

  Serial.println("[BLE] Advertising as 'GPS-Survey'");
}

// ──────────────────────────────────────────────────────
static unsigned long lastGpsNotify  = 0;
static unsigned long lastWpNotify   = 0;
static unsigned long lastNmeaNotify = 0;
static unsigned long lastShotNotify = 0;
static bool          prevFixValid      = false;
static int           prevFixQ          = -1;
static int           fixQCandidate     = -1;
static unsigned long fixQCandidateMs   = 0;
static uint32_t      lastRtcmKB        = 0;

void loop() {
  // ── GPS serial read ───────────────────────────────
  while (GPS_Serial.available()) {
    int raw = GPS_Serial.read();
    if (raw < 0) break;
    uint8_t uc = (uint8_t)raw;
    char    c  = (char)raw;

    // NMEA sentence accumulation (between '$' and '\n')
    if (c == '$') {
      nmeaIdx = 0;
      nmeaBuf[nmeaIdx++] = c;
    } else if (c == '\n' && nmeaIdx > 0) {
      nmeaBuf[nmeaIdx] = '\0';
      if (strncmp(nmeaBuf, "$GPGGA", 6) == 0 || strncmp(nmeaBuf, "$GNGGA", 6) == 0)
        { strncpy(lastGGA, nmeaBuf, 81); lastGGA[81] = '\0'; }
      if (strncmp(nmeaBuf, "$GPGSA", 6) == 0 || strncmp(nmeaBuf, "$GNGSA", 6) == 0)
        { strncpy(lastGSA, nmeaBuf, 81); lastGSA[81] = '\0'; }
      if (strncmp(nmeaBuf, "$GPRMC", 6) == 0 || strncmp(nmeaBuf, "$GNRMC", 6) == 0)
        { strncpy(lastRMC, nmeaBuf, 81); lastRMC[81] = '\0'; }
      // GSV: collect sentences; reset counter on first sentence of a new group
      if (strncmp(nmeaBuf + 3, "GSV,", 4) == 0) {
        // Field 2 is the sentence index (1-based)
        const char* p = nmeaBuf; int c = 0;
        while (*p && c < 1) { if (*p++ == ',') c++; }
        int msgIdx = atoi(p);  // 0 if not found
        if (msgIdx <= 1) gsvCount = 0;  // start of new group — reset
        if (gsvCount < 4) {
          strncpy(lastGSV[gsvCount], nmeaBuf, 81);
          lastGSV[gsvCount][81] = '\0';
          gsvCount++;
        }
      }
      nmeaIdx = 0;
    } else if (nmeaIdx > 0 && c != '\r' && nmeaIdx < 80) {
      nmeaBuf[nmeaIdx++] = c;
    }

    processUBX(uc);
    gps.encode(c);
  }

  // ── Shot trigger processing ───────────────────────
  if (shotPending) {
    shotPending = false;
    if (millis() - lastShotAt >= (unsigned long)shotCfg.debounce) {
      lastShotAt = millis();
      addShot();
    }
  }

  // ── GPS fix state change detection ───────────────
  {
    bool curFix = gps.location.isValid() && gps.location.age() < 3000;
    if (curFix != prevFixValid) {
      prevFixValid      = curFix;
      prevFixQ          = -1;
      fixQCandidate     = -1;
      fixQCandidateMs   = 0;
      if (curFix) sendDbg("GPS fix acq sats=" + String(gps.satellites.isValid() ? (int)gps.satellites.value() : 0) + " fixQ=" + String(getFixQuality()));
      else         sendDbg("GPS fix lost");
    }
    if (curFix) {
      int cq = getFixQuality();
      // Debounce: only report fixQ after the value is stable for 2 s.
      // u-blox NEO-M9N momentarily outputs quality=0 between RTCM epochs;
      // reporting every transient hides real RTK upgrades in BLE log spam.
      if (cq != fixQCandidate) {
        fixQCandidate   = cq;
        fixQCandidateMs = millis();
      } else if (cq != prevFixQ && millis() - fixQCandidateMs >= 2000UL) {
        prevFixQ = cq;
        sendDbg("fixQ=" + String(cq));
      }
    }
  }

  // ── Point averaging ───────────────────────────────
  if (averaging) {
    unsigned long now = millis();
    if (now >= avgTimeout) {
      averaging = false; avgCount = 0;
      Serial.println("[AVG] Timeout");
      sendDbg("avg_timeout");
    } else if (now >= avgNextAt && gps.location.isValid() && gps.location.age() < 5000) {
      avgLat  += gps.location.lat();
      avgLon  += gps.location.lng();
      avgAlt  += (gps.altitude.isValid() ? gps.altitude.meters() : 0) - antennaHeight;
      avgHdop += gps.hdop.isValid() ? gps.hdop.value() / 100.0f : 0;
      avgCount++;
      avgNextAt = now + AVG_MS;
      Serial.printf("[AVG] %d/%d\n", avgCount, AVG_TOTAL);
      sendDbg("avg " + String(avgCount) + "/" + String(AVG_TOTAL));
      if (avgCount >= AVG_TOTAL) {
        averaging = false;
        double fLat  = avgLat  / AVG_TOTAL;
        double fLon  = avgLon  / AVG_TOTAL;
        double fAlt  = avgAlt  / AVG_TOTAL;
        float  fHdop = avgHdop / AVG_TOTAL;
        char   fTs[24]; buildTimestamp(fTs, sizeof(fTs));
        addWPManual(avgLabel.c_str(), fLat, fLon, fAlt, fHdop, true);
        wpListPending = true; wpListSendIdx = 0;
        sendDbg("avg_done " + avgLabel);
        if (bleConnected) {
          String ad = "{\"type\":\"avg_done\"";
          ad += ",\"label\":\""  + jsonEsc(avgLabel) + "\"";
          ad += ",\"lat\":"      + String(fLat, 7);
          ad += ",\"lon\":"      + String(fLon, 7);
          ad += ",\"alt\":"      + String(fAlt, 2);
          ad += ",\"hdop\":"     + String(fHdop, 2);
          ad += ",\"ts\":\""     + String(fTs) + "\"";
          ad += ",\"next_line\":" + String(lineNum);
          ad += ",\"next_sta\":"  + String(stationNum) + "}";
          pGpsChar->setValue(ad.c_str());
          pGpsChar->notify();
        }
      }
    }
  }

  // ── Shot event notify (send immediately after trigger) ──
  if (shotEventPending) {
    shotEventPending = false;
    if (bleConnected && shotEventIdx >= 0 && shotEventIdx < shotCount) {
      Shot& sh = shotList[shotEventIdx];
      String j = "{\"type\":\"shot\"";
      j += ",\"id\":"   + String(sh.id);
      j += ",\"line\":" + String(sh.line);
      j += ",\"sp\":"   + String(sh.sp);
      j += ",\"lat\":"  + String(sh.lat, 7);
      j += ",\"lon\":"  + String(sh.lon, 7);
      j += ",\"alt\":"  + String(sh.alt, 2);
      j += ",\"hdop\":" + String(sh.hdop, 2);
      j += ",\"fixQ\":" + String(sh.fixQ);
      j += ",\"ts\":\""  + String(sh.ts) + "\"}";
      pGpsChar->setValue(j.c_str());
      pGpsChar->notify();
    }
  }

  if (bleConnected) {
    // ── Waypoint list flush ────────────────────────
    if (wpListPending && millis() - lastWpNotify >= 30) {
      lastWpNotify = millis();
      if (wpListSendIdx >= 0 && wpListSendIdx < wpCount) {
        WP& w = wpList[wpListSendIdx];
        String j = "{\"type\":\"wp\"";
        j += ",\"id\":"    + String(w.id);
        j += ",\"label\":\"" + jsonEsc(String(w.label)) + "\"";
        j += ",\"lat\":"   + String(w.lat, 7);
        j += ",\"lon\":"   + String(w.lon, 7);
        j += ",\"alt\":"   + String(w.alt, 2);
        j += ",\"hdop\":"  + String(w.hdop, 2);
        j += ",\"fixQ\":"  + String(w.fixQ);
        j += ",\"ts\":\""  + String(w.ts) + "\"}";
        pGpsChar->setValue(j.c_str());
        pGpsChar->notify();
        wpListSendIdx++;
      } else {
        String done = "{\"type\":\"wp_done\",\"count\":" + String(wpCount) + "}";
        pGpsChar->setValue(done.c_str());
        pGpsChar->notify();
        wpListPending = false;
        Serial.printf("[BLE] wp list sent (%d)\n", wpCount);
        // Auto-start shot list after wp list completes
        shotListPending = true;
        shotListSendIdx = 0;
      }
    }

    // ── Shot list flush (sequenced after wp list) ──
    if (!wpListPending && shotListPending && millis() - lastShotNotify >= 30) {
      lastShotNotify = millis();
      if (shotListSendIdx >= 0 && shotListSendIdx < shotCount) {
        Shot& sh = shotList[shotListSendIdx];
        String j = "{\"type\":\"shot\"";
        j += ",\"id\":"   + String(sh.id);
        j += ",\"line\":" + String(sh.line);
        j += ",\"sp\":"   + String(sh.sp);
        j += ",\"lat\":"  + String(sh.lat, 7);
        j += ",\"lon\":"  + String(sh.lon, 7);
        j += ",\"alt\":"  + String(sh.alt, 2);
        j += ",\"hdop\":" + String(sh.hdop, 2);
        j += ",\"fixQ\":" + String(sh.fixQ);
        j += ",\"ts\":\""  + String(sh.ts) + "\"}";
        pGpsChar->setValue(j.c_str());
        pGpsChar->notify();
        shotListSendIdx++;
      } else {
        String done = "{\"type\":\"shot_done\",\"count\":" + String(shotCount) + "}";
        pGpsChar->setValue(done.c_str());
        pGpsChar->notify();
        shotListPending = false;
        Serial.printf("[BLE] shot list sent (%d)\n", shotCount);
      }
    }

    // ── GPS data notify 1Hz ────────────────────────
    if (millis() - lastGpsNotify >= 1000) {
      lastGpsNotify = millis();
      String json = buildGpsJson();
      pGpsChar->setValue(json.c_str());
      pGpsChar->notify();
    }

    // ── RTCM KB milestone ─────────────────────────
    {
      uint32_t curKB = ntripBytes / 1024;
      if (curKB > lastRtcmKB) { lastRtcmKB = curKB; sendDbg("RTCM " + String(curKB) + " KB rcvd"); }
    }

    // ── NMEA sentences notify 5s ───────────────────
    if (millis() - lastNmeaNotify >= 5000) {
      lastNmeaNotify = millis();
      String n = "{\"type\":\"nmea\"";
      n += ",\"gga\":\"" + jsonEsc(String(lastGGA)) + "\"";
      n += ",\"gsa\":\"" + jsonEsc(String(lastGSA)) + "\"";
      n += ",\"rmc\":\"" + jsonEsc(String(lastRMC)) + "\"}";
      pGpsChar->setValue(n.c_str());
      pGpsChar->notify();
      delay(5);
      // Send GSV satellite data as a separate notification
      if (gsvCount > 0) {
        String g = "{\"type\":\"gsv\",\"sentences\":[";
        for (int i = 0; i < gsvCount; i++) {
          if (i > 0) g += ',';
          g += '"'; g += jsonEsc(String(lastGSV[i])); g += '"';
        }
        g += "]}";
        if (g.length() < 500) {
          pGpsChar->setValue(g.c_str());
          pGpsChar->notify();
        }
      }
    }
  }

  updateLED();
}
