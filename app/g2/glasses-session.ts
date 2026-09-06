import * as protocol from './ble-protocol'
import { hexToBytes } from '../util/hex-util'
import { deviceAddressError } from './ios-peripheral-identity'

declare function setTimeout(callback: () => void, ms: number): number
declare function clearTimeout(id: number): void
export type SessionAddresses = { left: string; right: string; ring: string }
export type TransportEvent = { kind: string; identifier?: string; characteristic?: string; data?: string; message?: string; state?: number }
export interface SessionTransport {
  onEvent(listener: (event: TransportEvent) => void): () => void
  resolveDevices(addresses: SessionAddresses): Promise<Record<string, string>>
  connect(identifier: string): Promise<{ characteristics: string[]; maxWrite: number }>
  subscribe(identifier: string, characteristic: string): Promise<void>
  write(identifier: string, characteristic: string, bytes: Uint8Array): Promise<void>
  disconnect(identifier: string): void
  stopScan(): void
}
export type SessionState = { phase: 'disconnected' | 'connecting' | 'connected' | 'retrying' | 'disconnecting' | 'error';
  status: string; battery: number | null; ring: boolean; frames: number; capabilities: string; leftVersion: string; rightVersion: string }
type PendingAck = { resolve: (message: protocol.ProtocolMessage) => void; reject: (error: Error) => void;
  timer: number | null; command: number; label: string }
class AckTimeout extends Error {}

