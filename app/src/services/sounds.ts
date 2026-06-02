import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio';

// Native audio via expo-audio. Replaces the old hidden-WebView AudioProvider
// (which was disabled because a second WebView was suspected of stealing touches
// from the Leaflet map WebView — so shot/waypoint sounds played nothing). No
// WebView is involved now, so there is no possible conflict with the map.

let shotPlayer: AudioPlayer | null = null;
let wpPlayer: AudioPlayer | null = null;

export async function initSounds(): Promise<void> {
  try {
    await setAudioModeAsync({ playsInSilentMode: true });
  } catch {}
  if (!shotPlayer) shotPlayer = createAudioPlayer(require('../../assets/sounds/shot.wav'));
  if (!wpPlayer)   wpPlayer   = createAudioPlayer(require('../../assets/sounds/wp.wav'));
}

function play(p: AudioPlayer | null): void {
  if (!p) return;
  try { void p.seekTo(0); p.play(); } catch {}
}

export function playShotSound(): void {
  if (!shotPlayer) shotPlayer = createAudioPlayer(require('../../assets/sounds/shot.wav'));
  play(shotPlayer);
}

export function playWpSound(): void {
  if (!wpPlayer) wpPlayer = createAudioPlayer(require('../../assets/sounds/wp.wav'));
  play(wpPlayer);
}

// Deprecated no-op — kept so the old AudioProvider.tsx (no longer mounted) still
// compiles if it is ever re-imported. Safe to delete along with AudioProvider.tsx.
export function setAudioRef(_ref: unknown): void {}
