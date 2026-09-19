import type { AndroidNotification } from '../native/notification-types'

export const ANCS_FIRMWARE_VERSION = 16
export const ANCS_CONNECT_MESSAGE = 'Connect glasses to receive iPhone notifications.'
const MAX_ACTIVE = 128
const MAX_RESPONSE = 2048
const HEADER = 11
const read32 = (b: Uint8Array, i: number) => (b[i] | b[i+1]<<8 | b[i+2]<<16 | b[i+3]<<24) >>> 0
const le32 = (n: number) => [n & 255, n>>>8 & 255, n>>>16 & 255, n>>>24]
// NativeScript does not supply TextDecoder in every isolate.
function utf8(bytes: Uint8Array): string {
  let result = ''
  for (let i=0; i<bytes.length;) {
    const first = bytes[i]
    if (first < 128) { result += String.fromCharCode(first); i++; continue }
    const count = first >= 0xc2 && first <= 0xdf ? 2 : first >= 0xe0 && first <= 0xef ? 3 : first >= 0xf0 && first <= 0xf4 ? 4 : 0
    if (!count) { result += '\uFFFD'; i++; continue }
    let code = first & (0x7f >> count), valid = i+count <= bytes.length
    for (let j=1; j<count && valid; j++) {
      if ((bytes[i+j] & 0xc0) !== 0x80) valid = false
      else code = (code << 6) | (bytes[i+j] & 63)
    }
    if (!valid || code < (count === 2 ? 128 : count === 3 ? 2048 : 65536) ||
        code > 0x10ffff || code >= 0xd800 && code <= 0xdfff) {
      result += '\uFFFD'; i++; continue
    }
    result += String.fromCodePoint(code); i += count
  }
  return result
}
type Source = { flags: number; category: number; revision: number; postTime: number; popup: boolean }
type Request = { uid: number; revision: number; action?: number; labels?: boolean }
export type AncsState = 'disconnected' | 'starting' | 'ready' | 'unavailable'

/** Owns one phone/lens BLE session. Nothing is persisted. Firmware enforces
 * peer ownership; token/sequence checks here additionally reject stale chunks. */
export class AncsClient {
  state: AncsState = 'disconnected'
  statusMessage = ANCS_CONNECT_MESSAGE
  private resetReceived = false
  private token = 0
  private lastStartToken = 0
  private sequence = 0
  private packetKind = -1
  private fragments: number[] = []
  private response: number[] = []
  private sources = new Map<number, Source>()
  private notifications = new Map<number, AndroidNotification>()
  private queue: Request[] = []
  private acknowledged = false
  private responseDone = false
  private pending: Request | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private retry: ReturnType<typeof setTimeout> | null = null
  private revision = 0
  private disposed = true
  constructor(private readonly send: (packet: Uint8Array) => Promise<void>,
    private readonly changed: (key?: string, popup?: boolean) => void,
    private readonly log: (message: string) => void = () => {}) {}

  private status(state: AncsState, message: string): void {
    this.state = state; this.statusMessage = message; this.log(message); this.changed()
  }

