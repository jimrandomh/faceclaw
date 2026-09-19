import { StockConnection, StockTimeout } from '../g2/stock-connection'
import * as p from '../g2/ble-protocol'
import { iosBluetooth } from './ios-bluetooth'
import type { DeviceInfo, DeviceInfoState } from './device-info-probe'
export type { DeviceInfo, DeviceInfoState } from './device-info-probe'

export class DeviceInfoProbe {
  private logs = new Set<(line: string) => void>()
  private states = new Set<(state: DeviceInfoState, detail: string) => void>()
  private link = new StockConnection(iosBluetooth(), line => { for (const fn of this.logs) fn(line) })
  constructor(private right: string, private left = '') {}
  onLog(fn: (line: string) => void): () => void { this.logs.add(fn); return () => this.logs.delete(fn) }
  onStateChange(fn: (state: DeviceInfoState, detail: string) => void): () => void { this.states.add(fn); return () => this.states.delete(fn) }
  async run(): Promise<DeviceInfo> {
    const snapshots = new Map<string, DeviceInfo>()
    const parse = (message: p.ProtocolMessage): DeviceInfo => {
      const values = p.readBytes(message.payload, 4)
      return { leftVersion: values ? p.readString(values, 5) : '', rightVersion: values ? p.readString(values, 6) : '', extension: p.readString(message.payload, 100) }
    }
    const hasVersion = (info: DeviceInfo) => !!(info.leftVersion || info.rightVersion || info.extension)
    // Some stock builds push settings using their own magic instead of the
    // query's magic. Keep a valid snapshot as the Android probe does.
    this.link.onMessage((role, message) => {
      if (message.sid === p.SID.settings) { const info = parse(message); if (hasVersion(info)) snapshots.set(role, info) }
    })
    try {
      await this.link.resolve({ right: this.right, left: this.left, ring: '' })
      for (const role of ['right', ...(this.left ? ['left'] : [])]) {
        await this.bringUp(role)
      }
      let lastError: unknown
      for (const role of ['right', ...(this.left ? ['left'] : [])]) {
        for (const fn of this.states) fn('querying', role)
        try {
          if (!this.link.isConnected(role)) await this.bringUp(role)
          await this.link.request(role, p.SID.launch, p.prelude, 3500, 156)
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              const message = await this.link.request(role, p.SID.settings, p.settingsQuery)
              const info = parse(message)
              if (hasVersion(info)) return info
            } catch (error) { this.link.check(); lastError = error }
            if (snapshots.has(role)) return snapshots.get(role)!
          }
        } catch (error) { this.link.check(); lastError = error }
      }
      throw lastError ?? new Error("Connected, but couldn't read a firmware version.")
    } finally { this.close() }
  }
  private async bringUp(role: string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        for (const fn of this.states) fn('connecting', role)
        await this.link.connect(role)
        for (const fn of this.states) fn('authenticating', role)
        // Version reads remain available on older stock builds without an auth ACK.
        try { await this.link.authenticate(role) } catch (error) { if (!(error instanceof StockTimeout)) throw error }
        return
      } catch (error) {
        this.link.check(); this.link.disconnect(role)
        if (attempt === 2) throw error
        await new Promise(resolve => setTimeout(resolve, 1500)); this.link.check()
      }
    }
  }
  cancel(): void { this.link.close() }
  close(): void { this.link.close() }
}
