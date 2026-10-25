import type { VoiceControlState, VoiceTranscriptEvent } from './voice-control'
import type { CloudSttTranscriptEvent } from './cloud-stt'
import type { ReconnectingSttClient } from './reconnecting-stt'
import { createCloudSttClient, usesCloudStt, type VoiceProviderSelection } from './cloud-stt-provider'
import { WavRecorder } from './wav-recorder.ios'
import { pcmLevel } from '../util/audio-level'

declare const FaceclawSpeech: any
export type IosMicrophoneSession = {
  setMicrophone(enabled: boolean, listener?: (packet: Uint8Array) => void): Promise<void>
}
/** How long a cloud provider gets, after the last audio, to send its final transcript. */
const CLOUD_FINAL_TIMEOUT_MS = 5000

/** iOS implementation of the shared voice dialog's event bridge. Audio comes
 * from the glasses when connected, or the default phone input in preview mode,
 * and is transcribed by Apple's on-device recognizer or a cloud provider.
 * Continuous capture (Transcribe, Teleprompter) needs a cloud provider: only
 * the PCM capture runs open-ended, and pauses commit its segments. When the
 * session or the app lifecycle cuts one short it is drained, not discarded;
 * restarting it is the controller's call.
 */
export class IosVoiceControlBridge {
  private native: any = null
  private readonly statuses = new Set<(state: VoiceControlState) => void>()
  private readonly transcripts = new Set<(event: VoiceTranscriptEvent) => void>()
  private readonly ends = new Set<() => void>()
  private readonly levels = new Set<(level: number) => void>()
  private status = 'Voice input ready.'
  private generation = 0
  private session: IosMicrophoneSession | null = null
  private source: 'glasses' | 'phone' | null = null
  private capturing = false
  private finalizing = false
  private completion: Promise<void> = Promise.resolve()
  private resolveCompletion: (() => void) | null = null
  private audioTimer: ReturnType<typeof setTimeout> | null = null
  private packets = 0
  private log: (message: string) => void = () => {}
  // Non-null while a cloud provider owns the transcript; FaceclawSpeech then
  // only supplies PCM. cloudEndStatus is set once the audio has ended and the
  // provider was asked to finalize; it is the status shown when it does.
  private cloud: ReconnectingSttClient | null = null
  private cloudEndStatus: string | null = null
  private cloudTimer: ReturnType<typeof setTimeout> | null = null
  // Open-ended capture: runs until stopContinuousCapture, and push-to-talk
  // joins it instead of restarting the mic (transcripts reach every listener).
  private continuous = false
  // Shown instead of the native "ended" status once a drain the bridge started completes.
  private drainStatus: string | null = null
  // Continuous captures' audio goes to Downloads/<recordingName>.wav while it is
  // set. The file outlives a capture, so a restarted one keeps appending to it,
  // and it is created by the first audio, so a failed start leaves no file.
  private recordingName = ''
  private recorder: WavRecorder | null = null

