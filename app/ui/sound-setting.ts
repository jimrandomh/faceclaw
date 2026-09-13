/**
 * The "Sound: on/off" entry in a game's context menu, persisted per app under
 * `<appId>.soundOn` so each game remembers its own choice across launches.
 * Reads default to on; storage failures fall back to on and never throw.
 */
import { getBooleanSetting, setBooleanSetting } from "../native/settings-store";

function soundKey(appId: string): string {
  return `${appId}.soundOn`;
}

export function loadSoundEnabled(appId: string): boolean {
  try {
    return getBooleanSetting(soundKey(appId), true);
  } catch {
    return true;
  }
}

export function saveSoundEnabled(appId: string, enabled: boolean): void {
  try {
    setBooleanSetting(soundKey(appId), enabled);
  } catch (error) {
    console.warn(`${appId} sound setting save failed: ${error}`);
  }
}
