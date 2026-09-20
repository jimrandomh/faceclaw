/**
 * A tiny global signal for whether a voice-input modal (the assistant dialog)
 * is currently open. The shell sets it; the EvenHub mic router reads it to
 * decide whether an app may hold the glasses microphone — an app receives no
 * audio while the assistant is active, since both share the one G2 mic.
 *
 * Kept as a dependency-free leaf so both the shell and the EvenHub layer can
 * import it without a cycle.
 */

type Listener = (active: boolean) => void;

let active = false;
const listeners = new Set<Listener>();

export const voiceActivity = {
  isActive(): boolean {
    return active;
  },
  setActive(next: boolean): void {
    if (active === next) return;
    active = next;
    listeners.forEach((listener) => listener(active));
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
