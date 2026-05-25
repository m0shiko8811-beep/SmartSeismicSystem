/*
 * GPS Survey Tool v6 — BLE Edition
 * ESP32 + NEO-M9N + HW-478 RGB LED
 *
 * Wiring:
 *   GPS TX  → GPIO 16  (ESP32 receives NMEA)
 *   GPS RX  → GPIO 17  (ESP32 sends RTCM corrections)
 *   RGB R   → GPIO 25
 *   RGB G   → GPIO 26
 *   RGB B   → GPIO 27
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

char  lastGGA[82] = "";
char  lastGSA[82] = "";
char  lastRMC[82] = "";
char  nmeaBuf[82];
int   nmeaIdx = 0;

// ── Survey config ─────────────────────────────────────
int   lineNum     = 1001;
int   stationNum  = 1;
int   stationStep = 1;
bool  countUp     = true;
float minAccM     = 0.0f;
float maxAccM     = 10.0f;

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
  char   gga[82], gsa[82], rmc[82];
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
bool          avgDone    = false;
double        avgFinalLat=0, avgFinalLon=0, avgFinalAlt=0;
float         avgFinalHdop = 0;
char          avgFinalLabel[24] = "";
char          avgFinalTs[24]    = "";

// ── LED ───────────────────────────────────────────────
int           saveFlashSteps = 0;
unsigned long ledTimer       = 0;
bool          ledOn          = false;

// ── NTRIP (bytes piped from phone over BLE) ───────────
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

// ──────────────────────────────────────────────────────
// BLE Server Callbacks
// ──────────────────────────────────────────────────────
class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer*) override {
    bleConnected = true;
    wpListPending = true;
    wpListSendIdx = 0;
    Serial.println("[BLE] Phone connected");
  }
  void onDisconnect(BLEServer*) override {
    bleConnected = false;
    Serial.println("[BLE] Phone disconnected — restarting advertising");
    BLEDevice::startAdvertising();
  }
};

// ──────────────────────────────────────────────────────
// Command Characteristic Callback
// ──────────────────────────────────────────────────────
class CmdCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* c) override {
    std::string val = c->getValue();
    handleCommand(String(val.c_str()));
  }
};

// ──────────────────────────────────────────────────────
// RTCM Characteristic Callback — pipes bytes to GPS RX
// ──────────────────────────────────────────────────────
class RtcmCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* c) override {
    std::string val = c->getValue();
    if (val.length() > 0) {
      GPS_Serial.write(reinterpret_cast<const uint8_t*>(val.data()), val.length());
      ntripBytes += val.length();
      ntripLastAt = millis();
    }
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
    f.printf("%s|%.7f|%.7f|%.2f|%.2f|%d|%s|%s|%s|%s\n",
      w.label, w.lat, w.lon, w.alt, w.hdop, w.fixQ, w.ts,
      w.gga, w.gsa, w.rmc);
  }
  f.close();
  Serial.printf("[FS] Saved %d waypoints\n", wpCount);
}

void loadWaypointsFromFlash() {
  File f = LittleFS.open(WP_FILE, "r");
  if (!f) { Serial.println("[FS] No waypoints file"); return; }
  wpCount = 0;
  while (f.available() && wpCount < WP_MAX) {
    String line = f.readStringUntil('\n'); line.trim();
    if (line.length() < 5) continue;
    WP& w = wpList[wpCount];
    char buf[512]; strncpy(buf, line.c_str(), 511); buf[511] = '\0';
    char* t = strtok(buf, "|");
    if (!t) continue; strncpy(w.label, t, 23); w.label[23] = '\0';
    t = strtok(NULL, "|"); if (!t) continue; w.lat  = atof(t);
    t = strtok(NULL, "|"); if (!t) continue; w.lon  = atof(t);
    t = strtok(NULL, "|"); if (!t) continue; w.alt  = atof(t);
    t = strtok(NULL, "|"); if (!t) continue; w.hdop = atof(t);
    t = strtok(NULL, "|"); if (!t) continue; w.fixQ = atoi(t);
    t = strtok(NULL, "|"); if (!t) continue; strncpy(w.ts, t, 23); w.ts[23] = '\0';
    t = strtok(NULL, "|"); if (t) { strncpy(w.gga, t, 81); w.gga[81] = '\0'; } else w.gga[0] = '\0';
    t = strtok(NULL, "|"); if (t) { strncpy(w.gsa, t, 81); w.gsa[81] = '\0'; } else w.gsa[0] = '\0';
    t = strtok(NULL, "|"); if (t) { strncpy(w.rmc, t, 81); w.rmc[81] = '\0'; } else w.rmc[0] = '\0';
    w.id = wpCount + 1;
    lastWPLat = w.lat; lastWPLon = w.lon; hasLastWP = true;
    wpCount++;
  }
  f.close();
  Serial.printf("[FS] Loaded %d waypoints\n", wpCount);
}

// ── LED ───────────────────────────────────────────────
void setRGB(uint8_t r, uint8_t g, uint8_t b) {
  analogWrite(LED_R, r);
  analogWrite(LED_G, g);
  analogWrite(LED_B, b);
}
void triggerSaveFlash() {
  saveFlashSteps = 8; ledTimer = millis();
}
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
  float hdop = gps.hdop.isValid() && gps.hdop.age() < 3000
               ? gps.hdop.value() / 100.0f : 0;
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
  w.alt  = gps.altitude.isValid() ? gps.altitude.meters() : 0;
  w.hdop = gps.hdop.isValid() ? gps.hdop.value() / 100.0f : 0;
  w.fixQ = getFixQuality();
  strncpy(w.label, lbl, 23); w.label[23] = '\0';
  strncpy(w.gga, lastGGA, 81); w.gga[81] = '\0';
  strncpy(w.gsa, lastGSA, 81); w.gsa[81] = '\0';
  strncpy(w.rmc, lastRMC, 81); w.rmc[81] = '\0';
  if (gps.date.isValid() && gps.time.isValid())
    snprintf(w.ts, 24, "%04d-%02d-%02dT%02d:%02d:%02d",
      gps.date.year(), gps.date.month(), gps.date.day(),
      gps.time.hour(), gps.time.minute(), gps.time.second());
  else strncpy(w.ts, "no-time", 24);
  lastWPLat = w.lat; lastWPLon = w.lon; hasLastWP = true;
  wpCount++;
  if (adv) stationNum += countUp ? stationStep : -stationStep;
  triggerSaveFlash();
  Serial.printf("[WP] Saved %s: %.6f,%.6f FQ:%d\n", lbl, w.lat, w.lon, w.fixQ);
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
  strncpy(w.gga, lastGGA, 81); w.gga[81] = '\0';
  strncpy(w.gsa, lastGSA, 81); w.gsa[81] = '\0';
  strncpy(w.rmc, lastRMC, 81); w.rmc[81] = '\0';
  if (gps.date.isValid() && gps.time.isValid())
    snprintf(w.ts, 24, "%04d-%02d-%02dT%02d:%02d:%02d",
      gps.date.year(), gps.date.month(), gps.date.day(),
      gps.time.hour(), gps.time.minute(), gps.time.second());
  else strncpy(w.ts, "no-time", 24);
  lastWPLat = lat; lastWPLon = lon; hasLastWP = true;
  avgFinalLat = lat; avgFinalLon = lon;
  avgFinalAlt = alt; avgFinalHdop = hdop;
  strncpy(avgFinalLabel, lbl, 23); avgFinalLabel[23] = '\0';
  strncpy(avgFinalTs, w.ts, 23);   avgFinalTs[23]    = '\0';
  wpCount++;
  if (adv) stationNum += countUp ? stationStep : -stationStep;
  saveFlashSteps = 12; ledTimer = millis();
  Serial.printf("[WP] AVG Saved %s: %.6f,%.6f\n", lbl, lat, lon);
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
  j += ",\"alt\":"  + String(gps.altitude.isValid() ? gps.altitude.meters() : 0.0, 2);
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
  if (avgDone) {
    j += ",\"avgDone\":true,\"lastAvg\":{";
    j += "\"label\":\"" + jsonEsc(String(avgFinalLabel)) + "\"";
    j += ",\"lat\":"  + String(avgFinalLat, 7);
    j += ",\"lon\":"  + String(avgFinalLon, 7);
    j += ",\"alt\":"  + String(avgFinalAlt, 2);
    j += ",\"hdop\":" + String(avgFinalHdop, 2);
    j += ",\"ts\":\"" + String(avgFinalTs) + "\"";
    j += ",\"next_line\":" + String(lineNum);
    j += ",\"next_sta\":"  + String(stationNum) + "}";
    avgDone = false;
  } else j += ",\"avgDone\":false,\"lastAvg\":null";
  j += ",\"wpCount\":"     + String(wpCount);
  j += ",\"ntripState\":\"" + String(ntActive ? "streaming" : "idle") + "\"";
  j += ",\"ntripBytes\":"  + String(ntripBytes);
  j += ",\"cfg\":{\"line\":" + String(lineNum);
  j += ",\"sta\":"  + String(stationNum);
  j += ",\"step\":" + String(stationStep);
  j += ",\"up\":"   + String(countUp ? "true" : "false") + "}";
  j += "}";
  return j;
}

// ── Command handler ───────────────────────────────────
void handleCommand(const String& msg) {
  Serial.printf("[CMD] %s\n", msg.c_str());

  // Extracts a quoted string value for a key: "key":"value"
  auto strVal = [&](const char* key) -> String {
    String needle = String("\"") + key + "\":\"";
    int s = msg.indexOf(needle);
    if (s < 0) return "";
    int start = s + needle.length();
    int end   = msg.indexOf('"', start);
    return end > start ? msg.substring(start, end) : "";
  };
  // Extracts a numeric value for a key: "key":123
  auto intVal = [&](const char* key) -> int {
    String needle = String("\"") + key + "\":";
    int s = msg.indexOf(needle);
    if (s < 0) return -1;
    return msg.substring(s + needle.length()).toInt();
  };
  // Extracts a bool value: "key":true/false  → 1/0/-1
  auto boolVal = [&](const char* key) -> int {
    String needle = String("\"") + key + "\":";
    int s = msg.indexOf(needle);
    if (s < 0) return -1;
    int vs = s + needle.length();
    if (msg.substring(vs, vs + 4) == "true")  return 1;
    if (msg.substring(vs, vs + 5) == "false") return 0;
    return -1;
  };

  if (msg.indexOf("\"wp_save\"") >= 0) {
    String lbl = strVal("label");
    if (lbl.isEmpty()) lbl = String(lineNum) + ":" + String(stationNum);
    if (gps.location.isValid() && gps.location.age() < 5000)
      addWP(lbl.c_str(), true);
    else Serial.println("[CMD] wp_save ignored — no valid fix");

  } else if (msg.indexOf("\"avg_start\"") >= 0) {
    String lbl = strVal("label");
    if (lbl.isEmpty()) lbl = String(lineNum) + ":" + String(stationNum);
    avgLabel = lbl;
    if (!averaging) {
      avgLat = avgLon = avgAlt = avgHdop = 0; avgCount = 0;
      averaging = true; avgDone = false;
      avgNextAt = millis(); avgTimeout = millis() + 30000;
    }

  } else if (msg.indexOf("\"avg_cancel\"") >= 0) {
    averaging = false; avgCount = 0;

  } else if (msg.indexOf("\"wp_list\"") >= 0) {
    wpListPending = true;
    wpListSendIdx = 0;

  } else if (msg.indexOf("\"wp_clear\"") >= 0) {
    wpCount = 0; hasLastWP = false;
    LittleFS.remove(WP_FILE);
    Serial.println("[CMD] All waypoints cleared");

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
    if (ln >= 0)  { lineNum     = ln; cfgPrefs.putInt("line",  lineNum);     }
    if (sn >= 0)  { stationNum  = sn; cfgPrefs.putInt("sta",   stationNum);  }
    if (st >  0)  { stationStep = st; cfgPrefs.putInt("step",  stationStep); }
    if (up >= 0)  { countUp     = up; cfgPrefs.putBool("up",   countUp);     }
    Serial.printf("[CMD] cfg: line=%d sta=%d step=%d up=%d\n",
      lineNum, stationNum, stationStep, (int)countUp);

  } else if (msg.indexOf("\"acc_filter\"") >= 0) {
    String needle_min = "\"min\":";
    String needle_max = "\"max\":";
    int mn = msg.indexOf(needle_min);
    int mx = msg.indexOf(needle_max);
    if (mn >= 0) minAccM = msg.substring(mn + needle_min.length()).toFloat();
    if (mx >= 0) maxAccM = msg.substring(mx + needle_max.length()).toFloat();
  }
}

// ──────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  GPS_Serial.begin(38400, SERIAL_8N1, GPS_MODULE_TX, GPS_MODULE_RX);

  pinMode(LED_R, OUTPUT);
  pinMode(LED_G, OUTPUT);
  pinMode(LED_B, OUTPUT);
  setRGB(160, 0, 0); // red = starting up

  cfgPrefs.begin("survey", false);
  lineNum     = cfgPrefs.getInt("line",  1001);
  stationNum  = cfgPrefs.getInt("sta",   1);
  stationStep = cfgPrefs.getInt("step",  1);
  countUp     = cfgPrefs.getBool("up",   true);
  Serial.printf("[CFG] line=%d sta=%d step=%d dir=%s\n",
    lineNum, stationNum, stationStep, countUp ? "up" : "dn");

  if (LittleFS.begin(true)) {
    loadWaypointsFromFlash();
  } else {
    Serial.println("[FS] LittleFS mount failed");
  }

  // ── BLE setup ─────────────────────────────────────
  BLEDevice::init("GPS-Survey");
  BLEDevice::setMTU(512);

  pServer = BLEDevice::createServer();
  pServer->setCallbacks(new ServerCallbacks());

  BLEService* pSvc = pServer->createService(SERVICE_UUID);

  pGpsChar = pSvc->createCharacteristic(
    GPS_CHAR_UUID,
    BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY
  );
  pGpsChar->addDescriptor(new BLE2902());
  pGpsChar->setValue("{}");

  BLECharacteristic* pCmdChar = pSvc->createCharacteristic(
    CMD_CHAR_UUID,
    BLECharacteristic::PROPERTY_WRITE
  );
  pCmdChar->setCallbacks(new CmdCallbacks());

  BLECharacteristic* pRtcmChar = pSvc->createCharacteristic(
    RTCM_CHAR_UUID,
    BLECharacteristic::PROPERTY_WRITE_NR
  );
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
static unsigned long lastGpsNotify = 0;
static unsigned long lastWpNotify  = 0;

void loop() {
  // ── GPS serial read ───────────────────────────────
  while (GPS_Serial.available()) {
    char c = GPS_Serial.read();
    if (c == '\n') {
      nmeaBuf[nmeaIdx] = '\0';
      if (strncmp(nmeaBuf, "$GPGGA", 6) == 0 || strncmp(nmeaBuf, "$GNGGA", 6) == 0)
        { strncpy(lastGGA, nmeaBuf, 81); lastGGA[81] = '\0'; }
      if (strncmp(nmeaBuf, "$GPGSA", 6) == 0 || strncmp(nmeaBuf, "$GNGSA", 6) == 0)
        { strncpy(lastGSA, nmeaBuf, 81); lastGSA[81] = '\0'; }
      if (strncmp(nmeaBuf, "$GPRMC", 6) == 0 || strncmp(nmeaBuf, "$GNRMC", 6) == 0)
        { strncpy(lastRMC, nmeaBuf, 81); lastRMC[81] = '\0'; }
      nmeaIdx = 0;
    } else if (c != '\r' && nmeaIdx < 81) {
      nmeaBuf[nmeaIdx++] = c;
    }
    gps.encode(c);
  }

  // ── Point averaging ───────────────────────────────
  if (averaging) {
    unsigned long now = millis();
    if (now >= avgTimeout) {
      averaging = false; avgCount = 0;
      Serial.println("[AVG] Timeout");
    } else if (now >= avgNextAt && gps.location.isValid() && gps.location.age() < 2000) {
      avgLat  += gps.location.lat();
      avgLon  += gps.location.lng();
      avgAlt  += gps.altitude.isValid() ? gps.altitude.meters() : 0;
      avgHdop += gps.hdop.isValid() ? gps.hdop.value() / 100.0f : 0;
      avgCount++;
      avgNextAt = now + AVG_MS;
      Serial.printf("[AVG] %d/%d\n", avgCount, AVG_TOTAL);
      if (avgCount >= AVG_TOTAL) {
        averaging = false;
        addWPManual(avgLabel.c_str(),
          avgLat / AVG_TOTAL, avgLon / AVG_TOTAL,
          avgAlt / AVG_TOTAL, avgHdop / AVG_TOTAL, true);
        avgDone = true;
      }
    }
  }

  if (bleConnected) {
    // ── Waypoint list flush (on connect or on demand) ─
    if (wpListPending && millis() - lastWpNotify >= 30) {
      lastWpNotify = millis();
      if (wpListSendIdx < wpCount) {
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
      }
    }

    // ── GPS data notify (1 Hz, skip during wp list flush) ─
    if (!wpListPending && millis() - lastGpsNotify >= 1000) {
      lastGpsNotify = millis();
      String json = buildGpsJson();
      pGpsChar->setValue(json.c_str());
      pGpsChar->notify();
    }
  }

  updateLED();
}