  onStatus(listener: (state: VoiceControlState) => void): () => void {
    this.statuses.add(listener); listener({ status: this.status, listening: this.capturing, detail: '' }); return () => { this.statuses.delete(listener) }
  }
  onTranscript(listener: (event: VoiceTranscriptEvent) => void): () => void {
    this.transcripts.add(listener); return () => { this.transcripts.delete(listener) }
  }
  onSpeechEnd(listener: () => void): () => void { this.ends.add(listener); return () => { this.ends.delete(listener) } }
  onSpeechPause(_listener: () => void): () => void { return () => {} }
  /** The mic level (see pcmLevel) of each PCM chunk; only cloud captures supply PCM. */
  onMicLevel(listener: (level: number) => void): () => void { this.levels.add(listener); return () => { this.levels.delete(listener) } }
  private setStatus(status: string): void { this.status = status; for (const fn of [...this.statuses]) fn({ status, listening: this.capturing, detail: '' }) }
  private ensureNative(): any {
    if (!this.native) {
      this.native = FaceclawSpeech.new()
      this.native.eventHandler = (json: string) => this.receive(JSON.parse(json))
      this.native.pcmHandler = (pcm: NSData) => {
        // Copied: bufferFromData doesn't retain pcm, and STT clients queue chunks.
        const bytes = new Uint8Array(interop.bufferFromData(pcm)).slice()
        this.cloud?.acceptPcm(bytes)
        if (this.continuous) this.record(bytes)
        if (this.levels.size) { const level = pcmLevel(bytes); for (const fn of [...this.levels]) fn(level) }
      }
    }
    return this.native
  }
  async prepare(foreground: boolean, usePhoneMic: boolean, voice: VoiceProviderSelection): Promise<boolean> {
    // Only Apple's recognizer needs Speech Recognition; a cloud provider just needs audio.
    if (!usesCloudStt(voice)) {
      let status = FaceclawSpeech.authorizationStatus()
      if (status === 0) {
        if (!foreground) { this.setStatus('Open Faceclaw on the phone once to allow Speech Recognition.'); return false }
        status = await new Promise<number>(resolve => FaceclawSpeech.requestAuthorization(resolve))
      }
      if (status !== 3) { this.setStatus('Allow Speech Recognition for Faceclaw in iPhone Settings.'); return false }
    }
    if (usePhoneMic) {
      let microphoneStatus = FaceclawSpeech.microphoneAuthorizationStatus()
      if (microphoneStatus === 0) {
        if (!foreground) { this.setStatus('Open Faceclaw on the phone to allow microphone access.'); return false }
        microphoneStatus = await new Promise<number>(resolve => FaceclawSpeech.requestMicrophoneAuthorization(resolve))
      }
      if (microphoneStatus !== 3) { this.setStatus('Allow Microphone access for Faceclaw in iPhone Settings.'); return false }
    }
    return true
  }
  get statusText(): string { return this.status }
  async startGlassesCapture(session: IosMicrophoneSession, voice: VoiceProviderSelection, log: (message: string) => void, endpointing = false, continuous = false): Promise<void> {
    if (this.joinsContinuous(continuous)) return
    this.stop()
    const generation = ++this.generation
    this.continuous = continuous
    this.log = log; this.source = 'glasses'; this.session = session; this.packets = 0; this.capturing = true
    this.completion = new Promise(resolve => { this.resolveCompletion = resolve })
    const startError = this.startNative(voice, endpointing, false)
    if (startError) { this.stop(); this.setStatus(startError); this.emitEnd(); return }
    try {
      await session.setMicrophone(true, packet => {
        if (generation !== this.generation || !this.capturing) return
        this.packets++
        const copy = new Uint8Array(packet)
        this.native.acceptPacket(NSData.dataWithBytesLength(interop.handleof(copy.buffer), copy.byteLength))
      })
      if (generation !== this.generation || !this.capturing) return
      log(`Voice: glasses microphone enabled; using ${this.cloud ? 'cloud' : 'on-device'} recognition`)
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
  async startPhoneCapture(voice: VoiceProviderSelection, log: (message: string) => void, endpointing = false, continuous = false): Promise<void> {
    if (this.joinsContinuous(continuous)) return
    this.stop()
    this.continuous = continuous
    this.log = log; this.source = 'phone'; this.capturing = true
    this.completion = new Promise(resolve => { this.resolveCompletion = resolve })
    const error = this.startNative(voice, endpointing, true)
    if (error) { this.stop(); this.setStatus(error); this.emitEnd(); return }
    log(`Voice: phone default microphone enabled; using ${this.cloud ? 'cloud' : 'on-device'} recognition`)
  }
  /** Starts the native capture for the chosen provider; returns an actionable error, or ''. */
  private startNative(voice: VoiceProviderSelection, endpointing: boolean, phone: boolean): string {
    const native = this.ensureNative()
    const generation = this.generation
    const current = () => generation === this.generation
    const cloud = createCloudSttClient(voice, {
      onTranscript: event => { if (current()) this.receiveCloudTranscript(event) },
      onStatus: status => { if (current()) this.setStatus(status) },
      onError: message => { if (current()) { this.stop(); this.setStatus(message); this.emitEnd() } },
    }, () => this.continuous)
    if (!cloud) return String((phone ? native.startPhoneWithEndpointing(endpointing) : native.startWithEndpointing(endpointing)) ?? '')
    const error = String(native.startPcmCaptureWithEndpointingPhone(endpointing, phone) ?? '')
    if (error) return error
    this.cloud = cloud
    cloud.start()
    return ''
  }
  stopPhoneCapture(): void {
    if (this.source !== 'phone') return
    if (this.continuous) { if (this.capturing) void this.finalizeCapture('Paused while Faceclaw is in the background.'); return }
    this.stop(); this.setStatus('Phone voice input stopped.'); this.emitEnd()
  }
  /** Whether continuous capture can run with this provider (Apple's recognizer can't). */
  supportsContinuous(voice: VoiceProviderSelection): boolean { return usesCloudStt(voice) }
  get continuousActive(): boolean { return this.continuous && (this.capturing || this.finalizing) }
  /** Where a listening continuous capture gets its audio; null when none is listening. */
  get continuousSource(): 'glasses' | 'phone' | null { return this.continuous && this.capturing ? this.source : null }
  /**
   * Record continuous captures' audio to Downloads/<name>.wav, across restarts,
   * until called with another name or ''. Only cloud captures supply PCM.
   */
  recordTo(name: string): void {
    if (name === this.recordingName) return
    this.recorder?.close(); this.recorder = null
    this.recordingName = name
  }
  private record(pcm: Uint8Array): void {
    if (!this.recorder && this.recordingName) {
      this.recorder = WavRecorder.open(this.recordingName)
      this.log(this.recorder ? `Voice: recording audio to ${this.recorder.path}` : 'Voice: could not create the audio recording')
      // One attempt per recording, not one per packet.
      if (!this.recorder) this.recordingName = ''
    }
    this.recorder?.append(pcm)
  }
  /** End continuous capture, transcribing the audio since the last pause. */
  stopContinuousCapture(): Promise<void> {
    if (!this.continuous) return Promise.resolve()
    return this.finalizeCapture()
  }
  /** Push-to-talk shares a listening continuous capture (not one that is only finalizing). */
  private joinsContinuous(continuous: boolean): boolean {
    if (continuous || !this.continuous || !this.capturing) return false
    this.log('Voice: push-to-talk joins the running continuous capture')
    return true
  }
  stopPushToTalk(): Promise<void> {
    // The continuous capture owns the mic and keeps it.
    if (this.continuous) return Promise.resolve()
    return this.finalizeCapture()
  }
  private finalizeCapture(status: string | null = null): Promise<void> {
    const completion = this.completion
    if (!this.capturing) return completion
    this.capturing = false; this.finalizing = true
    this.drainStatus = status
    this.clearAudioTimer(); this.releaseMicrophone()
    this.setStatus('Recognizing…'); this.native?.finish()
    return completion
  }
  stop(): void {
    ++this.generation
    this.capturing = this.finalizing = this.continuous = false
    this.source = null; this.drainStatus = null
    this.clearAudioTimer(); this.releaseMicrophone(); this.native?.cancel()
    this.clearCloud()
    this.finishCompletion()
  }
  /**
   * The glasses session went away (or the glasses locked). Push-to-talk ends
   * with `message`; continuous capture transcribes what it already heard and
   * shows `continuousMessage`.
   */
  handleSessionEnded(message = 'Glasses disconnected. Start voice input again after reconnecting.',
    continuousMessage = 'Glasses disconnected. Transcription resumes when they reconnect.'): void {
    if (this.source !== 'glasses' || !this.capturing && !this.finalizing) return
    if (this.continuous) { if (this.capturing) void this.finalizeCapture(continuousMessage); return }
    this.stop(); this.setStatus(message); this.emitEnd()
  }
  private clearAudioTimer(): void { if (this.audioTimer !== null) clearTimeout(this.audioTimer); this.audioTimer = null }
  private releaseMicrophone(): void {
    const session = this.session; this.session = null
    if (session) void session.setMicrophone(false).catch(error => this.log(`Voice microphone cleanup: ${error}`))
  }
  private clearCloud(): void {
    if (this.cloudTimer !== null) clearTimeout(this.cloudTimer)
    this.cloudTimer = null
    this.cloud?.stop(); this.cloud = null; this.cloudEndStatus = null
  }
  /** The native audio has ended; have the provider finalize what it heard. */
  private finishCloud(status: string): void {
    this.capturing = false; this.finalizing = true
    this.cloudEndStatus = status
    this.setStatus('Recognizing…')
    // Armed first: finish() can deliver the final synchronously.
    this.cloudTimer = setTimeout(() => this.completeCloud(), this.cloud?.finalTimeoutMs ?? CLOUD_FINAL_TIMEOUT_MS)
    this.cloud?.finish()
  }
  private completeCloud(): void {
    const status = this.cloudEndStatus ?? 'Ready to send'
    this.clearCloud()
    this.capturing = this.finalizing = this.continuous = false
    this.finishCompletion()
    this.setStatus(status); this.emitEnd()
  }
  private receiveCloudTranscript(event: CloudSttTranscriptEvent): void {
    if (!this.capturing && !this.finalizing) return
    for (const fn of [...this.transcripts]) fn(event)
    // Push-to-talk commits once, so the first final after it is the last.
    // In continuous capture, earlier pause segments (paragraphBreakAfter) may still arrive.
    if (event.isFinal && this.cloudEndStatus !== null && !(this.continuous && event.paragraphBreakAfter)) this.completeCloud()
  }
  private emitEnd(): void { for (const fn of [...this.ends]) fn() }
  private finishCompletion(): void {
    const resolve = this.resolveCompletion; this.resolveCompletion = null; resolve?.()
  }
  private receive(event: { kind: string; text?: string; final?: boolean; message?: string; seconds?: number; packets?: number; rms?: number; missing?: number; errors?: number }): void {
    if (!this.capturing && !this.finalizing) return
    if (event.kind === 'transcript') {
      this.log(`Voice: ${event.final ? 'final' : 'partial'} transcript (${event.text?.length ?? 0} characters)`)
      for (const fn of [...this.transcripts]) fn({ text: event.text ?? '', isFinal: !!event.final })
    } else if (event.kind === 'status') this.setStatus(event.message ?? '')
    else if (event.kind === 'audio') {
      this.log(`Voice audio: ${event.seconds?.toFixed(1)}s, packets=${event.packets}, RMS=${event.rms?.toFixed(4)}, missing=${event.missing}, errors=${event.errors}`)
      // A cloud provider's own status (connecting, listening, reconnecting) stays up.
      if (this.capturing && !this.cloud) this.setStatus(`Listening on ${this.source === 'phone' ? 'phone' : 'glasses'}… ${event.seconds?.toFixed(0)}s`)
    } else if (event.kind === 'finishing') {
      void this.stopPushToTalk(); this.emitEnd()
    } else if (event.kind === 'ended') {
      const status = this.drainStatus ?? event.message ?? 'Ready to send'
      this.source = null; this.drainStatus = null
      this.clearAudioTimer(); this.releaseMicrophone()
      if (this.cloud) { this.finishCloud(status); return }
      this.capturing = this.finalizing = false
      this.finishCompletion()
      this.setStatus(status); this.emitEnd()
    }
  }
}
export const voiceControlBridge = new IosVoiceControlBridge()
