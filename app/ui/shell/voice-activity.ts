/**
 * A tiny global signal for whether speech capture owns the glasses
 * microphone: the assistant's voice dialog, a dictation draft, or
 * Transcribe's continuous capture. The EvenHub mic router and the
 * Microphones app read it to yield the one G2 mic while it is active — an
 * app receives no audio meanwhile, since they all share it.
 *
 * Each user holds it under its own name, so one finishing doesn't clear
 * another's hold. Set it before starting the capture and clear it after
 * releasing, so other mic users stand down first and resume after.
 *
 * Kept as a dependency-free leaf so both the shell and the EvenHub layer can
 * import it without a cycle.
 */

type Listener = (active: boolean) => void;

const holders = new Set<string>();
const listeners = new Set<Listener>();

export const voiceActivity = {
  isActive(): boolean {
    return holders.size > 0;
  },
  setActive(next: boolean, holder = "voice-input"): void {
    const was = holders.size > 0;
    if (next) holders.add(holder);
    else holders.delete(holder);
    const active = holders.size > 0;
    if (active === was) return;
    listeners.forEach((listener) => listener(active));
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
