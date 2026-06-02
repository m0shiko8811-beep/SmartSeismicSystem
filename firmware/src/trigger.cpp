#include "trigger.h"
#include <LittleFS.h>
#include <TinyGPSPlus.h>
#include <Preferences.h>

// Provided by main.cpp
extern TinyGPSPlus gps;
extern float       antennaHeight;
extern Preferences cfgPrefs;
void buildTimestampAt(char* ts, size_t len, uint32_t capturedMillis);
void sendDbg(const String& msg);
int  getFixQuality();

// ── Definitions ────────────────────────────────────────
Shot              shotList[SHOT_MAX];
int               shotCount       = 0;
ShotCfg           shotCfg;
volatile bool     shotPending     = false;
volatile uint32_t shotMillis      = 0;
unsigned long     lastShotAt      = 0;
volatile bool     shotListPending = false;
volatile int      shotListSendIdx = 0;
bool              shotEventPending = false;
int               shotEventIdx    = -1;

// ── ISR ────────────────────────────────────────────────
void IRAM_ATTR onTrigger() {
  shotPending = true;
  shotMillis  = (uint32_t)millis();
}

// ── Flash persistence ──────────────────────────────────
void saveShotsToFlash() {
  File f = LittleFS.open(SHOT_FILE, "w");
  if (!f) { Serial.println("[FS] shot write failed"); return; }
  for (int i = 0; i < shotCount; i++) {
    Shot& sh = shotList[i];
    f.printf("%d|%d|%d|%.7f|%.7f|%.2f|%.2f|%d|%s\n",
      sh.id, sh.line, sh.sp, sh.lat, sh.lon, sh.alt, sh.hdop, sh.fixQ, sh.ts);
  }
  f.close();
  Serial.printf("[FS] Saved %d shots\n", shotCount);
}

// Append a single shot line — avoids rewriting the whole file on every shot
// (less LittleFS wear, no O(n) blocking write right after the trigger ISR).
void appendShotToFlash(const Shot& sh) {
  File f = LittleFS.open(SHOT_FILE, "a");
  if (!f) { Serial.println("[FS] shot append failed"); return; }
  f.printf("%d|%d|%d|%.7f|%.7f|%.2f|%.2f|%d|%s\n",
    sh.id, sh.line, sh.sp, sh.lat, sh.lon, sh.alt, sh.hdop, sh.fixQ, sh.ts);
  f.close();
}

void loadShotsFromFlash() {
  File f = LittleFS.open(SHOT_FILE, "r");
  if (!f) { Serial.println("[FS] No shots file"); return; }
  shotCount = 0;
  while (f.available() && shotCount < SHOT_MAX) {
    String ln = f.readStringUntil('\n'); ln.trim();
    if (ln.length() < 5) continue;
    Shot& sh = shotList[shotCount];
    char buf[256]; strncpy(buf, ln.c_str(), 255); buf[255] = '\0';
    char* t = strtok(buf, "|");
    if (!t) continue; sh.id   = atoi(t);
    t = strtok(NULL, "|"); if (!t) continue; sh.line = atoi(t);
    t = strtok(NULL, "|"); if (!t) continue; sh.sp   = atoi(t);
    t = strtok(NULL, "|"); if (!t) continue; sh.lat  = atof(t);
    t = strtok(NULL, "|"); if (!t) continue; sh.lon  = atof(t);
    t = strtok(NULL, "|"); if (!t) continue; sh.alt  = atof(t);
    t = strtok(NULL, "|"); if (!t) continue; sh.hdop = atof(t);
    t = strtok(NULL, "|"); if (!t) continue; sh.fixQ = atoi(t);
    t = strtok(NULL, "|"); if (!t) continue; strncpy(sh.ts, t, 27); sh.ts[27] = '\0';
    shotCount++;
  }
  f.close();
  Serial.printf("[FS] Loaded %d shots\n", shotCount);
}

// ── Interrupt wiring ───────────────────────────────────
void updateTriggerInterrupt() {
  detachInterrupt(digitalPinToInterrupt(TRIGGER_PIN));
  attachInterrupt(digitalPinToInterrupt(TRIGGER_PIN), onTrigger,
    shotCfg.edgeFalling ? FALLING : RISING);
}

// ── Record a shot ──────────────────────────────────────
void addShot() {
  if (shotCount >= SHOT_MAX) return;
  Shot& sh = shotList[shotCount];
  sh.id   = shotCount + 1;
  sh.line = shotCfg.line;
  sh.sp   = shotCfg.sp;
  sh.lat  = gps.location.isValid() ? gps.location.lat() : 0.0;
  sh.lon  = gps.location.isValid() ? gps.location.lng() : 0.0;
  sh.alt  = (gps.altitude.isValid() ? gps.altitude.meters() : 0) - antennaHeight;
  sh.hdop = gps.hdop.isValid() ? gps.hdop.value() / 100.0f : 0;
  sh.fixQ = getFixQuality();
  buildTimestampAt(sh.ts, sizeof(sh.ts), shotMillis);
  shotEventIdx     = shotCount;
  shotEventPending = true;
  shotCount++;
  shotCfg.sp += shotCfg.step;
  appendShotToFlash(sh);
  cfgPrefs.putInt("sh_sp", shotCfg.sp);
  Serial.printf("[SHOT] #%d L%d:SP%d ts=%s fq=%d\n", sh.id, sh.line, sh.sp, sh.ts, sh.fixQ);
  sendDbg("SHOT #" + String(sh.id) + " L" + String(sh.line) + ":SP" + String(sh.sp));
}
