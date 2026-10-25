import { knownFolders, path as paths } from '@nativescript/core'
import { wavHeader } from './wav-header'

// About a second of 16 kHz mono PCM16: written in batches, not per 50 ms packet.
const FLUSH_BYTES = 32000

/**
 * Appends 16 kHz mono PCM16 to a WAV file in Documents/Downloads while it is
 * captured. The header's sizes are rewritten on every flush, so a crash leaves a
 * playable file of everything up to the last second.
 */
export class WavRecorder {
  private pending: Uint8Array[] = []
  private pendingBytes = 0
  private dataBytes = 0

  private constructor(private handle: NSFileHandle | null, readonly path: string) {}

  /** A recorder for Downloads/<name>.wav (a -2, -3... suffix if taken), or null. */
  static open(name: string): WavRecorder | null {
    const fm = NSFileManager.defaultManager
    const dir = paths.join(knownFolders.documents().path, 'Downloads')
    try {
      fm.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(dir, true, null)
      let path = paths.join(dir, `${name}.wav`)
      for (let n = 2; fm.fileExistsAtPath(path); n++) path = paths.join(dir, `${name}-${n}.wav`)
      if (!fm.createFileAtPathContentsAttributes(path, toData(wavHeader(0)), null)) return null
      const handle = NSFileHandle.fileHandleForWritingAtPath(path)
      if (!handle || !handle.seekToEndReturningOffsetError(null)) return null
      return new WavRecorder(handle, path)
    } catch {
      return null
    }
  }

  append(pcm: Uint8Array): void {
    if (!this.handle || !pcm.length) return
    this.pending.push(pcm.slice())
    this.pendingBytes += pcm.length
    if (this.pendingBytes >= FLUSH_BYTES) this.flush()
  }

  close(): void {
    this.flush()
    try { this.handle?.closeAndReturnError() } catch { /* already closed */ }
    this.handle = null
  }

  private flush(): void {
    const handle = this.handle
    if (!handle || !this.pendingBytes) return
    const chunk = new Uint8Array(this.pendingBytes)
    let offset = 0
    for (const part of this.pending) { chunk.set(part, offset); offset += part.length }
    this.pending = []
    this.pendingBytes = 0
    try {
      // NativeScript throws a failed call's NSError (storage full, file removed).
      handle.writeDataError(toData(chunk))
      handle.seekToOffsetError(0)
      handle.writeDataError(toData(wavHeader(this.dataBytes + chunk.length)))
      handle.seekToEndReturningOffsetError(null)
      this.dataBytes += chunk.length
      return
    } catch {
      // Stop recording rather than retry.
    }
    try { handle.closeAndReturnError() } catch { /* ignore */ }
    this.handle = null
  }
}

function toData(bytes: Uint8Array): NSData {
  return NSData.dataWithBytesLength(interop.handleof(bytes.buffer), bytes.byteLength)
}
