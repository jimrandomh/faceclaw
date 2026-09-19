import { AncsClient, ANCS_FIRMWARE_VERSION } from './ancs-client'
import { type CompassEvent } from '../native/compass-types'
import * as protocol from './ble-protocol'
import { iosBleTraffic } from './ble-traffic-counters'
import { buildBoundingBoxPayload, buildFullFrameBands } from './ble-image-optimizer'
import { CfwTransport, CFW_MAX_MESSAGE, parseCfwAcks } from './cfw-transport'
import { hasCompatibleFirmware, firmwareIncompatibilityMessage, REQUIRED_FACECLAW_FIRMWARE_VERSION } from './firmware-compat'
import { hexToBytes } from '../util/hex-util'
import { deviceAddressError } from './ios-peripheral-identity'
import { decodeWearState, enableWearDetection, queryWearState } from './wear-protocol'

declare function setTimeout(callback: () => void, ms: number): number
declare function clearTimeout(id: number): void
export type SessionAddresses = { left: string; right: string; ring: string }
export type TransportEvent = { kind: string; identifier?: string; characteristic?: string; data?: string; message?: string; state?: number; authorized?: boolean }
export interface SessionTransport {
  onEvent(listener: (event: TransportEvent) => void): () => void
  resolveDevices(addresses: SessionAddresses): Promise<Record<string, string>>
  connect(identifier: string, requiresANCS?: boolean): Promise<{ characteristics: string[]; maxWrite: number }>
  subscribe(identifier: string, characteristic: string): Promise<void>
  write(identifier: string, characteristic: string, bytes: Uint8Array): Promise<void>
  disconnect(identifier: string): void
  stopScan(): void
}
export type SessionState = { phase: 'disconnected' | 'connecting' | 'connected' | 'retrying' | 'disconnecting' | 'error';
  status: string; battery: number | null; charging: boolean | null; ring: boolean; frames: number; capabilities: string; leftVersion: string; rightVersion: string }
type PendingAck = { resolve: (message: protocol.ProtocolMessage) => void; reject: (error: Error) => void;
  timer: number | null; command: number; label: string }
class AckTimeout extends Error {}
// Match Android ConnectionOptions.WINDOW_SIZE. This bounds complete image
// messages queued for writing or awaiting ACK, not individual BLE packets.
const DISPLAY_WINDOW_SIZE = 3
type CfwPending = { payload: Uint8Array; checksum: number; role: string; magic: number; ackLenses: number; retries: number;
  retryPending: boolean; deadline: number; resolve: () => void; reject: (error: Error) => void }
type DisplayFrame = { packed: Uint8Array; commands: Uint8Array[]; offset: number; pending: number }