/** G2 session independent of the phone OS. Images go to L, control to R, as on Android. */
export class GlassesSession {
  state: SessionState = { phase: 'disconnected', status: 'Preview only', battery: null, ring: false,
    frames: 0, capabilities: '', leftVersion: '', rightVersion: '' }
  private generation = 0
  private ids: Record<string, string> = {}
  private limits: Record<string, number> = {}
  private pending = new Map<string, PendingAck>()
  private receiver = new protocol.MessageReceiver()
  private writes = new Map<string, Promise<void>>()
  private magic = 100
  private sequence = 0x40
  private timer: number | null = null
  private retryTimer: number | null = null
  private retryCount = 0
  private wanted = false
  private addresses: SessionAddresses | null = null
  private latest: Uint8Array | null = null
  private displayed: Uint8Array | null = null
  private pumping = false
  private lastHeartbeat = 0
  private lastLease = 0
  private lastSettings = 0
  private charging = false
  private layoutCreated = false
  private off: () => void
  constructor(private readonly transport: SessionTransport,
    private readonly deflate: (data: Uint8Array) => Uint8Array,
    private readonly onState: (state: SessionState) => void,
    private readonly onInput: (input: protocol.GlassesInput) => void,
    private readonly log: (message: string) => void = () => {}) {
    this.off = transport.onEvent(event => this.receive(event))
  }
  private update(phase: SessionState['phase'], status: string): void {
    this.state = { ...this.state, phase, status }; this.log(status); this.onState({ ...this.state })
  }
  async start(addresses: SessionAddresses, retry = false): Promise<void> {
    if (['connecting', 'connected', 'disconnecting'].includes(this.state.phase)) return
    const invalid = deviceAddressError(addresses)
    if (invalid) { this.update('error', invalid); return }
    this.addresses = { ...addresses }; this.wanted = true
    if (!retry) this.retryCount = 0
    const generation = ++this.generation
    this.state = { ...this.state, capabilities: '', leftVersion: '', rightVersion: '', battery: null, ring: false }
    this.charging = false
    this.update('connecting', 'Finding configured devices…')
    try {
      const ids = await this.transport.resolveDevices(addresses); this.check(generation)
      this.ids = ids
      for (const role of ['right', 'left']) {
        this.update('connecting', `Connecting ${role} arm…`)
        const details = await this.transport.connect(ids[role]); this.check(generation)
        this.limits[role] = details.maxWrite
        if (!details.characteristics.includes(protocol.G2_WRITE) || !details.characteristics.includes(protocol.G2_NOTIFY)) throw new Error(`${role} arm is missing G2 communication characteristics.`)
        await this.transport.subscribe(ids[role], protocol.G2_NOTIFY); this.check(generation)
      }
      this.update('connecting', 'Authenticating… Accept pairing if iOS asks.')
      await Promise.all(['right', 'left'].map(async role => {
        try {
          const answer = await this.request(role, protocol.SID.auth, protocol.authentication, 'Security authentication', 30_000, 0)
          if (!protocol.authenticationSucceeded(answer, answer.magic)) throw new Error(`${role} arm rejected authentication.`)
        } catch (error) {
          if (!(error instanceof AckTimeout)) throw error
          // Older CFW may not implement the reply. A settings response below
          // still has to prove we have a working, compatible session.
          this.log(`${role} authentication unconfirmed; checking firmware response`)
        }
      }))
      this.check(generation)
      this.update('connecting', 'Checking glasses firmware…')
      const settings = await this.request('right', protocol.SID.settings, protocol.settingsQuery, 'Settings query')
      this.applySettings(settings)
      const caps = this.state.capabilities.split(/\s+/)
      if (!['img640', 'fbguard', 'wearnotify'].every(cap => caps.includes(cap)))
        throw new Error('The glasses do not report compatible Faceclaw firmware (img640, fbguard, wearnotify). Bluetooth is working, but this display requires the modified firmware. Flashing remains available on Android.')
      this.update('connecting', 'Starting glasses display…')
      await this.request('right', protocol.SID.launch, () => protocol.prelude(), 'App launch', 3500, 0x20, 156)
      await this.lease(true)
      await this.request('right', protocol.SID.hub, protocol.createLayout, 'Create display layout')
      this.check(generation); this.layoutCreated = true
      this.lastHeartbeat = this.lastLease = this.lastSettings = Date.now()
      this.displayed = null; this.retryCount = 0
      this.update('connected', 'Glasses connected')
      this.schedule()
      if (addresses.ring && ids.ring) {
        try {
          const ring = await this.transport.connect(ids.ring); this.check(generation)
          const notifications = protocol.RING_NOTIFY.filter(uuid => ring.characteristics.includes(uuid))
          if (!notifications.length) throw new Error('No R1 gesture notifications found')
          for (const uuid of notifications) await this.transport.subscribe(ids.ring, uuid)
          this.check(generation); this.state.ring = true; this.update('connected', 'Glasses and ring connected')
        } catch (error) {
          if (generation !== this.generation) return
          this.transport.disconnect(ids.ring)
          this.update('connected', `Glasses connected; ring unavailable: ${this.message(error)}`)
        }
      } else if (addresses.ring) this.update('connected', 'Glasses connected; configured ring was not found')
    } catch (error) {
      if (generation !== this.generation) return
      this.fail(error, retry)
    }
  }
  private check(generation: number): void { if (generation !== this.generation) throw new Error('Connection cancelled') }
  private nextMagic(): number {
    for (let i = 0; i < 156; i++) {
      const magic = this.magic; this.magic = this.magic === 255 ? 100 : this.magic + 1
      if (magic !== 156 && ![...this.pending.keys()].some(key => key.endsWith(`:${magic}`))) return magic
    }
    throw new Error('All message identifiers are in use')
  }
  private request(role: string, sid: number, build: (magic: number) => Uint8Array, label: string,
    timeout = 3500, flag = 0x20, fixedMagic?: number): Promise<protocol.ProtocolMessage> {
    const magic = fixedMagic ?? this.nextMagic(), payload = build(magic), key = `${sid}:${magic}`
    const generation = this.generation
    return new Promise((resolve, reject) => {
      const pending: PendingAck = { resolve, reject, timer: null, command: protocol.readInteger(payload, 1, -1), label }
      this.pending.set(key, pending)
      this.send(role, sid, flag, payload).then(() => {
        if (this.pending.get(key) !== pending || generation !== this.generation) return
        pending.timer = setTimeout(() => {
          this.pending.delete(key); reject(new AckTimeout(`${label} was not acknowledged by the glasses.`))
        }, timeout)
      }).catch(error => {
        if (this.pending.get(key) !== pending) return
        this.pending.delete(key); if (pending.timer) clearTimeout(pending.timer); reject(error)
      })
    })
  }
  private send(role: string, sid: number, flag: number, payload: Uint8Array): Promise<void> {
    const identifier = this.ids[role], generation = this.generation
    if (!identifier) return Promise.reject(new Error(`No ${role} device connected`))
    const frames = protocol.frameMessage(payload, sid, flag, this.sequence++, this.limits[role])
    const previous = this.writes.get(identifier) ?? Promise.resolve()
    const work = previous.catch(() => {}).then(async () => {
      for (const frame of frames) { this.check(generation); await this.transport.write(identifier, protocol.G2_WRITE, frame) }
    })
    // A whole message owns the write queue; heartbeat packets cannot split an image message.
    this.writes.set(identifier, work)
    return work
  }
  private lease(acquire: boolean): Promise<void[]> {
    return Promise.all(['right', 'left'].map(role => this.send(role, protocol.SID.settings, 0x20, protocol.framebufferLease(acquire))))
  }
  private receive(event: TransportEvent): void {
    if (!Object.values(this.ids).includes(event.identifier ?? '')) return
    if (event.kind === 'disconnected') {
      if (event.identifier === this.ids.ring) {
        this.state.ring = false
        if (this.state.phase === 'connected') this.update('connected', 'Glasses connected; ring disconnected')
      } else if (['connected', 'connecting'].includes(this.state.phase)) this.fail(new Error(event.message || 'Glasses disconnected'), true)
      return
    }
    if (event.kind !== 'notification' || !event.data) return
    try {
      const data = hexToBytes(event.data)
      if (event.identifier === this.ids.ring) {
        if (!protocol.RING_NOTIFY.includes(event.characteristic ?? '')) return
        const input = protocol.decodeRingInput(data); if (input) this.onInput(input); return
      }
      if (event.characteristic !== protocol.G2_NOTIFY) return
      for (const message of this.receiver.receive(event.identifier!, data)) {
        if (![1, 6].includes(message.flag)) {
          // A master arm can relay the other arm's ACK; magic is allocated
          // across BOTH links, matching Android's communicator.
          const key = `${message.sid}:${message.magic}`, pending = this.pending.get(key)
          if (pending) {
            this.pending.delete(key); if (pending.timer) clearTimeout(pending.timer)
            pending.resolve(message)
          }
        }
        if (message.sid === protocol.SID.settings) this.applySettings(message)
        if (event.identifier === this.ids.right) {
          const input = protocol.decodeGlassesInput(message)
          if (input) {
            if (input.kind === 'sys-event' && [5, 6, 7].includes(input.eventType) && this.state.phase === 'connected') {
              // Respect an explicit glasses-side exit; the user can reconnect.
              void this.stop(); continue
            }
            this.onInput(input)
          }
        }
      }
    } catch (error) { this.log(`Ignored malformed BLE notification: ${this.message(error)}`) }
  }
  private applySettings(message: protocol.ProtocolMessage): void {
    const values = protocol.readBytes(message.payload, 4)
    const capabilities = protocol.readString(message.payload, 100)
    if (capabilities) this.state.capabilities = capabilities
    if (values) {
      const left = protocol.readString(values, 5), right = protocol.readString(values, 6)
      if (left) this.state.leftVersion = left
      if (right) this.state.rightVersion = right
      const battery = protocol.readInteger(values, 12, -1), charging = protocol.readInteger(values, 13, -1)
      if (battery >= 0 && battery <= 100) this.state.battery = battery
      if (charging >= 0) this.charging = charging > 0
    }
    this.onState({ ...this.state })
  }
  setFrame(gray: Uint8Array): void {
    if (this.state.phase !== 'connected') return
    this.latest = protocol.packGray4(gray, 640, 480); this.schedule(0)
  }
  private schedule(delay = 1000): void {
    if (delay === 0 && this.timer !== null) { clearTimeout(this.timer); this.timer = null }
    if (this.timer !== null || this.pumping || this.state.phase !== 'connected') return
    this.timer = setTimeout(() => { this.timer = null; void this.pump() }, delay)
  }
  private async pump(): Promise<void> {
    if (this.pumping || this.state.phase !== 'connected') return
    this.pumping = true; const generation = this.generation
    try {
      const now = Date.now()
      if (now - this.lastHeartbeat >= 4000) {
        await this.request('right', protocol.SID.hub, protocol.heartbeat, 'Heartbeat', 1500); this.lastHeartbeat = Date.now()
      }
      if (now - this.lastLease >= 45_000) { await this.lease(true); this.lastLease = Date.now() }
      if (now - this.lastSettings >= (this.charging ? 30_000 : 300_000)) {
        const settings = await this.request('right', protocol.SID.settings, protocol.settingsQuery, 'Battery query')
        this.applySettings(settings); this.lastSettings = Date.now()
      }
      const frame = this.latest; this.latest = null
      if (frame && !this.charging && (!this.displayed || !frame.every((value, i) => value === this.displayed![i]))) {
        const payload = protocol.concat(new Uint8Array([6]), this.deflate(protocol.rle4(frame)))
        if (payload.length > 165888) throw new Error('Compressed frame exceeds the glasses image buffer')
        for (let offset = 0; offset < payload.length; offset += 3800) {
          await this.request('left', protocol.SID.hub, magic => protocol.imageFragment(magic, payload, offset), 'Display frame')
          this.check(generation); this.lastHeartbeat = Date.now()
        }
        this.displayed = frame; this.state.frames++; this.onState({ ...this.state })
        this.log(`Display frame ${this.state.frames} acknowledged (${payload.length} bytes)`)
      } else if (frame && this.charging) this.latest = frame
    } catch (error) { if (generation === this.generation) this.fail(error, true) }
    finally { if (generation === this.generation) { this.pumping = false; this.schedule(this.latest && !this.charging ? 0 : 1000) } }
  }
  private reset(): void {
    ++this.generation
    if (this.timer !== null) clearTimeout(this.timer)
    if (this.retryTimer !== null) clearTimeout(this.retryTimer)
    this.timer = this.retryTimer = null; this.pumping = false
    const pending = [...this.pending.values()]; this.pending.clear()
    for (const request of pending) { if (request.timer) clearTimeout(request.timer); request.reject(new Error('Connection ended')) }
    this.receiver.clear(); this.writes.clear(); this.latest = this.displayed = null
  }
  private closeLinks(): void {
    const ids = this.ids; this.ids = {}; this.limits = {}
    for (const identifier of Object.values(ids)) this.transport.disconnect(identifier)
    this.transport.stopScan(); this.layoutCreated = false; this.state.ring = false
  }
  private fail(error: unknown, retry: boolean): void {
    const message = this.message(error); this.reset(); this.closeLinks()
    if (retry && this.wanted && this.addresses && this.retryCount < 5) {
      const delay = Math.min(30_000, 2000 * 2 ** this.retryCount++)
      this.update('retrying', `${message} Retrying in ${delay / 1000}s…`)
      this.retryTimer = setTimeout(() => { this.retryTimer = null; if (this.wanted && this.addresses) void this.start(this.addresses, true) }, delay)
    } else { this.wanted = false; this.update('error', message) }
  }
  async stop(): Promise<void> {
    this.wanted = false
    const cleanup = this.layoutCreated && this.state.phase === 'connected'
    this.update('disconnecting', 'Disconnecting…'); this.reset()
    try {
      if (cleanup) {
        if (this.state.capabilities.split(/\s+/).includes('cleanup11'))
          await this.request('left', protocol.SID.hub, magic => protocol.imageFragment(magic, new Uint8Array([11]), 0), 'Display cleanup', 1200)
        else {
          await this.request('right', protocol.SID.hub, protocol.shutdown, 'Close display', 1200)
          await this.lease(false)
        }
      }
    } catch (error) { this.log(`Disconnect cleanup: ${this.message(error)}`) }
    finally { this.reset(); this.closeLinks(); this.update('disconnected', 'Preview only') }
  }
  dispose(): void { void this.stop().finally(() => this.off()) }
  private message(error: unknown): string { return error instanceof Error ? error.message : String(error) }
}
