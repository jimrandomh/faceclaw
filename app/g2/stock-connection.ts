import * as p from './ble-protocol'
import type { SessionTransport, SessionAddresses, TransportEvent } from './glasses-session'
import { hexToBytes } from '../util/hex-util'

declare function setTimeout(callback: () => void, ms: number): number
declare function clearTimeout(id: number): void

export const OTA_WRITE = '00002760-08c2-11e1-9073-0e8ac72e0001'
export const OTA_NOTIFY = '00002760-08c2-11e1-9073-0e8ac72e0002'
export class StockTimeout extends Error {}
type Waiter = { role: string; characteristic: string; match: (message: p.ProtocolMessage) => boolean;
  resolve: (message: p.ProtocolMessage) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> | null }

/** Exclusive, short-lived stock-protocol connection for onboarding/OTA. No display pump. */
export class StockConnection {
  ids: Record<string, string> = {}
  private limits: Record<string, number> = {}
  private receiver = new p.MessageReceiver()
  private waiters = new Set<Waiter>()
  private listeners = new Set<(role: string, message: p.ProtocolMessage) => void>()
  private lost = new Set<string>()
  private writes = new Map<string, Promise<void>>()
  private closed = false
  private magic = 0x60
  private sequence = 0
  private off: () => void
  constructor(private transport: SessionTransport, private log: (line: string) => void = () => {}) {
    this.off = transport.onEvent(event => this.receive(event))
  }
  check(): void { if (this.closed) throw new Error('Cancelled.') }
  isConnected(role: string): boolean { return !this.closed && !!this.limits[role] && !this.lost.has(role) }
  async resolve(addresses: SessionAddresses): Promise<void> {
    this.ids = await this.transport.resolveDevices(addresses); this.check()
  }
  async connect(role: string, ota = false): Promise<void> {
    this.check(); this.lost.delete(role)
    const id = this.ids[role]
    if (!id) throw new Error(`No ${role} lens configured.`)
    const details = await this.transport.connect(id)
    if (this.closed) { this.transport.disconnect(id); this.check() }
    this.limits[role] = details.maxWrite
    for (const characteristic of [p.G2_WRITE, p.G2_NOTIFY, ...(ota ? [OTA_WRITE, OTA_NOTIFY] : [])])
      if (!details.characteristics.includes(characteristic)) throw new Error(`${role} lens is missing ${ota ? 'firmware update' : 'G2'} characteristics.`)
    await this.transport.subscribe(id, p.G2_NOTIFY); this.check()
    if (ota) { await this.transport.subscribe(id, OTA_NOTIFY); this.check() }
  }
  nextMagic(): number { this.magic = this.magic >= 0x7f ? 0x60 : this.magic + 1; return this.magic }
  async authenticate(role: string): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const magic = this.nextMagic()
      try {
        await this.exchange(role, p.SID.auth, p.authentication(magic),
          message => p.authenticationSucceeded(message, magic), 30_000, p.G2_WRITE, p.G2_NOTIFY, 0)
        this.log(`Security authentication complete: ${role} lens`); return
      } catch (error) { this.check(); if (!(error instanceof StockTimeout) || attempt === 1) throw error }
    }
  }
  request(role: string, sid: number, build: (magic: number) => Uint8Array, timeout = 3500, fixedMagic?: number): Promise<p.ProtocolMessage> {
    const magic = fixedMagic ?? this.nextMagic()
    return this.exchange(role, sid, build(magic), message => message.sid === sid && message.magic === magic && ![1, 6].includes(message.flag), timeout)
  }
  write(role: string, sid: number, payload: Uint8Array, characteristic = p.G2_WRITE, flag = 0x20, sequence = ++this.sequence): Promise<void> {
    // Keep a fragmented control message together when the prompt heartbeat
    // overlaps a settings request or shutdown.
    const pending = (this.writes.get(role) ?? Promise.resolve()).catch(() => {}).then(async () => {
      this.check()
      for (const frame of p.frameMessage(payload, sid, flag, sequence, this.limits[role])) {
        this.check()
        if (this.lost.has(role)) throw new Error(`Lost connection to the ${role} lens.`)
        await this.transport.write(this.ids[role], characteristic, frame)
      }
      this.check()
      if (this.lost.has(role)) throw new Error(`Lost connection to the ${role} lens.`)
    })
    this.writes.set(role, pending)
    return pending
  }
  exchange(role: string, sid: number, payload: Uint8Array, match: Waiter['match'], timeout: number,
    write = p.G2_WRITE, notify = p.G2_NOTIFY, flag = 0x20, sequence?: number, data?: Uint8Array): Promise<p.ProtocolMessage> {
    this.check()
    return new Promise((resolve, reject) => {
      let written = false, reply: p.ProtocolMessage | null = null
      const waiter: Waiter = { role, characteristic: notify, match,
        resolve: message => { reply = message; if (written) resolve(message) }, reject,
        timer: null }
      this.waiters.add(waiter)
      void (async () => {
        await this.write(role, sid, payload, write, flag, sequence)
        if (data) await this.write(role, 0xc1, data, write, flag, sequence)
        this.check()
        if (!reply && !this.waiters.has(waiter)) return
        written = true
        if (reply) resolve(reply)
        else waiter.timer = setTimeout(() => {
          this.waiters.delete(waiter)
          reject(new StockTimeout(`No response from the ${role} lens (0x${sid.toString(16)}).`))
        }, timeout)
      })().catch(error => { this.waiters.delete(waiter); if (waiter.timer !== null) clearTimeout(waiter.timer); reject(error) })
    })
  }

  onMessage(listener: (role: string, message: p.ProtocolMessage) => void): () => void {
    this.listeners.add(listener); return () => this.listeners.delete(listener)
  }
  private receive(event: TransportEvent): void {
    if (this.closed) return
    const role = Object.keys(this.ids).find(role => this.ids[role] === event.identifier)
    if (!role) return
    if (event.kind === 'disconnected') {
      this.lost.add(role)
      for (const waiter of [...this.waiters]) if (waiter.role === role) {
        this.waiters.delete(waiter); if (waiter.timer !== null) clearTimeout(waiter.timer); waiter.reject(new Error(`Lost connection to the ${role} lens.`))
      }
      return
    }
    if (event.kind !== 'notification' || !event.data || ![p.G2_NOTIFY, OTA_NOTIFY].includes(event.characteristic!)) return
    try {
      const data = hexToBytes(event.data)
      const messages = event.characteristic === OTA_NOTIFY ? decodeOtaAcks(data) : this.receiver.receive(event.identifier!, data)
      for (const message of messages) {
        for (const waiter of [...this.waiters]) if (waiter.role === role && waiter.characteristic === event.characteristic && waiter.match(message)) {
          this.waiters.delete(waiter); if (waiter.timer !== null) clearTimeout(waiter.timer); waiter.resolve(message)
        }
        if (event.characteristic === p.G2_NOTIFY) for (const listener of this.listeners) listener(role, message)
      }
    } catch (error) { this.log(`Ignored malformed onboarding notification: ${error}`) }
  }
  disconnect(role: string): void { this.lost.add(role); if (this.ids[role]) this.transport.disconnect(this.ids[role]); this.receiver.clear() }
  close(): void {
    if (this.closed) return
    this.closed = true; this.off(); this.transport.stopScan()
    for (const waiter of this.waiters) { if (waiter.timer !== null) clearTimeout(waiter.timer); waiter.reject(new Error('Cancelled.')) }
    this.waiters.clear(); this.listeners.clear()
    for (const role of Object.keys(this.ids)) this.disconnect(role)
  }
}

/** OTA ACKs are raw opcode/status bytes, not protobuf; validate the aa21 CRC envelope. */
export function decodeOtaAcks(data: Uint8Array): p.ProtocolMessage[] {
  const messages: p.ProtocolMessage[] = []
  for (let offset = 0; offset + 8 <= data.length;) {
    const n = data[offset + 3], end = offset + 8 + n
    if (end > data.length) break
    if (data[offset] === 0xaa && [0x12, 0x21].includes(data[offset + 1]) && data[offset + 4] === 1 && data[offset + 5] === 1 && n >= 4) {
      const payload = data.slice(offset + 8, end - 2)
      if (p.crc16(payload) === (data[end - 2] | data[end - 1] << 8))
        messages.push({ sid: data[offset + 6], flag: data[offset + 7], payload, command: payload[0], magic: -1 })
    }
    offset = end
  }
  return messages
}
