#pragma once
#include <Arduino.h>

// ── Seismic shot trigger ────────────────────────────────────────────────────
// Hammer head → GPIO32 (INPUT_PULLUP), plate → GND.
// Contact closure fires FALLING-edge ISR → millisecond-precise GPS timestamp.
// NOTE: GPIO 34-39 are input-only with NO internal pull-up — use GPIO 32/33.

#define SHOT_FILE   "/shots.dat"
#define SHOT_MAX    200
#define TRIGGER_PIN 32

struct Shot {
  int    id;
  int    line, sp;
  double lat, lon, alt;
  float  hdop;
  int    fixQ;
  char   ts[28];
};

struct ShotCfg {
  int  line        = 1001;
  int  sp          = 1;
  int  step        = 1;
  int  debounce    = 500;
  bool edgeFalling = true;
};

extern Shot              shotList[SHOT_MAX];
extern int               shotCount;
extern ShotCfg           shotCfg;
extern volatile bool     shotPending;
extern volatile uint32_t shotMillis;
extern unsigned long     lastShotAt;
extern volatile bool     shotListPending;
extern volatile int      shotListSendIdx;
extern bool              shotEventPending;
extern int               shotEventIdx;

void IRAM_ATTR onTrigger();
void saveShotsToFlash();
void appendShotToFlash(const Shot& sh);
void loadShotsFromFlash();
void updateTriggerInterrupt();
void addShot();
