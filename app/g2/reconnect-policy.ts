/**
 * Manual-disconnected state: distinguishes "disconnected and happy to
 * auto-reconnect" (app launch, a BLE drop) from "disconnected on purpose"
 * (the user picked Disconnect, the flash flow needs the glasses to itself,
 * or the connected firmware turned out to be incompatible). While suppressed,
 * the main page's auto-connect must not re-dial the glasses; only an explicit
 * connect or a successful firmware install lifts it.
 *
 * Lives in its own module (not on DashboardController) so the onboarding
 * flash flow can set it without instantiating the whole controller singleton.
 * Deliberately in-memory: a fresh app launch is a regular disconnect.
 */

let suppressed = false;

export function suppressAutoReconnect(): void {
  suppressed = true;
}

export function resumeAutoReconnect(): void {
  suppressed = false;
}

export function isAutoReconnectSuppressed(): boolean {
  return suppressed;
}

/**
 * Communicator phases in which the shared session core has parked its retry
 * loop for good: "unpaired" (an arm's OS bond is gone) and
 * "incompatible-firmware" (the glasses run firmware this app can't use).
 * Redialing would fail the same way, so both platform controllers tear the
 * session down into the manual-disconnected state on these.
 */
export type HaltedSessionPhase = "unpaired" | "incompatible-firmware";

export function isHaltedSessionPhase(phase: string): phase is HaltedSessionPhase {
  return phase === "unpaired" || phase === "incompatible-firmware";
}
