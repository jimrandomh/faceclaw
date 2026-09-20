/** One touch recognizer for a phone pad or mirror. Coordinates are in DIP. */
declare function setTimeout(callback: () => void, ms: number): number
declare function clearTimeout(id: number): void
export type PhoneGesture = 'tap' | 'double-tap' | 'long-press' | 'long-press-release'
  | 'short-then-long-press' | 'swipe-up' | 'swipe-down' | 'swipe-left' | 'swipe-right'
export type PhoneTouch = { action: 'down' | 'move' | 'up' | 'cancel'; x: number; y: number; pointers: number }
export type GestureClock = { set: (callback: () => void, ms: number) => unknown; clear: (id: unknown) => void }
const clock: GestureClock = { set: (callback, ms) => setTimeout(callback, ms), clear: id => clearTimeout(id as ReturnType<typeof setTimeout>) }

export class PhoneGestureRecognizer {
  private start: PhoneTouch | null = null
  private hold: unknown = null
  private tap: unknown = null
  private lastTap: { x: number; y: number } | null = null
  private holding = false
  private moved = false
  private multi = false
  private secondTap = false
  constructor(private readonly emit: (gesture: PhoneGesture, x: number, y: number) => void,
    private readonly timer: GestureClock = clock) {}

  touch(event: PhoneTouch): void {
    if (event.action === 'cancel') { this.cancel(); return }
    if (event.action === 'down' && !this.start) {
      this.start = event
      this.holding = this.moved = this.multi = false
      this.secondTap = !!this.lastTap && Math.hypot(event.x - this.lastTap.x, event.y - this.lastTap.y) < 36
      if (this.secondTap) { this.clearTap() }
      else if (this.lastTap) { const tap = this.lastTap; this.clearTap(); this.emit('tap', tap.x, tap.y) }
      this.hold = this.timer.set(() => {
        this.hold = null
        if (!this.start || this.moved || this.multi) return
        this.holding = true
        this.emit(this.secondTap ? 'short-then-long-press' : 'long-press', this.start.x, this.start.y)
      }, 500)
    }
    if (!this.start) return
    if (event.pointers > 1) { this.multi = true; this.clearHold(); this.clearTap() }
    const dx = event.x - this.start.x, dy = event.y - this.start.y
    if (Math.hypot(dx, dy) > 14) { this.moved = true; this.clearHold() }
    if (event.action !== 'up') return
    // Some platforms emit an up for each finger. Complete the multi-touch
    // gesture only once, and suppress the trailing one-finger up events.
    this.clearHold()
    const start = this.start
    this.start = null
    if (this.holding) { this.emit('long-press-release', start.x, start.y); this.holding = false; return }
    if (this.multi) { this.emit('double-tap', start.x, start.y); return }
    if (Math.max(Math.abs(dx), Math.abs(dy)) >= 30) {
      this.emit(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'swipe-right' : 'swipe-left') : (dy > 0 ? 'swipe-down' : 'swipe-up'), start.x, start.y)
    } else if (!this.moved) {
      if (this.secondTap) this.emit('double-tap', start.x, start.y)
      else {
        this.lastTap = { x: start.x, y: start.y }
        this.tap = this.timer.set(() => {
          const tap = this.lastTap
          this.tap = null; this.lastTap = null
          if (tap) this.emit('tap', tap.x, tap.y)
        }, 280)
      }
    }
  }
  cancel(): void {
    this.clearHold(); this.clearTap()
    if (this.holding && this.start) this.emit('long-press-release', this.start.x, this.start.y)
    this.start = null; this.holding = false
  }
  private clearHold(): void { if (this.hold !== null) this.timer.clear(this.hold); this.hold = null }
  private clearTap(): void { if (this.tap !== null) this.timer.clear(this.tap); this.tap = null; this.lastTap = null }
}
