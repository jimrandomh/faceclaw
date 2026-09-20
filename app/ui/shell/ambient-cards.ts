/**
 * Ambient cards: small, non-interactive popups the shell chrome paints at the
 * bottom-right of the screen, stacking upward — used for the "you know this
 * person" encounter popup when captions recognize a familiar voice. Unlike
 * the notification modal they never take input or focus: they appear, sit
 * quietly for a few seconds, and expire on their own.
 *
 * Pure store + change notification; painting lives in the chrome layer, and
 * the shell subscribes to changes to request repaints.
 */

export type AmbientCard = {
  /** Stable identity: posting the same id replaces the existing card. */
  id: string;
  /** Bright first line (e.g. "Alice · 2d ago"). */
  title: string;
  /** Dimmer detail lines (fact, action items); painted in order, truncated to fit. */
  lines: string[];
  expiresAtMs: number;
};

const cards: AmbientCard[] = [];
const listeners = new Set<() => void>();
let expiryTimer: ReturnType<typeof setTimeout> | null = null;

/** Cards still alive, oldest first (painted bottom-up, so oldest sits lowest). */
export function activeAmbientCards(nowMs = Date.now()): AmbientCard[] {
  prune(nowMs);
  return cards;
}

/** Post (or refresh) a card; repaints happen via the change listeners. */
export function postAmbientCard(card: AmbientCard): void {
  const index = cards.findIndex((existing) => existing.id === card.id);
  if (index >= 0) {
    cards.splice(index, 1);
  }
  cards.push(card);
  scheduleExpiry();
  notify();
}

export function dismissAmbientCard(id: string): void {
  const index = cards.findIndex((existing) => existing.id === id);
  if (index >= 0) {
    cards.splice(index, 1);
    notify();
  }
}

export function onAmbientCardsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function prune(nowMs: number): void {
  const before = cards.length;
  for (let index = cards.length - 1; index >= 0; index--) {
    if (cards[index]!.expiresAtMs <= nowMs) {
      cards.splice(index, 1);
    }
  }
  if (cards.length !== before) {
    scheduleExpiry();
  }
}

/** One timer for the next expiry, so a card's disappearance also repaints. */
function scheduleExpiry(): void {
  if (expiryTimer !== null) {
    clearTimeout(expiryTimer);
    expiryTimer = null;
  }
  if (!cards.length) return;
  const next = Math.min(...cards.map((card) => card.expiresAtMs));
  expiryTimer = setTimeout(() => {
    expiryTimer = null;
    prune(Date.now());
    notify();
  }, Math.max(50, next - Date.now()));
}

function notify(): void {
  listeners.forEach((listener) => {
    try {
      listener();
    } catch (error) {
      console.warn(`ambient card listener failed: ${error}`);
    }
  });
}
