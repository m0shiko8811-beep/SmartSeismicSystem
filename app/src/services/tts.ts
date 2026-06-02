import * as Speech from 'expo-speech';

// Real text-to-speech via expo-speech. (The old version used
// AccessibilityInfo.announceForAccessibility, which is SILENT unless a screen
// reader like TalkBack is enabled — so voice prompts never played for normal users.)

export function speakWaypoint(label: string, fixQName: string, fromMap: boolean = false): void {
  const spoken = label.replace(/:/g, ' ');
  const suffix = fromMap ? 'from map' : fixQName;
  Speech.stop();
  Speech.speak(`${spoken}. ${suffix}`, { language: 'en-US' });
}

export function speakText(text: string): void {
  Speech.stop();
  Speech.speak(text, { language: 'en-US' });
}
