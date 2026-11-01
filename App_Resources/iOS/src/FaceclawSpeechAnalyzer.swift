@preconcurrency import AVFoundation
import CoreMedia
import Foundation
import Speech

/// Long-form on-device transcription with SpeechAnalyzer and SpeechTranscriber
/// (iOS 26+), for continuous capture (Transcribe, Teleprompter, Calculator):
/// FaceclawSpeech's SFSpeechRecognizer only handles short dictations. It takes
/// the same 16 kHz mono PCM16LE the cloud providers get (see
/// app/native/speech-analyzer-stt.ios.ts) and reports JSON events on the main
/// queue through eventHandler:
///
///   {"kind":"status","message":String}
///   {"kind":"ready","locale":String}           audio is accepted from here on
///   {"kind":"transcript","text":String,"final":Bool,
///    "start":Double?,"end":Double?,  the result's audio range
///    "speechEnd":Double?}            when its last word ends
///   {"kind":"finished"}                         after finish(), once the last result is in
///   {"kind":"error","message":String}
///
/// Times are seconds of audio since start. Volatile results (final: false)
/// cover all audio not finalized yet, replacing the previous volatile one;
/// their word times are only as fine as the result's range. A final's first
/// word reaches back into the silence before it, so only word ends are
/// reported.
///
/// There is no way to settle text at a pause: on macOS 26.4 any mid-stream
/// SpeechAnalyzer.finalize(through:) left the next phrase's final as dots,
/// while the model splits its finals at pauses on its own.
/// Called from JavaScript, so on the main thread.
@MainActor
@objc(FaceclawSpeechAnalyzer)
@objcMembers
public class FaceclawSpeechAnalyzer: NSObject {
    public var eventHandler: ((String) -> Void)?
    // An AnalyzerEngine, typed loosely so the class itself loads before iOS 26.
    private var engine: AnyObject?

    /// Whether this device can transcribe with SpeechTranscriber (iOS 26 and supported hardware).
    public static func isSupported() -> Bool {
        if #available(iOS 26.0, *) { return SpeechTranscriber.isAvailable }
        return false
    }

    /// `language` is a locale identifier ("en", "en-US"), or "" for the device's preferred language.
    public func start(language: String) {
        cancel()
        guard #available(iOS 26.0, *) else {
            emit(["kind": "error", "message": "On-device transcription needs iOS 26 or later."])
            return
        }
        let engine = AnalyzerEngine { [weak self] event in self?.emit(event) }
        self.engine = engine
        engine.start(language: language)
    }

    /// 16 kHz mono PCM16LE; ignored until "ready".
    public func acceptPcm(_ pcm: Data) {
        if #available(iOS 26.0, *) { (engine as? AnalyzerEngine)?.accept(pcm) }
    }

    /// End of audio: finalize the rest, then report "finished".
    public func finish() {
        if #available(iOS 26.0, *) { (engine as? AnalyzerEngine)?.finish() }
    }

    /// Abandon the session without further events.
    public func cancel() {
        if #available(iOS 26.0, *) { (engine as? AnalyzerEngine)?.cancel() }
        engine = nil
    }

    private func emit(_ event: [String: Any]) {
        // JSONSerialization raises (not throws) on NaN and other invalid values.
        guard JSONSerialization.isValidJSONObject(event),
              let data = try? JSONSerialization.data(withJSONObject: event),
              let json = String(data: data, encoding: .utf8) else { return }
        eventHandler?(json)
    }
}

