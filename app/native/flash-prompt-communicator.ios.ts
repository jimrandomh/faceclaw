import { StockConnection } from '../g2/stock-connection'
import { createFlashPrompt, flashPromptSelection } from '../g2/flash-prompt-protocol'
import * as p from '../g2/ble-protocol'
import { iosBluetooth } from './ios-bluetooth'
import type { FlashPromptBattery, FlashPromptState } from './flash-prompt-communicator'
export type { FlashPromptBattery, FlashPromptState } from './flash-prompt-communicator'

export class FlashPromptCommunicator {
  private logs = new Set<(line: string) => void>()
  private states = new Set<(state: FlashPromptState, detail: string) => void>()
  private results = new Set<(approved: boolean) => void>()
  private batteries = new Set<(battery: FlashPromptBattery) => void>()
  private link = new StockConnection(iosBluetooth(), line => { for (const fn of this.logs) fn(line) })
  private closed = false
  private started = false
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private stopSelection: (() => void) | null = null
  constructor(private addresses: { right: string; left: string }, private warning: string, private options?: { skipPrompt?: boolean }) {}
  onLog(fn: (line: string) => void): () => void { this.logs.add(fn); return () => this.logs.delete(fn) }
  onStateChange(fn: (state: FlashPromptState, detail: string) => void): () => void { this.states.add(fn); return () => this.states.delete(fn) }
  onResult(fn: (approved: boolean) => void): () => void { this.results.add(fn); return () => this.results.delete(fn) }
  onBattery(fn: (battery: FlashPromptBattery) => void): () => void { this.batteries.add(fn); return () => this.batteries.delete(fn) }
  private state(state: FlashPromptState, detail = ''): void { for (const fn of this.states) fn(state, detail) }
  start(): void { if (!this.started) { this.started = true; void this.run() } }
  private async run(): Promise<void> {
    try {
      this.state('connecting')
      await this.link.resolve({ ...this.addresses, ring: '' })
      // Complete pairing for one peripheral before starting the other.
      for (const role of ['right', 'left']) {
        await this.link.connect(role)
        if (role === 'right') this.state('connected')
        await this.link.authenticate(role)
      }
      await this.link.request('right', p.SID.launch, p.prelude, 3500, 156)
      if (!this.options?.skipPrompt) {
        // Listen before creating the page: an immediate tap may precede its ACK.
        const selection = this.selection()
        // Attach a rejection handler immediately, even while create-page is pending.
        void selection.catch(() => {})
        for (let attempt = 0; ; attempt++) {
          try { await this.link.request('right', p.SID.hub, magic => createFlashPrompt(magic, this.warning)); break }
          catch (error) { this.link.check(); if (attempt) throw error }
        }
        this.state('prompting')
        this.heartbeat = setInterval(() => {
          void this.link.write('right', p.SID.hub, p.heartbeat(this.link.nextMagic())).catch(error => {
            if (!this.closed) this.state('error', String(error.message ?? error))
            this.close()
          })
        }, 4000)
        const approved = await selection
        this.stopHeartbeat()
        // Stock shutdown returns the glasses to their normal UI before OTA.
        await this.link.write('right', p.SID.hub, p.concat(p.integer(1, 9), p.integer(2, this.link.nextMagic()), p.bytes(11, p.integer(1, 0))))
        if (!approved) { for (const fn of this.results) fn(false); return }
      }
      this.state('battery')
      const battery: FlashPromptBattery = { right: null, left: null }
      for (const role of ['right', 'left'] as const) {
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const message = await this.link.request(role, p.SID.settings, p.settingsQuery)
            const values = p.readBytes(message.payload, 4), value = values ? p.readInteger(values, 12, -1) : -1
            if (value >= 0 && value <= 100) { battery[role] = value; break }
          } catch (error) { this.link.check() }
        }
      }
      for (const fn of this.batteries) fn(battery)
      for (const fn of this.results) fn(true)
    } catch (error) { if (!this.closed) this.state('error', String((error as Error).message ?? error)) }
    finally { this.close() }
  }
  private selection(): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); off(); this.stopSelection = null }
      const off = this.link.onMessage((role, message) => {
        const result = role === 'right' ? flashPromptSelection(message) : null
        if (result !== null) { cleanup(); resolve(result) }
      })
      const timer = setTimeout(() => { cleanup(); reject(new Error('No response from the glasses.')) }, 120_000)
      this.stopSelection = () => { cleanup(); reject(new Error('Cancelled.')) }
    })
  }
  private stopHeartbeat(): void { if (this.heartbeat) clearInterval(this.heartbeat); this.heartbeat = null }
  cancel(): void { this.close() }
  close(): void { this.closed = true; this.stopHeartbeat(); this.stopSelection?.(); this.link.close() }
}
