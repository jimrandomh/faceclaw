/**
 * Whether the glasses could carry an alert right now: connected over BLE, on
 * a head, and not charging. Fed by the dashboard controller from the
 * transport's phase, wear-state and battery reports; consumed by the Timers
 * engine, which mirrors it to the phone's alarm clock so the phone knows
 * when to add its own sound.
 */

export type GlassesPresence = {
  connected: boolean;
  /** null until the firmware has reported a wear state this session. */
  worn: boolean | null;
  charging: boolean;
};

let presence: GlassesPresence = { connected: false, worn: null, charging: false };
const listeners = new Set<(presence: GlassesPresence) => void>();

export function getGlassesPresence(): GlassesPresence {
  return presence;
}

/** True when a fresh, positive report says the glasses are worn and usable. */
export function glassesCanCarryAlert(current: GlassesPresence = presence): boolean {
  return current.connected && current.worn === true && !current.charging;
}

export function updateGlassesPresence(patch: Partial<GlassesPresence>): void {
  const next = { ...presence, ...patch };
  if (next.connected === presence.connected && next.worn === presence.worn && next.charging === presence.charging) return;
  presence = next;
  for (const listener of Array.from(listeners)) {
    try {
      listener(presence);
    } catch (error) {
      console.warn(`glasses presence listener failed: ${error}`);
    }
  }
}

export function onGlassesPresenceChanged(listener: (presence: GlassesPresence) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