  start(token: number): void {
    this.stop(); this.disposed = false; this.token = token >>> 0 || 1
    this.begin()
  }
  private begin(): void {
    if (this.disposed) return
    this.clear(); this.resetReceived = false
    this.status('starting', 'Connecting to iPhone notifications…')
    this.deadline()
    const token = this.token
    this.lastStartToken = token
    void this.send(this.command(0)).catch(() => { if (token === this.token) this.recover() })
  }
  stop(message = ANCS_CONNECT_MESSAGE): void {
    this.disposed = true
    if (this.retry !== null) clearTimeout(this.retry)
    this.retry = null; this.clear(); this.token = 0
    this.status('disconnected', message)
  }
  stopCommand(): Uint8Array { return new Uint8Array([65,78,1,1,...le32(this.lastStartToken)]) }
  private clear(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null; this.sources.clear(); this.notifications.clear(); this.queue = []
    this.pending = null; this.response = []; this.fragments = []; this.packetKind = -1; this.sequence = 0
  }
  private recover(message = 'Notification relay interrupted. Retrying…'): void {
    if (this.disposed || this.retry !== null) return
    this.clear(); this.status('unavailable', message)
    // New token rejects every queued packet/response from the previous attempt.
    this.token = (this.token + 1) >>> 0 || 1
    this.retry = setTimeout(() => { this.retry = null; this.begin() }, 5000)
  }
  private deadline(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.recover(this.state === 'starting'
      ? this.resetReceived ? 'Glasses did not finish subscribing to iPhone notifications. Retrying…'
        : 'No notification relay response. Check Share System Notifications on the right lens. Retrying…'
      : 'Notification retrieval timed out. Retrying…'), 10000)
  }
  private command(op: number, payload: number[] = []): Uint8Array {
    return new Uint8Array([65,78,1,op,...le32(this.token),...payload])
  }
  read(limit = 50): AndroidNotification[] {
    return [...this.notifications.values()].sort((a,b) => b.postTime-a.postTime).slice(0, Math.max(0,limit))
      .map(n => ({...n, lines: [...n.lines], actions: n.actions.map(a => ({...a}))}))
  }
  action(key: string, action: number): boolean {
    const notification = [...this.notifications.entries()].find(([,n]) => n.key === key)
    if (this.state !== 'ready' || this.queue.length >= MAX_ACTIVE || !notification || ![0,1].includes(action) ||
        !notification[1].actions.some(a => a.index === action && a.enabled)) return false
    const [uid] = notification, source = this.sources.get(uid)!
    this.queue.push({uid, revision: source.revision, action}); this.pump(); return true
  }
  /** Local hide: ANCS negative action can decline a call, so Dismiss must never
   * silently translate into a destructive negative action. */
  dismiss(key: string): boolean {
    const entry = [...this.notifications.entries()].find(([,n]) => n.key === key)
    if (!entry) return false
    this.notifications.delete(entry[0]); this.sources.delete(entry[0]); this.changed(); return true
  }
  receive(packet: Uint8Array): boolean {
    if (packet[0] !== 65 || packet[1] !== 78) return false
    if (this.disposed || this.state === 'unavailable' || packet.length < HEADER || packet[2] !== 1 || read32(packet,4) !== this.token) return true
    const sequence = packet[8] | packet[9]<<8, flags = packet[10], kind = packet[3]
    if (sequence !== this.sequence || flags > 3 || kind > 3 || packet.length > 244) { this.recover(); return true }
    this.sequence = (sequence + 1) & 65535
    if (flags & 1) {
      if (this.packetKind !== -1) { this.recover(); return true }
      this.packetKind = kind; this.fragments = []
    }
    if (this.packetKind !== kind || this.fragments.length + packet.length - HEADER > 512) { this.recover(); return true }
    this.fragments.push(...packet.subarray(HEADER))
    if (flags & 2) {
      const data = new Uint8Array(this.fragments); this.fragments = []; this.packetKind = -1
      if (kind === 0) {
        if (data.length !== 1 || data[0] > 2) { this.recover(); return true }
        if (data[0] === 2) { this.recover('Glasses reported a notification relay error. Retrying…'); return true }
        if (data[0] === 0) { this.resetReceived = true; this.log('Glasses accepted notification relay START; awaiting subscription') }
        if (data[0] === 1) {
          if (this.timer !== null) clearTimeout(this.timer)
          this.timer = null; this.status('ready', 'No current iOS notifications.'); this.pump()
        }
      } else if (kind === 1) this.source(data)
      else if (kind === 2) this.attributes(data)
      else if (this.pending) {
        this.acknowledged = true
        if (this.pending.action !== undefined || this.responseDone) this.complete()
      }
    }
    return true
  }
  private source(data: Uint8Array): void {
    if (data.length !== 8 || data[0] > 2) { this.recover(); return }
    const uid = read32(data,4)
    if (data[0] === 2) {
      this.sources.delete(uid); this.notifications.delete(uid)
      this.queue = this.queue.filter(r => r.uid !== uid); this.changed(); return
    }
    const old = this.sources.get(uid)
    const source = {flags: data[1], category: data[2], revision: ++this.revision,
      postTime: old?.postTime ?? Date.now(), popup: !old && data[0] === 0 && !(data[1] & 4)}
    this.sources.set(uid, source)
    while (this.sources.size > MAX_ACTIVE) {
      const oldest = this.sources.keys().next().value!
      this.sources.delete(oldest); this.notifications.delete(oldest)
      this.queue = this.queue.filter(r => r.uid !== oldest)
    }
    this.queue = this.queue.filter(r => r.uid !== uid || r.action !== undefined)
    this.queue.push({uid, revision: source.revision}); this.pump()
  }
  private pump(): void {
    if (this.state !== 'ready' || this.pending) return
    while (this.queue.length) {
      const request = this.queue.shift()!
      if (this.sources.get(request.uid)?.revision !== request.revision) continue
      this.pending = request; this.response = []; this.acknowledged = this.responseDone = false; this.deadline()
      // Exactly three attributes, fits even the minimum 20-byte ATT payload.
      const cp = request.action === undefined
        ? request.labels ? [0,...le32(request.uid),6,7] : [0,...le32(request.uid),0,1,128,0,3,0,2]
        : [2,...le32(request.uid),request.action]
      const token = this.token
      void this.send(this.command(2,cp)).catch(() => { if (token === this.token) this.recover() })
      return
    }
  }
  private attributes(data: Uint8Array): void {
    if (!this.pending || this.pending.action !== undefined) return
    if (this.response.length + data.length > MAX_RESPONSE) { this.recover(); return }
    this.response.push(...data)
    const b = new Uint8Array(this.response)
    if (b.length < 5) return
    if (b[0] !== 0 || read32(b,1) !== this.pending.uid) { this.recover(); return }
    const expected = this.pending.labels ? [6,7] : [0,1,3]
    let cursor = 5
    const attrs = new Map<number,string>()
    while (cursor < b.length) {
      if (cursor+3 > b.length) return
      const id = b[cursor], length = b[cursor+1] | b[cursor+2]<<8
      if (!expected.includes(id) || attrs.has(id) || length > 512) { this.recover(); return }
      if (cursor+3+length > b.length) return
      attrs.set(id,utf8(b.subarray(cursor+3,cursor+3+length))); cursor += 3+length
    }
    if (attrs.size !== expected.length) return
    const {uid,revision} = this.pending, source = this.sources.get(uid)
    if (source?.revision === revision) {
      const key = `ancs:${this.token}:${uid}`
      if (this.pending.labels) {
        const notification = this.notifications.get(uid)
        if (notification) notification.actions = [
          ...(source.flags & 8 && attrs.get(6) ? [{index:0,title:attrs.get(6)!,enabled:true}] : []),
          ...(source.flags & 16 && attrs.get(7) ? [{index:1,title:attrs.get(7)!,enabled:true}] : []),
        ]
        const popup = source.popup; source.popup = false
        this.changed(key,popup)
      } else {
        const packageName = attrs.get(0)!, title = attrs.get(1)!, text = attrs.get(3)!
        this.notifications.set(uid,{key,packageName,appName:packageName,title,text,bigText:text,
          subText:'',infoText:'',summaryText:'',category:String(source.category),lines:[],postTime:source.postTime,when:source.postTime,actions:[],dismissLabel:'Hide on glasses'})
        if (source.flags & 24) {
          this.queue.unshift({uid,revision,labels:true}); this.changed(key,false)
        } else {
          const popup = source.popup; source.popup = false; this.changed(key,popup)
        }
      }
    }
    this.responseDone = true
    if (this.acknowledged) this.complete()
  }
  private complete(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null; this.pending = null; this.response = []; this.pump()
  }
}