/** G2 session independent of the phone OS. Images go to L, control to R, as on Android. */
export class GlassesSession {
  state: SessionState = { phase: 'disconnected', status: 'Preview only', battery: null, charging: null, ring: false,
    frames: 0, capabilities: '', leftVersion: '', rightVersion: '' }
  readonly notifications: AncsClient
  private generation = 0
  private ids: Record<string, string> = {}
  private limits: Record<string, number> = {}
  private cfwPending: CfwPending[] = []
  private cfwTransports = new Map<string, CfwTransport>()
  private cfwTimer: number | null = null
  private pending = new Map<string, PendingAck>()
  private receiver = new protocol.MessageReceiver()
  private writes = new Map<string, Promise<void>>()
  private magic = 100
  private sequence = 0x40
  private timer: number | null = null
  private retryTimer: number | null = null
  private ringRetryTimer: number | null = null
  private ringRetryCount = 0
  private ringConnecting = false
  private retryCount = 0
  private wanted = false
  private addresses: SessionAddresses | null = null
  private latest: Uint8Array | null = null
  private displayed: Uint8Array | null = null
  private lastEnqueued: Uint8Array | null = null
  // Match Android: advance only for emitted deltas, skipping 0 / 0xffff.
  private nextImageFrameId = 1
  private displayFrames: DisplayFrame[] = []
  private displaySending: DisplayFrame | null = null
  private displayInFlight = 0
  private pumping = false
  private lastHeartbeat = 0
  private lastLease = 0
  private lastSettings = 0
  private charging = false
  private layoutCreated = false
  private off: () => void
  private stopping: Promise<void> | null = null
  private audioListener: ((packet: Uint8Array) => void) | null = null
  private microphoneToken = 0
  private microphoneWork: Promise<void> = Promise.resolve()
  private microphoneEnabled = false
  private compassWanted = false
  private compassSent: boolean | null = null
  private compassStopping = false
  private compassWork: Promise<void> = Promise.resolve()
  constructor(private readonly transport: SessionTransport,
    private readonly onState: (state: SessionState) => void,
    private readonly onInput: (input: protocol.GlassesInput) => void,
    private readonly log: (message: string) => void = () => {},
    private readonly onActivity: () => void = () => {},
    private readonly onCompass: (event: CompassEvent) => void = () => {},
    private readonly onWearState: (wearing: boolean) => void = () => {},
    onNotificationsChanged: (key?: string, popup?: boolean) => void = () => {}) {
    this.notifications = new AncsClient(packet => this.writePackets('right', () => [packet]), onNotificationsChanged, message => this.log('ANCS: ' + message))
    this.off = transport.onEvent(event => this.receive(event))
  }
  private update(phase: SessionState['phase'], status: string): void {
    this.state = { ...this.state, phase, status }; this.log(status); this.onState({ ...this.state })
  }
  async start(addresses: SessionAddresses, retry = false): Promise<void> {
    if (['connecting', 'connected', 'disconnecting'].includes(this.state.phase)) return
    const invalid = deviceAddressError(addresses)
    if (invalid) { this.update('error', invalid); return }
    this.addresses = { ...addresses }; this.wanted = true; this.compassStopping = false
    if (!retry) this.retryCount = 0
    const generation = ++this.generation
    this.state = { ...this.state, capabilities: '', leftVersion: '', rightVersion: '', battery: null, charging: null, ring: false }
    this.charging = false
    this.update('connecting', 'Finding configured devices…')
    try {
      const ids = await this.transport.resolveDevices(addresses); this.check(generation)
      this.ids = ids
      for (const role of ['right', 'left']) {
        this.update('connecting', `Connecting ${role} arm…`)
        const details = await this.transport.connect(ids[role], role === 'right'); this.check(generation)
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
      const firmware = { leftVersion: this.state.leftVersion, rightVersion: this.state.rightVersion, extension: this.state.capabilities }
      if (!hasCompatibleFirmware(firmware))
        throw new Error((firmwareIncompatibilityMessage(firmware) || `The glasses must report Faceclaw firmware revision ${REQUIRED_FACECLAW_FIRMWARE_VERSION} or newer.`) + ' Use Devices → Check firmware to install it.')
      this.update('connecting', 'Starting glasses display…')
      await this.request('right', protocol.SID.launch, () => protocol.prelude(), 'App launch', 3500, 0x20, 156)
      await this.lease(true)
      await this.request('right', protocol.SID.hub, protocol.createLayout, 'Create display layout')
      this.check(generation); this.layoutCreated = true
      await this.enableWearDetectionAndRequestState(); this.check(generation)
      this.lastHeartbeat = this.lastLease = this.lastSettings = Date.now()
      this.displayed = null; this.retryCount = 0
      this.update('connected', 'Glasses connected')
      if (/^Faceclaw\/(\d+)/.test(this.state.capabilities) && Number(this.state.capabilities.split('/')[1]) >= ANCS_FIRMWARE_VERSION)
        this.notifications.start((Date.now() ^ Math.floor(Math.random()*0xffffffff)) >>> 0, this.limits.right)
      else this.notifications.stop(`Update glasses to Faceclaw firmware ${ANCS_FIRMWARE_VERSION} or newer for iPhone notifications.`)
      await this.syncCompass(); this.check(generation)
      this.schedule()
      if (addresses.ring && ids.ring) await this.connectRing(generation)
      else if (addresses.ring) this.update('connected', 'Glasses connected; configured ring was not found')
    } catch (error) {
      if (generation !== this.generation) return
      this.fail(error, retry || error instanceof AckTimeout)
    }
  }
  private async connectRing(generation: number): Promise<void> {
    if (this.ringConnecting || generation !== this.generation || this.state.phase !== 'connected' || !this.ids.ring) return
    this.ringConnecting = true
    const identifier = this.ids.ring
    try {
      const ring = await this.transport.connect(identifier); this.check(generation)
      this.log(`R1 services discovered: ${ring.characteristics.join(', ')}`)
      const notifications = protocol.RING_NOTIFY.filter(uuid => ring.characteristics.includes(uuid))
      if (!notifications.length) throw new Error('No R1 gesture notifications found')
      let subscribed = 0
      for (const uuid of notifications) {
        this.log(`Subscribing R1 ${uuid}`)
        try { await this.transport.subscribe(identifier, uuid); this.check(generation); subscribed++; this.log(`R1 subscribed ${uuid}`) }
        catch (error) { this.check(generation); this.log(`R1 channel unavailable ${uuid}: ${this.message(error)}`) }
      }
      if (!subscribed) throw new Error('Neither R1 notification channel could be subscribed')
      this.check(generation); this.state.ring = true; this.ringRetryCount = 0
      this.update('connected', 'Glasses and ring connected')
    } catch (error) {
      if (generation !== this.generation) return
      this.state.ring = false
      this.transport.disconnect(identifier)
      this.update('connected', `Glasses connected; ring unavailable: ${this.message(error)}`)
    } finally {
      if (generation === this.generation) {
        this.ringConnecting = false
        if (!this.state.ring) this.scheduleRingRetry()
      }
    }
  }
  private scheduleRingRetry(): void {
    if (!this.wanted || this.state.phase !== 'connected' || !this.ids.ring || this.ringConnecting || this.ringRetryTimer !== null || this.ringRetryCount >= 5) return
    const generation = this.generation, delay = Math.min(30_000, 2000 * 2 ** this.ringRetryCount++)
    this.log(`Retrying ring in ${delay / 1000}s`)
    this.ringRetryTimer = setTimeout(() => {
      this.ringRetryTimer = null
      if (generation === this.generation) void this.connectRing(generation)
    }, delay)
  }
  private check(generation: number): void { if (generation !== this.generation) throw new Error('Connection cancelled') }
  private nextMagic(): number {
    for (let i = 0; i < 156; i++) {
      const magic = this.magic; this.magic = this.magic === 255 ? 100 : this.magic + 1
      if (magic !== 156 && !this.cfwPending.some(item => item.magic === magic) && ![...this.pending.keys()].some(key => key.endsWith(`:${magic}`))) return magic
    }
    throw new Error('All message identifiers are in use')
  }
  private request(role: string, sid: number, build: (magic: number) => Uint8Array, label: string,
    timeout = 3500, flag = 0x20, fixedMagic?: number): Promise<protocol.ProtocolMessage> {
    const magic = fixedMagic ?? this.nextMagic(), payload = build(magic), key = `${sid}:${magic}`
    this.log(`TX ${label} ${role} sid=${sid.toString(16)} magic=${magic}`)
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
    return this.writePackets(role, () => protocol.frameMessage(payload, sid, flag, this.sequence++, this.limits[role]))
  }
  private writePackets(role: string, build: () => Uint8Array[], current = () => true): Promise<void> {
    const identifier = this.ids[role], generation = this.generation
    if (!identifier) return Promise.reject(new Error(`No ${role} device connected`))
    const previous = this.writes.get(identifier) ?? Promise.resolve()
    // A failed write poisons this link's queue until reset: do not transmit
    // later fragments after a hole in the image stream.
    const work = previous.then(async () => {
      this.check(generation)
      if (!current()) return
      for (const frame of build()) {
        this.check(generation)
        if (!current()) return
        await this.transport.write(identifier, protocol.G2_WRITE, frame)
        iosBleTraffic.recordWrite(frame.length)
      }
      iosBleTraffic.recordMessage()
    })
    // A whole message owns the write queue; heartbeat packets cannot split an image message.
    this.writes.set(identifier, work)
    return work
  }
  private lease(acquire: boolean): Promise<void[]> {
    return Promise.all(['right', 'left'].map(role => this.send(role, protocol.SID.settings, 0x20, protocol.framebufferLease(acquire))))
  }
  private requestCfw(role: string, payload: Uint8Array): Promise<void> {
    if (payload.length > CFW_MAX_MESSAGE) return Promise.reject(new Error('CFW message too large'))
    return new Promise((resolve, reject) => {
      const item: CfwPending = { role, payload, checksum: protocol.crc16(payload), magic: this.nextMagic(), ackLenses: 0, retries: 0,
        retryPending: false, deadline: 0, resolve, reject }
      this.cfwPending.push(item)
      this.sendCfw(item)
    })
  }
  private sendCfw(item: CfwPending): void {
    const generation = this.generation, magic = item.magic
    const current = () => generation === this.generation && item.magic === magic && this.cfwPending.includes(item)
    void this.writePackets(item.role, () => {
      let transport = this.cfwTransports.get(item.role)
      if (!transport) { transport = new CfwTransport(); this.cfwTransports.set(item.role, transport) }
      if (item.retries) transport.reset()
      return transport.encode(item.payload, magic, 3, this.limits[item.role])
    }, current).then(() => {
      if (!current()) return
      item.deadline = Date.now() + 500
      this.scheduleCfwRecovery()
    }).catch(error => { if (current()) this.fail(error, true) })
  }
  private receiveCfw(identifier: string, packet: Uint8Array): void {
    const acks = parseCfwAcks(packet)
    if (!acks) return
    for (const ack of acks) {
      // The ingress temple relays the other lens's result on the SAME link.
      const item = this.cfwPending.find(p => this.ids[p.role] === identifier && p.magic === ack.streamId)
      if (!item || ack.messageId !== 0) continue
      if (ack.nack) item.retryPending = true
      else if (ack.size === item.payload.length && ack.checksum === item.checksum) item.ackLenses |= ack.lens
      this.log(`CFW ${ack.nack ? 'NACK' : 'ACK'} stream=${ack.streamId} lens=${ack.lens} size=${ack.size} crc=${ack.checksum} confirmed=${item.ackLenses}`)
    }
    while (this.cfwPending.length) {
      const head = this.cfwPending[0]
      if (head.retryPending || head.ackLenses !== 3) break
      this.cfwPending.shift(); head.resolve()
    }
    this.scheduleCfwRecovery()
  }
  private scheduleCfwRecovery(): void {
    if (this.cfwTimer !== null) clearTimeout(this.cfwTimer)
    this.cfwTimer = null
    let deadline = Infinity
    for (const item of this.cfwPending) {
      if (item.retryPending) deadline = 0
      else if (item.ackLenses !== 3 && item.deadline) deadline = Math.min(deadline, item.deadline)
    }
    if (deadline === Infinity) return
    this.cfwTimer = setTimeout(() => {
      this.cfwTimer = null
      this.recoverCfw()
    }, Math.max(0, deadline - Date.now()))
  }
  private recoverCfw(): void {
    if (!this.cfwPending.some(p => p.retryPending || (p.ackLenses !== 3 && p.deadline > 0 && p.deadline <= Date.now()))) {
      this.scheduleCfwRecovery(); return
    }
    if (this.cfwPending.some(p => p.retries >= 3)) { this.fail(new Error('CFW recovery retry limit'), true); return }
    this.log(`CFW recovery: replay ${this.cfwPending.length} unresolved messages`)
    // Go back to the oldest unresolved command, including any ACKed tail.
    // Fresh stream IDs reject stale ACKs; each replay resets compression history.
    for (const item of this.cfwPending) {
      item.magic = this.nextMagic(); item.retries++; item.ackLenses = 0
      item.deadline = 0; item.retryPending = false
    }
    for (const item of this.cfwPending) this.sendCfw(item)
  }
  private receive(event: TransportEvent): void {
    if (!Object.values(this.ids).includes(event.identifier ?? '')) return
    if (event.kind === 'ancs-authorization' && event.identifier === this.ids.right) {
      if (event.authorized === false) {
        const active = this.notifications.state !== 'disconnected'
        const command = this.notifications.stopCommand()
        this.notifications.stop('Enable Share System Notifications in iPhone Settings → Bluetooth → right lens.')
        if (active && this.state.phase === 'connected') void this.writePackets('right', () => [command]).catch(() => {})
      } else if (this.state.phase === 'connected' && /^Faceclaw\/(\d+)/.test(this.state.capabilities) && Number(this.state.capabilities.split('/')[1]) >= ANCS_FIRMWARE_VERSION) {
        this.notifications.start((Date.now() ^ Math.floor(Math.random()*0xffffffff)) >>> 0, this.limits.right)
      }
      return
    }
    if (event.kind === 'disconnected') {
      if (event.identifier === this.ids.ring) {
        this.state.ring = false
        if (this.state.phase === 'connected') {
          this.update('connected', `Glasses connected; ring disconnected${event.message ? ': ' + event.message : ''}`)
          this.scheduleRingRetry()
        }
      } else if (['connected', 'connecting'].includes(this.state.phase)) this.fail(new Error(event.message || 'Glasses disconnected'), true)
      return
    }
    if (event.kind !== 'notification' || !event.data) return
    if (event.characteristic === protocol.G2_RENDER_NOTIFY && event.identifier !== this.ids.ring) {
      if (this.audioListener && this.state.phase === 'connected') {
        this.audioListener(hexToBytes(event.data))
        this.onActivity(); this.wake()
      }
      return
    }
    const ring = event.identifier === this.ids.ring
    if (ring ? !protocol.RING_NOTIFY.includes(event.characteristic ?? '') : event.characteristic !== protocol.G2_NOTIFY) return
    try {
      const data = hexToBytes(event.data)
      if (ring) {
        const input = protocol.decodeRingInput(data)
        if (input) { this.log(`Direct R1 gesture ${input.eventType}`); this.onInput(input) }
        return
      }
      if (event.identifier === this.ids.right && this.notifications.receive(data)) return
      for (const message of this.receiver.receive(event.identifier!, data)) {
        this.log(`RX ${event.identifier === this.ids.left ? 'L' : 'R'} sid=${message.sid.toString(16)} flag=${message.flag.toString(16)} cmd=${message.command} magic=${message.magic}`)
        if (message.sid === protocol.SID.cfw) {
          this.receiveCfw(event.identifier!, message.packet!)
          continue
        }
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
        const wearing = decodeWearState(message)
        if (wearing !== null) this.onWearState(wearing)
        if (event.identifier === this.ids.right) {
          if (this.state.phase === 'connected') {
            const compass = protocol.decodeCompassInput(message)
            if (compass) this.onCompass(compass)
          }
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
    finally {
      // CoreBluetooth can wake a suspended iOS process for a notification.
      // Service wall-clock deadlines now, without waiting for a suspended timer.
      if (this.state.phase === 'connected') { this.onActivity(); this.wake() }
    }
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
      if (charging >= 0) this.state.charging = this.charging = charging > 0
    }
    this.onState({ ...this.state })
  }
  async enableWearDetectionAndRequestState(): Promise<void> {
    const generation = this.generation
    // Like Android, a missing enable ACK must not suppress the current-state query.
    try { await this.request('right', protocol.SID.settings, enableWearDetection, 'Enable wear detection') }
    catch (error) { if (!(error instanceof AckTimeout)) throw error; this.log(this.message(error)) }
    this.check(generation)
    await this.send('right', protocol.SID.settings, 0x20, queryWearState())
    this.check(generation)
    await this.send('left', protocol.SID.settings, 0x20, queryWearState())
  }
  setFrame(gray: Uint8Array): void {
    if (this.state.phase !== 'connected') return
    this.latest = protocol.packGray4(gray, 640, 480); this.schedule(0)
  }
  /** Same mode-5 kind-4 sequencer payload and acknowledged image path as Android. */
  async playBuzzerSequence(payload: Uint8Array): Promise<void> {
    if (this.state.phase !== 'connected' || !this.layoutCreated || payload.length < 3) return
    const generation = this.generation
    try { await this.requestCfw('left', new Uint8Array(payload)) }
    catch (error) { if (generation === this.generation) this.fail(error, true) }
  }
  /** Serialize mic enable/disable, including a release while enable awaits ACK. */
  setMicrophone(enabled: boolean, listener?: (packet: Uint8Array) => void): Promise<void> {
    const token = ++this.microphoneToken, generation = this.generation
    this.audioListener = enabled ? listener ?? null : null
    const current = () => generation === this.generation && token === this.microphoneToken
    const work = this.microphoneWork.catch(() => {}).then(async () => {
      if (!current()) return
      if (this.state.phase !== 'connected') {
        if (enabled) throw new Error('Connect the glasses before starting voice input.')
        return
      }
      if (enabled) {
        await Promise.all(['left', 'right'].map(role => this.transport.subscribe(this.ids[role], protocol.G2_RENDER_NOTIFY)))
        if (!current()) return
      }
      await this.request('right', protocol.SID.hub, magic => protocol.audioControl(magic, enabled), enabled ? 'Microphone enable' : 'Microphone disable')
      if (current()) { this.microphoneEnabled = enabled; this.log(`Glasses microphone ${enabled ? 'enabled' : 'disabled'}`) }
    }).catch(error => {
      if (current()) { this.audioListener = null; this.microphoneEnabled = false }
      throw error
    })
    this.microphoneWork = work
    return work
  }
  setCompassEnabled(enabled: boolean): void {
    this.compassWanted = enabled
    void this.syncCompass()
  }
  /** Serialize changes so a release cannot overtake an unacknowledged enable. */
  private syncCompass(): Promise<void> {
    const generation = this.generation
    const work = this.compassWork.then(async () => {
      if (generation !== this.generation || this.state.phase !== 'connected') return
      const enabled = !this.compassStopping && this.compassWanted
      if (this.compassSent === enabled) return
      // Same CFW mode 10, 100 ms report interval and zero minimum change as Android.
      await this.requestCfw('left', new Uint8Array(enabled ? [10, 2, 100, 0, 0, 0] : [10, 0]))
      if (generation === this.generation) this.compassSent = enabled
    }).catch(error => { if (generation === this.generation) this.fail(error, true) })
    this.compassWork = work
    return work
  }
  wake(): void {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null }
    void this.pump()
  }
  private schedule(delay = 1000): void {
    if (delay === 0 && this.timer !== null) { clearTimeout(this.timer); this.timer = null }
    if (this.timer !== null || this.pumping || this.state.phase !== 'connected') return
    this.timer = setTimeout(() => { this.timer = null; void this.pump() }, delay)
  }
  private canSendDisplay(): boolean {
    // Also bound completed frames retained behind a missing/out-of-order ACK.
    return this.displayInFlight < DISPLAY_WINDOW_SIZE && !!(this.displaySending ||
      (this.latest && !this.charging && this.displayFrames.length < DISPLAY_WINDOW_SIZE))
  }
  private fillDisplayWindow(generation: number): void {
    while (this.canSendDisplay()) {
      if (!this.displaySending) {
        const packed = this.latest!; this.latest = null
        // Compare with the last enqueued image, not the last ACKed one. In an
        // A -> B -> A sequence, B may still be in flight when A is requested.
        if (this.lastEnqueued && packed.every((value, i) => value === this.lastEnqueued![i])) continue
        const delta = buildBoundingBoxPayload(this.lastEnqueued, packed, 640, 480, this.nextImageFrameId)
        const payload = delta ?? protocol.concat(new Uint8Array([6]), protocol.rle4(packed))
        if (delta) this.nextImageFrameId = this.nextImageFrameId >= 0xfffe ? 1 : this.nextImageFrameId + 1
        const commands = payload.length <= CFW_MAX_MESSAGE ? [payload] : buildFullFrameBands(packed, 640, 480, this.nextImageFrameId)
        if (payload.length > CFW_MAX_MESSAGE) for (const _ of commands)
          this.nextImageFrameId = this.nextImageFrameId >= 0xfffe ? 1 : this.nextImageFrameId + 1
        this.log(`Display ${delta ? 'bbox' : 'full'} (${commands.length} CFW commands)`)
        this.displaySending = { packed, commands, offset: 0, pending: 0 }
        this.displayFrames.push(this.displaySending); this.lastEnqueued = packed
      }
      const frame = this.displaySending, payload = frame.commands[frame.offset++]
      frame.pending++; this.displayInFlight++
      if (frame.offset >= frame.commands.length) this.displaySending = null
      // Writes serialize on L while up to three complete commands await their
      // two-lens ACKs. Retire commands in submission order.
      void this.requestCfw('left', payload).then(() => {
        if (generation !== this.generation) return
        frame.pending--; this.displayInFlight--; this.lastHeartbeat = Date.now()
        // Retire in submission order even if relayed ACKs arrive out of order.
        // A frame counts only after every command has been acknowledged.
        while (this.displayFrames.length) {
          const completed = this.displayFrames[0]
          if (completed.offset < completed.commands.length || completed.pending) break
          this.displayFrames.shift(); this.displayed = completed.packed
          this.state.frames++; iosBleTraffic.recordDisplayFrame(); this.onState({ ...this.state })
          this.log(`Display frame ${this.state.frames} acknowledged (${completed.commands.length} commands)`)
        }
        this.wake()
      }).catch(error => { if (generation === this.generation) this.fail(error, true) })
    }
  }
  private async pump(): Promise<void> {
    if (this.pumping || this.state.phase !== 'connected') return
    this.pumping = true; const generation = this.generation
    try {
      const now = Date.now()
      if (now - this.lastHeartbeat >= 4000) {
        const gap = now - this.lastHeartbeat
        await this.request('right', protocol.SID.hub, protocol.heartbeat, 'Heartbeat', 1500); this.lastHeartbeat = Date.now()
        this.log(`Heartbeat acknowledged (gap ${gap}ms)`)
      }
      if (now - this.lastLease >= 45_000) { await this.lease(true); this.lastLease = Date.now() }
      if (now - this.lastSettings >= (this.charging ? 30_000 : 300_000)) {
        const settings = await this.request('right', protocol.SID.settings, protocol.settingsQuery, 'Battery query')
        this.applySettings(settings); this.lastSettings = Date.now()
      }
      this.check(generation)
      this.fillDisplayWindow(generation)
    } catch (error) { if (generation === this.generation) this.fail(error, true) }
    finally { if (generation === this.generation) { this.pumping = false; this.schedule(this.canSendDisplay() ? 0 : 1000) } }
  }
  private reset(): void {
    this.notifications.stop()
    ++this.generation
    this.compassSent = null; this.compassWork = Promise.resolve()
    ++this.microphoneToken; this.audioListener = null; this.microphoneEnabled = false
    if (this.timer !== null) clearTimeout(this.timer)
    if (this.retryTimer !== null) clearTimeout(this.retryTimer)
    if (this.ringRetryTimer !== null) clearTimeout(this.ringRetryTimer)
    this.ringRetryTimer = null; this.ringConnecting = false; this.ringRetryCount = 0
    this.timer = this.retryTimer = null; this.pumping = false
    const pending = [...this.pending.values()]; this.pending.clear()
    for (const request of pending) { if (request.timer) clearTimeout(request.timer); request.reject(new Error('Connection ended')) }
    if (this.cfwTimer !== null) clearTimeout(this.cfwTimer)
    this.cfwTimer = null
    const custom = this.cfwPending; this.cfwPending = []
    for (const item of custom) item.reject(new Error('Connection ended'))
    this.cfwTransports.clear()
    this.receiver.clear(); this.writes.clear(); this.latest = this.displayed = null
    this.lastEnqueued = null; this.displayFrames = []; this.displaySending = null; this.displayInFlight = 0
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
  stop(): Promise<void> {
    if (this.stopping) return this.stopping
    this.stopping = this.stopInternal().finally(() => { this.stopping = null })
    return this.stopping
  }
  private async stopInternal(): Promise<void> {
    this.wanted = false
    this.compassStopping = true
    await this.syncCompass()
    // Stop mic capture before ending the display session. Late enable ACKs
    // cannot leave a microphone streaming after an explicit Disconnect.
    if (this.audioListener || this.microphoneEnabled) {
      try { await this.setMicrophone(false) } catch (error) { this.log(`Microphone cleanup: ${this.message(error)}`) }
    }
    if (this.notifications.state !== 'disconnected') {
      try { await this.writePackets('right', () => [this.notifications.stopCommand()]) } catch {}
    }
    const cleanup = this.layoutCreated && this.state.phase === 'connected'
    this.update('disconnecting', 'Disconnecting…'); this.reset()
    try {
      if (cleanup) {
        await this.requestCfw('left', new Uint8Array([11]))
      }
    } catch (error) { this.log(`Disconnect cleanup: ${this.message(error)}`) }
    finally { this.reset(); this.closeLinks(); this.update('disconnected', 'Preview only') }
  }
  dispose(): void { void this.stop().finally(() => this.off()) }
  private message(error: unknown): string { return error instanceof Error ? error.message : String(error) }
}
