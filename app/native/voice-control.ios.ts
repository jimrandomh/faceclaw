import type { VoiceControlState, VoiceTranscriptEvent } from './voice-control'

declare const FaceclawSpeech: any
export type IosMicrophoneSession = {
  setMicrophone(enabled: boolean, listener?: (packet: Uint8Array) => void): Promise<void>
}

/** iOS implementation of the shared voice dialog's event bridge. Audio comes
 * exclusively from the connected glasses, never from the phone microphone.
 */
export class IosVoiceControlBridge {
  private native: any = null
  private readonly statuses = new Set<(state: VoiceControlState) => void>()
  private readonly transcripts = new Set<(event: VoiceTranscriptEvent) => void>()
  private readonly ends = new Set<() => void>()
  private status = 'Voice input ready.'
  private generation = 0
  private session: IosMicrophoneSession | null = null
  private capturing = false
  private finalizing = false
  private audioTimer: ReturnType<typeof setTimeout> | null = null
  private packets = 0
  private log: (message: string) => void = () => {}

  onStatus(listener: (state: VoiceControlState) => void): () => void {
    this.statuses.add(listener); listener({ status: this.status }); return () => { this.statuses.delete(listener) }
  }
  onTranscript(listener: (event: VoiceTranscriptEvent) => void): () => void {
    this.transcripts.add(listener); return () => { this.transcripts.delete(listener) }
  }
  onSpeechEnd(listener: () => void): () => void { this.ends.add(listener); return () => { this.ends.delete(listener) } }
  onSpeechPause(_listener: () => void): () => void { return () => {} }
  private setStatus(status: string): void { this.status = status; for (const fn of [...this.statuses]) fn({ status }) }
  private ensureNative(): any {
    if (!this.native) {
      this.native = FaceclawSpeech.new()
      this.native.eventHandler = (json: string) => this.receive(JSON.parse(json))
    }
    return this.native
  }
  async prepare(foreground: boolean): Promise<boolean> {
    let status = FaceclawSpeech.authorizationStatus()
    if (status === 0) {
      if (!foreground) { this.setStatus('Open Faceclaw on the phone once to allow Speech Recognition.'); return false }
      status = await new Promise<number>(resolve => FaceclawSpeech.requestAuthorization(resolve))
    }
    if (status !== 3) { this.setStatus('Allow Speech Recognition for Faceclaw in iPhone Settings.'); return false }
    return true
  }
  get statusText(): string { return this.status }
  async startGlassesCapture(session: IosMicrophoneSession, log: (message: string) => void): Promise<void> {
    this.stop()
    const generation = ++this.generation
    this.log = log; this.session = session; this.packets = 0; this.capturing = true
    const error = String(this.ensureNative().start() ?? '')
    if (error) { this.capturing = false; this.session = null; this.setStatus(error); this.emitEnd(); return }
    try {
      await session.setMicrophone(true, packet => {
        if (generation !== this.generation || !this.capturing) return
        this.packets++
        const copy = new Uint8Array(packet)
        this.native.acceptPacket(NSData.dataWithBytesLength(interop.handleof(copy.buffer), copy.byteLength))
      })
      if (generation !== this.generation || !this.capturing) return
      log('Voice: glasses microphone enabled; using on-device recognition')
      this.audioTimer = setTimeout(() => {
        this.audioTimer = null
        if (generation === this.generation && this.capturing && !this.packets) {
          this.stop(); this.setStatus('No microphone audio received. Reconnect the glasses and try again.'); this.emitEnd()
        }
      }, 5000)
    } catch (error) {
      if (generation !== this.generation) return
      this.stop(); this.setStatus(error instanceof Error ? error.message : String(error)); this.emitEnd()
    }
  }
  stopPushToTalk(): void {
    if (!this.capturing) return
    this.capturing = false; this.finalizing = true
    this.clearAudioTimer(); this.releaseMicrophone()
    this.setStatus('Recognizing…'); this.native?.finish()
  }
  stop(): void {
    ++this.generation
    this.capturing = this.finalizing = false
    this.clearAudioTimer(); this.releaseMicrophone(); this.native?.cancel()
  }
  handleSessionEnded(): void {
    if (!this.capturing && !this.finalizing) return
    this.stop(); this.setStatus('Glasses disconnected. Start voice input again after reconnecting.'); this.emitEnd()
  }
  private clearAudioTimer(): void { if (this.audioTimer !== null) clearTimeout(this.audioTimer); this.audioTimer = null }
  private releaseMicrophone(): void {
    const session = this.session; this.session = null
    if (session) void session.setMicrophone(false).catch(error => this.log(`Voice microphone cleanup: ${error}`))
  }
  private emitEnd(): void { for (const fn of [...this.ends]) fn() }
  private receive(event: { kind: string; text?: string; final?: boolean; message?: string; seconds?: number; packets?: number; rms?: number; missing?: number; errors?: number }): void {
    if (!this.capturing && !this.finalizing) return
    if (event.kind === 'transcript') {
      this.log(`Voice: ${event.final ? 'final' : 'partial'} transcript (${event.text?.length ?? 0} characters)`)
      for (const fn of [...this.transcripts]) fn({ text: event.text ?? '', isFinal: !!event.final })
    } else if (event.kind === 'status') this.setStatus(event.message ?? '')
    else if (event.kind === 'audio') {
      this.log(`Voice audio: ${event.seconds?.toFixed(1)}s, packets=${event.packets}, RMS=${event.rms?.toFixed(4)}, missing=${event.missing}, errors=${event.errors}`)
      if (this.capturing) this.setStatus(`Listening on glasses… ${event.seconds?.toFixed(0)}s`)
    } else if (event.kind === 'finishing') {
      this.stopPushToTalk(); this.emitEnd()
    } else if (event.kind === 'ended') {
      this.capturing = this.finalizing = false
      this.clearAudioTimer(); this.releaseMicrophone()
      this.setStatus(event.message ?? 'Ready to send'); this.emitEnd()
    }
  }
}
export const voiceControlBridge = new IosVoiceControlBridge()
