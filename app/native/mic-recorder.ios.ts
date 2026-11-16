import { knownFolders, path as paths } from '@nativescript/core'

// Kotlin/Native facade exported by FaceclawKit (native/kotlin/shared/src/iosMain/.../IosMicRecorder.kt).
declare const FaceclawKitIosMicRecordings: any

/**
 * Records 16 kHz mono PCM16 to a Matroska audio file (.mka) in
 * Documents/Downloads while it is captured, through the shared Kotlin writer
 * that Android's captures are recorded with. The file is written about a
 * second at a time, so a crash leaves everything up to the last second.
 */
export class MicRecorder {
  private constructor(private recorder: any, readonly path: string) {}

  /**
   * A recorder for Downloads/<name>.mka (a -2, -3... suffix if taken), or null.
   * `info` describes the capture and is stored in the file.
   */
  static open(name: string, info: Record<string, unknown> = {}): MicRecorder | null {
    const fm = NSFileManager.defaultManager
    const dir = paths.join(knownFolders.documents().path, 'Downloads')
    try {
      fm.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(dir, true, null)
      let path = paths.join(dir, `${name}.mka`)
      for (let n = 2; fm.fileExistsAtPath(path); n++) path = paths.join(dir, `${name}-${n}.mka`)
      const recorder = FaceclawKitIosMicRecordings.shared.openPathConfigJson(path, JSON.stringify(info))
      return recorder ? new MicRecorder(recorder, path) : null
    } catch {
      return null
    }
  }

  append(pcm: Uint8Array): void {
    if (!this.recorder || !pcm.length) return
    // The handle is the buffer's start: a view into a larger buffer is copied out first.
    const bytes = pcm.byteOffset === 0 && pcm.byteLength === pcm.buffer.byteLength ? pcm : pcm.slice()
    try {
      // Copied by the recorder before this returns.
      this.recorder.appendPcm16le(NSData.dataWithBytesLength(interop.handleof(bytes.buffer), bytes.byteLength))
    } catch {
      // Stop recording rather than retry.
      this.close()
    }
  }

  close(): void {
    try { this.recorder?.finish() } catch { /* already closed */ }
    this.recorder = null
  }
}
