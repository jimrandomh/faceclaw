/** Same units as Android FaceclawBleManager: protocol messages, framed write
 * bytes accepted by the transport, and fully acknowledged display updates.
 * Totals survive reconnects and the setting being switched off.
 */
export class BleTrafficCounters {
  private messages = 0
  private bytes = 0
  private frames = 0
  recordWrite(bytes: number): void { this.bytes += bytes }
  recordMessage(): void { this.messages++ }
  recordDisplayFrame(): void { this.frames++ }
  sample(): { messages: number; bytes: number; frames: number } {
    return { messages: this.messages, bytes: this.bytes, frames: this.frames }
  }
}
// The iOS BLE session and phone UI both run in the main isolate.
export const iosBleTraffic = new BleTrafficCounters()