@available(iOS 26.0, *)
@MainActor
private final class AnalyzerEngine {
    private static let sampleRate = 16000.0
    private let emit: ([String: Any]) -> Void
    private let pcmFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: AnalyzerEngine.sampleRate, channels: 1, interleaved: true)!
    private var analyzer: SpeechAnalyzer?
    private var input: AsyncStream<AnalyzerInput>.Continuation?
    private var analyzerFormat: AVAudioFormat?
    // Nil when the analyzer takes the input format as it is.
    private var converter: AVAudioConverter?
    private var ready = false
    private var finishing = false
    private var closed = false
    private var setup: Task<Void, Never>?
    private var results: Task<Void, Never>?

    init(emit: @escaping ([String: Any]) -> Void) { self.emit = emit }

    func start(language: String) {
        setup = Task { [weak self] in await self?.prepare(language: language) }
    }

    /// Events stop once the session is cancelled, even from work still winding down.
    private func send(_ event: [String: Any]) {
        if !closed { emit(event) }
    }

    private func prepare(language: String) async {
        send(["kind": "status", "message": "Preparing on-device transcription…"])
        let identifier = language.isEmpty ? (Locale.preferredLanguages.first ?? "en-US") : language
        guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: identifier)) else {
            fail("On-device transcription doesn't support \(identifier). Choose a cloud or Whisper server transcription provider (Settings > Voice).")
            return
        }
        if closed { return }
        let transcriber = SpeechTranscriber(locale: locale, transcriptionOptions: [],
                                            reportingOptions: [.volatileResults], attributeOptions: [.audioTimeRange])
        do {
            // Keep the model installed between sessions (best effort).
            if !(await AssetInventory.reservedLocales).contains(locale) {
                _ = try? await AssetInventory.reserve(locale: locale)
            }
            if closed { return }
            if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
                if closed { return }
                try await download(request)
            }
            if closed { return }
            guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
                fail("On-device transcription has no usable audio format.")
                return
            }
            if closed { return }
            if format != pcmFormat {
                guard let converter = AVAudioConverter(from: pcmFormat, to: format) else {
                    fail("On-device transcription can't convert the microphone audio.")
                    return
                }
                self.converter = converter
            }
            analyzerFormat = format
            let analyzer = SpeechAnalyzer(modules: [transcriber])
            let (stream, input) = AsyncStream<AnalyzerInput>.makeStream()
            self.analyzer = analyzer
            self.input = input
            results = Task { [weak self] in await self?.collect(transcriber) }
            try await analyzer.prepareToAnalyze(in: format)
            try await analyzer.start(inputSequence: stream)
            if closed { return }
            ready = true
            send(["kind": "ready", "locale": locale.identifier])
            if finishing { await finishAnalysis() }
        } catch {
            fail("On-device transcription: \(error.localizedDescription)")
        }
    }

    /// Fetch the locale's model, reporting progress while it downloads.
    private func download(_ request: AssetInstallationRequest) async throws {
        let progress = request.progress
        let reporter = Task { [weak self] in
            while !Task.isCancelled {
                let percent = Int((progress.fractionCompleted * 100).rounded())
                self?.send(["kind": "status", "message": "Downloading on-device speech model… \(percent)%"])
                try? await Task.sleep(nanoseconds: 1_000_000_000)
            }
        }
        defer { reporter.cancel() }
        try await request.downloadAndInstall()
    }

    func accept(_ pcm: Data) {
        guard ready, !finishing, !closed, let input, let analyzerFormat else { return }
        let frames = AVAudioFrameCount(pcm.count / 2)
        guard frames > 0, let buffer = AVAudioPCMBuffer(pcmFormat: pcmFormat, frameCapacity: frames),
              let channel = buffer.int16ChannelData else { return }
        buffer.frameLength = frames
        pcm.withUnsafeBytes { raw in
            if let base = raw.baseAddress { memcpy(channel[0], base, Int(frames) * 2) }
        }
        guard let converter else {
            input.yield(AnalyzerInput(buffer: buffer))
            return
        }
        let capacity = AVAudioFrameCount((Double(frames) * analyzerFormat.sampleRate / AnalyzerEngine.sampleRate).rounded(.up)) + 32
        guard let converted = AVAudioPCMBuffer(pcmFormat: analyzerFormat, frameCapacity: capacity) else { return }
        var consumed = false
        var error: NSError?
        // noDataNow, not endOfStream: the converter keeps its resampling state for the next chunk.
        converter.convert(to: converted, error: &error) { _, status in
            if consumed {
                status.pointee = .noDataNow
                return nil
            }
            consumed = true
            status.pointee = .haveData
            return buffer
        }
        if error == nil && converted.frameLength > 0 { input.yield(AnalyzerInput(buffer: converted)) }
    }

    func finish() {
        guard !finishing, !closed else { return }
        finishing = true
        // Before "ready", prepare() finishes once the analyzer is running.
        if ready { Task { await finishAnalysis() } }
    }

    private func finishAnalysis() async {
        input?.finish()
        input = nil
        do {
            try await analyzer?.finalizeAndFinishThroughEndOfInput()
        } catch {
            fail("On-device transcription: \(error.localizedDescription)")
        }
        // collect() reports "finished" once the results sequence ends.
    }

    func cancel() {
        guard !closed else { return }
        closed = true
        input?.finish()
        input = nil
        setup?.cancel()
        results?.cancel()
        if let analyzer { Task { await analyzer.cancelAndFinishNow() } }
        analyzer = nil
    }

    private func collect(_ transcriber: SpeechTranscriber) async {
        do {
            for try await result in transcriber.results {
                if closed { return }
                send(event(for: result))
            }
            send(["kind": "finished"])
        } catch {
            fail("On-device transcription: \(error.localizedDescription)")
        }
    }

    private func event(for result: SpeechTranscriber.Result) -> [String: Any] {
        let text = result.text
        var speechEnd: Double?
        for run in text.runs {
            guard let range = run.audioTimeRange,
                  !String(text[run.range].characters).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
            speechEnd = finite(range.end) ?? speechEnd
        }
        return [
            "kind": "transcript",
            "text": String(text.characters),
            "final": result.isFinal,
            "start": finite(result.range.start) ?? NSNull(),
            "end": finite(result.range.end) ?? NSNull(),
            "speechEnd": speechEnd ?? NSNull(),
        ]
    }

    private func finite(_ time: CMTime) -> Double? {
        let seconds = time.seconds
        return seconds.isFinite ? seconds : nil
    }

    private func fail(_ message: String) {
        guard !closed else { return }
        emit(["kind": "error", "message": message])
        cancel()
    }
}
