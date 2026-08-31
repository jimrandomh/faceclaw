package com.faceclaw.app;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;

import com.k2fsa.sherpa.onnx.FeatureConfig;
import com.k2fsa.sherpa.onnx.OfflineModelConfig;
import com.k2fsa.sherpa.onnx.OfflineMoonshineModelConfig;
import com.k2fsa.sherpa.onnx.OfflineRecognizer;
import com.k2fsa.sherpa.onnx.OfflineRecognizerConfig;
import com.k2fsa.sherpa.onnx.OfflineRecognizerResult;
import com.k2fsa.sherpa.onnx.OfflineStream;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.Arrays;

public class FaceclawVoiceController {
    private static final String TAG = "FaceclawVoice";
    private static final int SAMPLE_RATE = 16000;
    private static final int FEATURE_DIM = 80;
    private static final int MAX_AUDIO_QUEUE_PACKETS = 80;
    private static final int EXPECTED_PACKET_INTERVAL_MS = 50;
    private static final int LATE_PACKET_INTERVAL_MS = 90;
    private static final int STATS_INTERVAL_MS = 5_000;
    // Push-to-talk utterance boundaries come from the button. We re-decode the
    // current audio segment in full for each live partial and emit the complete
    // utterance text (REPLACE, never a delta). The sherpa Moonshine v2 decoder
    // used here fails once a single input grows past roughly 9.1 seconds, so
    // longer utterances are committed in model-safe segments.
    private static final int TRANSCRIPT_DECODE_INTERVAL_MS = 700;
    private static final int TRANSCRIPT_MIN_SAMPLES = SAMPLE_RATE / 3;
    private static final int TRANSCRIPT_SEGMENT_MAX_SAMPLES = SAMPLE_RATE * 8;
    // When a segment fills, cut at the quietest window within the last
    // TRANSCRIPT_CUT_SEARCH_SAMPLES rather than mid-word at the 8s mark; the
    // audio after the cut carries over into the next segment.
    private static final int TRANSCRIPT_CUT_SEARCH_SAMPLES = SAMPLE_RATE * 2;
    private static final int TRANSCRIPT_CUT_WINDOW_SAMPLES = SAMPLE_RATE * 30 / 1000;
    // Glasses-mic PCM peaks around 0.1 full scale, and at that level the
    // quantized Moonshine model often returns empty or garbled text. Boost
    // each decode window toward this peak, with a gain cap so near-silent
    // buffers aren't amplified into pure noise.
    private static final float TRANSCRIPT_NORMALIZE_TARGET_PEAK = 0.9f;
    private static final float TRANSCRIPT_NORMALIZE_MAX_GAIN = 30f;
    private static final int TRANSCRIPT_LOG_PREVIEW_CHARS = 80;
    // Model directory shared with the TS-side download flow (asr-model.ts),
    // which fetches the Moonshine files here on demand; they are no longer
    // bundled in the APK.
    private static final String ASR_ROOT = "faceclaw-voice-asr";
    private static final String ASR_MODEL_DIR = "sherpa-onnx-moonshine-base-en-quantized-2026-02-27";
    // Model files for the retired on-phone wake-word spotter, copied to
    // filesDir by earlier releases; deleted on sight to reclaim the space.
    // (The wakeword is now detected by the glasses firmware itself.)
    private static final String LEGACY_KWS_ROOT = "faceclaw-voice";
    private static final String[] ASR_MODEL_FILES = {
            "encoder_model.ort",
            "decoder_model_merged.ort",
            "tokens.txt"
    };

    private enum VoiceInputMode {
        ONBOARD,  // on-phone Moonshine transcription
        CLOUD     // decode locally, emit PCM for a cloud recognizer on the TS side
    }

    private final Context appContext;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final Object lock = new Object();
    private final Object audioQueueLock = new Object();
    private final ArrayDeque<AudioPacket> audioQueue = new ArrayDeque<>();
    private volatile FaceclawVoiceControllerListener listener;
    private volatile FaceclawBleCommunicator communicator;
    private Thread workerThread;
    private volatile boolean started;
    // Set once the worker has the glasses mic enabled for this session.
    // Read and written under `lock`, so it flips with `started` atomically.
    private boolean audioStarted;
    // Capture from the phone's own microphone instead of the G2 over BLE
    // (preview-only mode, where no glasses are connected). Latched into
    // activePhoneMic at start() (under `lock`) so a mid-session setter call
    // can't switch pipelines underneath the worker.
    private volatile boolean usePhoneMic;
    private boolean activePhoneMic;
    private VoiceInputMode mode = VoiceInputMode.CLOUD;
    private OfflineRecognizer recognizer;
    private FaceclawLc3Decoder lc3Decoder;
    private final float[] transcriptSamples = new float[TRANSCRIPT_SEGMENT_MAX_SAMPLES];
    private int transcriptSampleCount;
    private long committedTranscriptSampleCount;
    private String committedTranscript = "";
    private String currentSegmentTranscript = "";
    private long lastTranscriptDecodeAtMs;
    private String lastTranscript = "";
    private volatile boolean saveRecordings;
    private volatile boolean endpointing;
    private final EndpointDetector endpointDetector = new EndpointDetector();
    private java.io.ByteArrayOutputStream recordingPcm;
    // Speaker verification against the enrolled wearer voice-print ("my voice
    // only" command gating). Configured before start(); the utterance PCM is
    // buffered (capped) and verified once at session end.
    private static final int VERIFY_MAX_SAMPLES = SAMPLE_RATE * 10;
    private static final int VERIFY_MIN_SAMPLES = SAMPLE_RATE;
    private volatile String verifySpeakerModelPath;
    private volatile float[] verifyWearerEmbedding;
    private volatile float verifyThreshold = 0.8f;
    private short[] verifyBuffer;
    private int verifyCount;
    // Global mic processing (Microphones app config): spectral noise
    // suppression and firmware-DoA beam gating, applied to every capture
    // session that opts in (assistant push-to-talk, Transcribe, hands-free).
    // The raw tap opts out — raw means raw, and the Microphones session does
    // its own beam-compensated processing on that path.
    private volatile boolean suppressionEnabled;
    private volatile boolean beamFilterEnabled;
    private volatile int beamCenterDeg;
    private volatile int beamHalfWidthDeg = 180;
    private FaceclawNoiseSuppressor suppressor;
    private long queuedPackets;
    private long queueDroppedPackets;
    private long decodedSamples;
    private long latePackets;
    private long wrongArmPackets;
    private long lastPacketArrivalMs;
    private long maxInterPacketMs;
    private long lastStatsAtMs;

    public FaceclawVoiceController(Context context) {
        this.appContext = context.getApplicationContext();
    }

    public void setListener(FaceclawVoiceControllerListener listener) {
        this.listener = listener;
    }

    public void setCommunicator(FaceclawBleCommunicator communicator) {
        this.communicator = communicator;
    }

    /** Source the next capture from the phone microphone (no glasses paired). */
    public void setUsePhoneMic(boolean usePhoneMic) {
        this.usePhoneMic = usePhoneMic;
    }

    /** When true, the decoded mic PCM for each session is saved as a WAV. */
    public void setSaveRecordings(boolean saveRecordings) {
        this.saveRecordings = saveRecordings;
    }

    /**
     * When true, watch the decoded PCM and fire {@code onSpeechEnd} once the
     * speaker stops. Used by hands-free ("Hey Even") capture, which has no
     * button release to end the utterance. Must be set before {@link #start}.
     */
    public void setEndpointing(boolean endpointing) {
        this.endpointing = endpointing;
    }

    /**
     * Verify this session's speaker against the enrolled wearer voice-print
     * and report the result via onSpeakerVerified just before the final
     * transcript. Must be set before {@link #start}; pass a null model path
     * to disable.
     */
    public void setSpeakerVerification(String speakerModelPath, float[] wearerEmbedding, float threshold) {
        this.verifySpeakerModelPath = speakerModelPath;
        this.verifyWearerEmbedding = wearerEmbedding;
        this.verifyThreshold = threshold > 0 ? threshold : 0.8f;
    }

    public void clearSpeakerVerification() {
        this.verifySpeakerModelPath = null;
        this.verifyWearerEmbedding = null;
    }

    /** Spectral noise suppression on the decoded stream. Safe to flip mid-run. */
    public void setNoiseSuppression(boolean enabled) {
        this.suppressionEnabled = enabled;
    }

    /**
     * Direction gating from the Sonic Radar beam: packets whose firmware
     * direction-of-arrival falls outside centerDeg ± halfWidthDeg (device
     * frame, 0 = straight ahead, positive right) are dropped before any
     * consumer sees them. Safe to update mid-run.
     */
    public void setBeamFilter(boolean enabled, int centerDeg, int halfWidthDeg) {
        this.beamFilterEnabled = enabled;
        this.beamCenterDeg = centerDeg;
        this.beamHalfWidthDeg = Math.max(5, Math.min(180, halfWidthDeg));
    }

    private boolean withinBeam(int angleDegrees) {
        int delta = angleDegrees - beamCenterDeg;
        while (delta > 180) delta -= 360;
        while (delta < -180) delta += 360;
        return Math.abs(delta) <= beamHalfWidthDeg;
    }

    private void applySuppression(short[] pcm, int count) {
        try {
            if (suppressor == null) {
                suppressor = new FaceclawNoiseSuppressor(SAMPLE_RATE);
            }
            byte[] le = new byte[count * 2];
            for (int i = 0; i < count; i++) {
                le[i * 2] = (byte) (pcm[i] & 0xff);
                le[i * 2 + 1] = (byte) ((pcm[i] >> 8) & 0xff);
            }
            byte[] cleaned = suppressor.process(le);
            int cleanedCount = Math.min(count, cleaned.length / 2);
            for (int i = 0; i < cleanedCount; i++) {
                pcm[i] = (short) ((cleaned[i * 2] & 0xff) | (cleaned[i * 2 + 1] << 8));
            }
        } catch (Throwable t) {
            Log.w(TAG, "noise suppression failed; passing audio through", t);
            suppressionEnabled = false;
        }
    }

    public void start(String requestedMode) {
        synchronized (lock) {
            if (started) {
                emitStatus("Voice control is already listening.");
                return;
            }
            if (!usePhoneMic && (communicator == null || !communicator.isSessionReady())) {
                emitStatus("Voice control needs an active G2 connection.");
                return;
            }
            mode = parseMode(requestedMode);
            activePhoneMic = usePhoneMic;
            started = true;
            audioStarted = false;
            workerThread = new Thread(this::runLoop, "FaceclawVoiceController");
            workerThread.start();
        }
    }

    /**
     * Whether mic audio is actually flowing. {@link #start} only records
     * intent: the enable lives in the glasses' EvenHub session, so a transport
     * drop or a session suspend can leave this controller started with a
     * worker that will never see another packet. Anything deciding whether to
     * (re)start capture must ask this rather than assume its own bookkeeping.
     */
    public boolean isCapturing() {
        boolean audioUp;
        boolean phoneMic;
        synchronized (lock) {
            if (!started) {
                return false;
            }
            audioUp = audioStarted;
            phoneMic = activePhoneMic;
        }
        if (!audioUp) {
            // The worker is still bringing the mic up; report it as running so
            // a concurrent request shares it instead of restarting it.
            return true;
        }
        if (phoneMic) {
            // AudioRecord has no session to lose the enable to; it runs until stop().
            return true;
        }
        FaceclawBleCommunicator currentCommunicator = communicator;
        return currentCommunicator != null && currentCommunicator.isAudioCaptureActive();
    }

    public void stop() {
        Thread threadToJoin;
        synchronized (lock) {
            if (!started) {
                return;
            }
            started = false;
            threadToJoin = workerThread;
        }
        stopG2Audio();
        synchronized (audioQueueLock) {
            audioQueueLock.notifyAll();
        }
        if (threadToJoin != null) {
            threadToJoin.interrupt();
            if (Thread.currentThread() != threadToJoin) {
                try {
                    threadToJoin.join(1500);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            }
        }
    }

    public void close() {
        stop();
    }

    private VoiceInputMode parseMode(String requestedMode) {
        if ("cloud".equals(requestedMode)) {
            return VoiceInputMode.CLOUD;
        }
        return VoiceInputMode.ONBOARD;
    }

    private void runLoop() {
        try {
            deleteLegacyKwsFiles();
            VoiceInputMode currentMode = mode;
            if (currentMode == VoiceInputMode.ONBOARD) {
                File modelDir = findAsrModelDir();
                if (modelDir == null) {
                    emitStatus("Voice model not downloaded (see Settings > Voice).");
                    return;
                }
                emitStatus("Loading transcription model...");
                recognizer = new OfflineRecognizer(buildRecognizerConfig(modelDir));
                resetTranscriptState();
                lastTranscript = "";
            }
            endpointDetector.reset();
            if (suppressor != null) {
                suppressor.reset();
            }
            recordingPcm = saveRecordings ? new java.io.ByteArrayOutputStream(SAMPLE_RATE * 2 * 4) : null;
            boolean verifying = verifySpeakerModelPath != null && verifyWearerEmbedding != null;
            verifyBuffer = verifying ? new short[VERIFY_MAX_SAMPLES] : null;
            verifyCount = 0;
            if (activePhoneMic) {
                android.media.AudioRecord record = openPhoneMic();
                if (record == null) {
                    emitStatus("Could not start the phone microphone.");
                    return;
                }
                synchronized (lock) {
                    audioStarted = true;
                }
                emitStatus(currentMode == VoiceInputMode.CLOUD
                        ? "Listening (cloud)..."
                        : "Listening...");
                try {
                    processPhoneAudio(record);
                } finally {
                    try {
                        record.stop();
                    } catch (Throwable ignored) {
                        // Already stopped or never recording; release below either way.
                    }
                    record.release();
                }
            } else {
                lc3Decoder = new FaceclawLc3Decoder();
                if (!startG2Audio()) {
                    emitStatus("Could not start G2 microphone input.");
                    return;
                }
                synchronized (lock) {
                    audioStarted = true;
                }
                emitStatus(currentMode == VoiceInputMode.CLOUD
                        ? "Listening (cloud)..."
                        : "Listening...");
                processG2Audio();
            }
            // Verification result must precede the final transcript so the
            // TS bridge can suppress a non-wearer command before it is acted
            // on (the callbacks are posted in order to the main handler).
            runSpeakerVerification();
            // Button released / stop requested: emit one final full-utterance
            // transcript so the UI can freeze it.
            if (currentMode == VoiceInputMode.ONBOARD) {
                decodeTranscript(true);
            }
        } catch (Throwable error) {
            Log.e(TAG, "Voice control failed", error);
            emitStatus("Voice control failed: " + error.getMessage());
        } finally {
            stopG2Audio();
            writeRecordingIfAny();
            releaseSherpa();
            releaseLc3();
            synchronized (lock) {
                started = false;
                audioStarted = false;
                workerThread = null;
            }
        }
    }

    private void appendRecording(short[] pcm, int count) {
        java.io.ByteArrayOutputStream out = recordingPcm;
        if (out == null) {
            return;
        }
        for (int i = 0; i < count; i++) {
            short s = pcm[i];
            out.write(s & 0xff);
            out.write((s >> 8) & 0xff);
        }
    }

    /** Save the session's decoded mic PCM as a 16 kHz mono 16-bit WAV. */
    private void writeRecordingIfAny() {
        java.io.ByteArrayOutputStream out = recordingPcm;
        recordingPcm = null;
        if (out == null || out.size() == 0) {
            return;
        }
        try {
            byte[] pcmBytes = out.toByteArray();
            java.io.File dir = new java.io.File(appContext.getExternalFilesDir(null), "voice-recordings");
            if (!dir.exists() && !dir.mkdirs()) {
                Log.w(TAG, "could not create voice-recordings dir");
                return;
            }
            String stamp = new java.text.SimpleDateFormat("yyyyMMdd-HHmmss-SSS", java.util.Locale.US)
                    .format(new java.util.Date());
            java.io.File file = new java.io.File(dir, "voice-" + stamp + ".wav");
            try (java.io.FileOutputStream fos = new java.io.FileOutputStream(file)) {
                fos.write(buildWavHeader(pcmBytes.length, SAMPLE_RATE, 1, 16));
                fos.write(pcmBytes);
            }
            Log.i(TAG, "saved voice recording " + file.getAbsolutePath()
                    + " samples=" + (pcmBytes.length / 2)
                    + " sec=" + String.format(java.util.Locale.US, "%.2f", pcmBytes.length / 2.0 / SAMPLE_RATE));
        } catch (Throwable t) {
            Log.w(TAG, "failed to save voice recording", t);
        }
    }

    private static byte[] buildWavHeader(int pcmBytes, int sampleRate, int channels, int bitsPerSample) {
        int byteRate = sampleRate * channels * bitsPerSample / 8;
        int blockAlign = channels * bitsPerSample / 8;
        int dataSize = pcmBytes;
        int riffSize = 36 + dataSize;
        java.nio.ByteBuffer b = java.nio.ByteBuffer.allocate(44).order(java.nio.ByteOrder.LITTLE_ENDIAN);
        b.put("RIFF".getBytes(StandardCharsets.US_ASCII));
        b.putInt(riffSize);
        b.put("WAVE".getBytes(StandardCharsets.US_ASCII));
        b.put("fmt ".getBytes(StandardCharsets.US_ASCII));
        b.putInt(16);            // PCM fmt chunk size
        b.putShort((short) 1);   // PCM
        b.putShort((short) channels);
        b.putInt(sampleRate);
        b.putInt(byteRate);
        b.putShort((short) blockAlign);
        b.putShort((short) bitsPerSample);
        b.put("data".getBytes(StandardCharsets.US_ASCII));
        b.putInt(dataSize);
        return b.array();
    }

    private OfflineRecognizerConfig buildRecognizerConfig(File modelDir) {
        return OfflineRecognizerConfig.builder()
                .setFeatureConfig(FeatureConfig.builder()
                        .setSampleRate(SAMPLE_RATE)
                        .setFeatureDim(FEATURE_DIM)
                        .build())
                .setModelConfig(OfflineModelConfig.builder()
                        .setMoonshine(OfflineMoonshineModelConfig.builder()
                                .setEncoder(new File(modelDir, "encoder_model.ort").getAbsolutePath())
                                .setMergedDecoder(new File(modelDir, "decoder_model_merged.ort").getAbsolutePath())
                                .build())
                        .setTokens(new File(modelDir, "tokens.txt").getAbsolutePath())
                        .setNumThreads(1)
                        .build())
                .build();
    }

    /**
     * The Moonshine model directory, populated by the download flow in
     * asr-model.ts (releases before 0.5.0 copied the same files out of the
     * APK, so upgraded installs are already complete). Null when any file is
     * missing, i.e. the model still needs to be downloaded.
     */
    private File findAsrModelDir() {
        File modelDir = new File(appContext.getFilesDir(), ASR_ROOT + File.separator + ASR_MODEL_DIR);
        for (String fileName : ASR_MODEL_FILES) {
            File file = new File(modelDir, fileName);
            if (!file.exists() || file.length() == 0) {
                return null;
            }
        }
        return modelDir;
    }

    private void deleteLegacyKwsFiles() {
        try {
            deleteRecursively(new File(appContext.getFilesDir(), LEGACY_KWS_ROOT));
        } catch (Throwable t) {
            Log.w(TAG, "failed to delete legacy wake-word files", t);
        }
    }

    private static void deleteRecursively(File file) {
        if (!file.exists()) {
            return;
        }
        File[] children = file.listFiles();
        if (children != null) {
            for (File child : children) {
                deleteRecursively(child);
            }
        }
        file.delete();
    }

    private boolean startG2Audio() {
        FaceclawBleCommunicator currentCommunicator = communicator;
        if (currentCommunicator == null) {
            return false;
        }
        resetAudioStats();
        synchronized (audioQueueLock) {
            audioQueue.clear();
        }
        return currentCommunicator.startG2AudioCapture(this::queueAudioPacket);
    }

    private void processG2Audio() {
        short[] pcm = new short[FaceclawLc3Decoder.SAMPLES_PER_PACKET];
        while (started && !Thread.currentThread().isInterrupted()) {
            FaceclawLc3Decoder currentDecoder = lc3Decoder;
            if (currentDecoder == null) {
                return;
            }

            AudioPacket packet = takeAudioPacket();
            if (packet == null) {
                continue;
            }

            int count = currentDecoder.decodePacket(packet.data, pcm);
            if (count <= 0) {
                maybeEmitAudioStats(false);
                continue;
            }
            decodedSamples += count;
            // Global mic processing from the Microphones app config: the
            // beam filter drops packets whose firmware direction-of-arrival
            // falls outside the listening wedge (isolating the aimed talker
            // for every consumer, recognition included), and the spectral
            // noise suppressor cleans what remains before it reaches the
            // recognizer, cloud PCM, endpointing, or speaker verification.
            int angleDegrees = currentDecoder.getLastAngleDegrees();
            int ssr = currentDecoder.getLastSsr();
            if (beamFilterEnabled && ssr > 0 && !withinBeam(angleDegrees)) {
                emitFrameMeta(angleDegrees, ssr);
                maybeEmitAudioStats(false);
                continue;
            }
            processPcmChunk(pcm, count, angleDegrees, ssr, true);
            maybeEmitAudioStats(false);
        }
    }

    /**
     * Per-chunk processing shared by the G2 and phone-mic paths, downstream of
     * decode and the beam filter. hasFrameMeta is false for the phone mic,
     * which has no firmware DSP metadata to report.
     */
    private void processPcmChunk(short[] pcm, int count, int angleDegrees, int ssr, boolean hasFrameMeta) {
        if (suppressionEnabled) {
            applySuppression(pcm, count);
        }
        if (recordingPcm != null) {
            appendRecording(pcm, count);
        }
        if (verifyBuffer != null && verifyCount < VERIFY_MAX_SAMPLES) {
            int copied = Math.min(count, VERIFY_MAX_SAMPLES - verifyCount);
            System.arraycopy(pcm, 0, verifyBuffer, verifyCount, copied);
            verifyCount += copied;
        }
        if (endpointing && endpointDetector.accept(pcm, count)) {
            emitSpeechEnd();
        }
        // PCM and frame metadata flow in every mode so levels, recording,
        // and the Microphones radar keep working alongside onboard ASR.
        emitPcm(pcm, count);
        if (hasFrameMeta) {
            emitFrameMeta(angleDegrees, ssr);
        }
        if (mode != VoiceInputMode.CLOUD) {
            float[] samples = new float[count];
            for (int i = 0; i < count; i++) {
                samples[i] = pcm[i] / 32768.0f;
            }
            processRecognizer(samples);
        }
    }

    // 50 ms chunks match the G2 packet cadence the rest of the pipeline
    // (endpointing, transcript pacing) is tuned for.
    private static final int PHONE_MIC_CHUNK_SAMPLES = SAMPLE_RATE / 20;

    /**
     * Open the phone's own microphone at the pipeline's native format
     * (16 kHz mono PCM16), or null when it cannot start — the permission is
     * missing (SecurityException) or the device refuses the configuration.
     */
    private android.media.AudioRecord openPhoneMic() {
        android.media.AudioRecord record = null;
        try {
            int minBytes = android.media.AudioRecord.getMinBufferSize(
                    SAMPLE_RATE,
                    android.media.AudioFormat.CHANNEL_IN_MONO,
                    android.media.AudioFormat.ENCODING_PCM_16BIT);
            int bufferBytes = Math.max(minBytes, PHONE_MIC_CHUNK_SAMPLES * 2 * 4);
            record = new android.media.AudioRecord(
                    android.media.MediaRecorder.AudioSource.VOICE_RECOGNITION,
                    SAMPLE_RATE,
                    android.media.AudioFormat.CHANNEL_IN_MONO,
                    android.media.AudioFormat.ENCODING_PCM_16BIT,
                    bufferBytes);
            if (record.getState() != android.media.AudioRecord.STATE_INITIALIZED) {
                record.release();
                return null;
            }
            record.startRecording();
            if (record.getRecordingState() != android.media.AudioRecord.RECORDSTATE_RECORDING) {
                record.release();
                return null;
            }
            return record;
        } catch (Throwable t) {
            Log.w(TAG, "phone mic open failed", t);
            if (record != null) {
                record.release();
            }
            return null;
        }
    }

    /**
     * Phone-mic capture loop: no LC3 decode, no arm bookkeeping, no frame
     * metadata — AudioRecord already delivers the pipeline's PCM format. The
     * blocking read returns every chunk (50 ms), which bounds how long a
     * stop() waits for the loop to notice `started` dropped.
     */
    private void processPhoneAudio(android.media.AudioRecord record) {
        short[] pcm = new short[PHONE_MIC_CHUNK_SAMPLES];
        while (started && !Thread.currentThread().isInterrupted()) {
            int read = record.read(pcm, 0, pcm.length);
            if (read < 0) {
                Log.w(TAG, "phone mic read failed: " + read);
                return;
            }
            if (read == 0) {
                continue;
            }
            decodedSamples += read;
            processPcmChunk(pcm, read, 0, 0, false);
        }
    }

    private void processRecognizer(float[] samples) {
        appendTranscriptSamples(samples);
        long now = SystemClock.elapsedRealtime();
        if (transcriptSampleCount >= TRANSCRIPT_MIN_SAMPLES
                && now - lastTranscriptDecodeAtMs >= TRANSCRIPT_DECODE_INTERVAL_MS) {
            decodeTranscript(false);
            lastTranscriptDecodeAtMs = now;
        }
    }

    private void appendTranscriptSamples(float[] samples) {
        int sourceOffset = 0;
        while (sourceOffset < samples.length) {
            int available = TRANSCRIPT_SEGMENT_MAX_SAMPLES - transcriptSampleCount;
            int count = Math.min(available, samples.length - sourceOffset);
            System.arraycopy(samples, sourceOffset, transcriptSamples, transcriptSampleCount, count);
            transcriptSampleCount += count;
            sourceOffset += count;

            if (transcriptSampleCount == TRANSCRIPT_SEGMENT_MAX_SAMPLES) {
                commitTranscriptSegment();
            }
        }
    }

    /**
     * Decode the current model-safe segment and emit the best transcript of the
     * complete utterance (REPLACE semantics — the caller displays it as-is).
     */
    private void decodeTranscript(boolean isFinal) {
        if (recognizer == null || transcriptSampleCount <= 0) {
            if (isFinal) {
                emitTranscript(lastTranscript, true);
            }
            return;
        }
        int segmentSampleCount = transcriptSampleCount;
        String segmentText = recognizeTranscriptSegment(segmentSampleCount);
        if (segmentText.length() > 0) {
            currentSegmentTranscript = segmentText;
        } else {
            segmentText = currentSegmentTranscript;
        }
        String text = joinTranscript(committedTranscript, segmentText);
        lastTranscript = text;
        logTranscriptDecode(isFinal, segmentSampleCount, text);
        emitTranscript(text, isFinal);
    }

    /**
     * Finalize a full segment before accepting more audio. This keeps every
     * Moonshine invocation below its failing sequence length while retaining
     * all earlier text in the replace-semantics preview.
     */
    private void commitTranscriptSegment() {
        int cut = findSegmentCutPoint();
        String segmentText = recognizeTranscriptSegment(cut);
        if (segmentText.length() == 0) {
            // Fallback text came from partial decodes of the full buffer, so it
            // may include words from the carried-over tail; rare now that decode
            // windows are peak-normalized.
            segmentText = currentSegmentTranscript;
        }
        committedTranscript = joinTranscript(committedTranscript, segmentText);
        currentSegmentTranscript = "";
        committedTranscriptSampleCount += cut;
        int tail = transcriptSampleCount - cut;
        System.arraycopy(transcriptSamples, cut, transcriptSamples, 0, tail);
        transcriptSampleCount = tail;
        lastTranscript = committedTranscript;
        lastTranscriptDecodeAtMs = SystemClock.elapsedRealtime();
        logTranscriptDecode(false, cut, committedTranscript);
        emitTranscript(committedTranscript, false);
    }

    /**
     * Pick where to end the committed segment: the center of the quietest
     * window within the search region at the end of the buffer, so the cut
     * lands between words instead of splitting one.
     */
    private int findSegmentCutPoint() {
        int count = transcriptSampleCount;
        int searchStart = Math.max(0, count - TRANSCRIPT_CUT_SEARCH_SAMPLES);
        int win = TRANSCRIPT_CUT_WINDOW_SAMPLES;
        if (count - searchStart <= win) {
            return count;
        }
        double sum = 0;
        for (int i = searchStart; i < searchStart + win; i++) {
            sum += (double) transcriptSamples[i] * transcriptSamples[i];
        }
        double best = sum;
        int bestStart = searchStart;
        for (int start = searchStart + 1; start + win <= count; start++) {
            float dropped = transcriptSamples[start - 1];
            float added = transcriptSamples[start + win - 1];
            sum += (double) added * added - (double) dropped * dropped;
            if (sum < best) {
                best = sum;
                bestStart = start;
            }
        }
        return bestStart + win / 2;
    }

    private String recognizeTranscriptSegment(int sampleCount) {
        OfflineRecognizer currentRecognizer = recognizer;
        if (currentRecognizer == null || sampleCount <= 0) {
            return "";
        }
        float[] segment = Arrays.copyOf(transcriptSamples, sampleCount);
        normalizePeak(segment);
        OfflineStream offlineStream = currentRecognizer.createStream();
        try {
            offlineStream.acceptWaveform(segment, SAMPLE_RATE);
            currentRecognizer.decode(offlineStream);
            OfflineRecognizerResult result = currentRecognizer.getResult(offlineStream);
            String raw = result == null ? "" : result.getText();
            return raw == null ? "" : raw.trim();
        } finally {
            offlineStream.release();
        }
    }

    private static void normalizePeak(float[] samples) {
        float peak = 0f;
        for (float s : samples) {
            float a = Math.abs(s);
            if (a > peak) {
                peak = a;
            }
        }
        if (peak <= 0f) {
            return;
        }
        float gain = Math.min(TRANSCRIPT_NORMALIZE_TARGET_PEAK / peak, TRANSCRIPT_NORMALIZE_MAX_GAIN);
        if (gain <= 1f) {
            return;
        }
        for (int i = 0; i < samples.length; i++) {
            samples[i] *= gain;
        }
    }

    private void logTranscriptDecode(boolean isFinal, int segmentSampleCount, String text) {
        double totalAudioSec =
                (committedTranscriptSampleCount + transcriptSampleCount) / (double) SAMPLE_RATE;
        String preview = text.length() <= TRANSCRIPT_LOG_PREVIEW_CHARS
                ? text : text.substring(0, TRANSCRIPT_LOG_PREVIEW_CHARS) + "...";
        Log.i(TAG, "Moonshine decode final=" + isFinal
                + " audioSec=" + String.format(java.util.Locale.US, "%.2f", totalAudioSec)
                + " segmentAudioSec=" + String.format(java.util.Locale.US, "%.2f", segmentSampleCount / (double) SAMPLE_RATE)
                + " textLen=" + text.length() + " text=\"" + preview + "\"");
    }

    private static String joinTranscript(String prefix, String suffix) {
        if (prefix == null || prefix.length() == 0) {
            return suffix == null ? "" : suffix;
        }
        if (suffix == null || suffix.length() == 0) {
            return prefix;
        }
        char first = suffix.charAt(0);
        boolean attachesToPrevious = ".,!?;:%)]}".indexOf(first) >= 0;
        return prefix + (attachesToPrevious ? "" : " ") + suffix;
    }

    private void resetTranscriptState() {
        transcriptSampleCount = 0;
        committedTranscriptSampleCount = 0;
        committedTranscript = "";
        currentSegmentTranscript = "";
        lastTranscriptDecodeAtMs = 0;
    }

    private void emitPcm(short[] pcm, int count) {
        FaceclawVoiceControllerListener currentListener = listener;
        if (currentListener == null || count <= 0) {
            return;
        }
        byte[] le = new byte[count * 2];
        for (int i = 0; i < count; i++) {
            short s = pcm[i];
            le[i * 2] = (byte) (s & 0xff);
            le[i * 2 + 1] = (byte) ((s >> 8) & 0xff);
        }
        mainHandler.post(() -> currentListener.onPcm(le));
    }

    /**
     * Embed the session's buffered utterance and compare it to the enrolled
     * wearer voice-print. Fails open: a session too short to verify, or a
     * model that will not load, counts as the wearer rather than silencing
     * every command.
     */
    private void runSpeakerVerification() {
        short[] buffer = verifyBuffer;
        float[] wearer = verifyWearerEmbedding;
        String modelPath = verifySpeakerModelPath;
        verifyBuffer = null;
        if (buffer == null || wearer == null || modelPath == null) {
            return;
        }
        if (verifyCount < VERIFY_MIN_SAMPLES) {
            emitSpeakerVerified(true, 0f);
            return;
        }
        FaceclawSpeakerId speakerId = cachedSpeakerId(modelPath);
        try {
            byte[] le = new byte[verifyCount * 2];
            for (int i = 0; i < verifyCount; i++) {
                short s = buffer[i];
                le[i * 2] = (byte) (s & 0xff);
                le[i * 2 + 1] = (byte) ((s >> 8) & 0xff);
            }
            float[] embedding = speakerId.embed(le, SAMPLE_RATE);
            if (embedding == null || embedding.length != wearer.length) {
                emitSpeakerVerified(true, 0f);
                return;
            }
            double dot = 0;
            for (int i = 0; i < embedding.length; i++) {
                dot += (double) embedding[i] * wearer[i];
            }
            boolean isWearer = dot >= verifyThreshold;
            Log.i(TAG, "speaker verification similarity=" + String.format(java.util.Locale.US, "%.3f", dot)
                    + " threshold=" + verifyThreshold + " isWearer=" + isWearer);
            emitSpeakerVerified(isWearer, (float) dot);
        } catch (Throwable t) {
            Log.w(TAG, "speaker verification failed", t);
            emitSpeakerVerified(true, 0f);
        }
    }

    // The 28 MB embedding model takes seconds to load; keep one instance
    // across capture sessions so verification adds only the embed time.
    private static FaceclawSpeakerId sharedSpeakerId;
    private static String sharedSpeakerIdPath;

    private static synchronized FaceclawSpeakerId cachedSpeakerId(String modelPath) {
        if (sharedSpeakerId == null || !modelPath.equals(sharedSpeakerIdPath)) {
            if (sharedSpeakerId != null) {
                sharedSpeakerId.close();
            }
            sharedSpeakerId = new FaceclawSpeakerId(modelPath);
            sharedSpeakerIdPath = modelPath;
        }
        return sharedSpeakerId;
    }

    private void emitSpeakerVerified(boolean isWearer, float similarity) {
        FaceclawVoiceControllerListener currentListener = listener;
        if (currentListener == null) {
            return;
        }
        mainHandler.post(() -> currentListener.onSpeakerVerified(isWearer, similarity));
    }

    private void emitFrameMeta(int angleDegrees, int ssr) {
        FaceclawVoiceControllerListener currentListener = listener;
        if (currentListener == null) {
            return;
        }
        mainHandler.post(() -> currentListener.onFrameMeta(angleDegrees, ssr));
    }

    private void emitSpeechEnd() {
        FaceclawVoiceControllerListener currentListener = listener;
        if (currentListener == null) {
            return;
        }
        mainHandler.post(currentListener::onSpeechEnd);
    }

    /**
     * Decides when a hands-free utterance is over, so "Hey Even" capture can
     * stop without a button release.
     *
     * Runs on the decoded 16 kHz PCM, so it works the same in every input mode
     * (the cloud path never sees the samples on this side, and the onboard
     * recognizer's own endpointing only covers ONBOARD).
     *
     * Timing is measured on the sample clock rather than the wall clock: BLE
     * delivers mic packets in bursts, so elapsed real time badly overestimates
     * how much audio has actually been heard.
     *
     * The threshold is relative to a noise floor measured over the first
     * {@link #CALIBRATE_MS} of the session, which is roughly the interval where
     * the user is reacting to the dialog appearing and not yet speaking.
     */
    private static final class EndpointDetector {
        /** Audio used to estimate the room's noise floor. */
        private static final int CALIBRATE_MS = 300;
        /** Speech must exceed this multiple of the noise floor to count as onset. */
        private static final double ONSET_FACTOR = 3.0;
        /** Below this multiple of the noise floor counts as silence again. */
        private static final double RELEASE_FACTOR = 1.8;
        /** Absolute floor, so a silent room can't make the threshold ~0. */
        private static final double MIN_RMS = 220.0;
        /** Trailing silence that ends an utterance. */
        private static final int SILENCE_MS = 900;
        /** If the user never speaks, give up rather than record forever. */
        private static final int LEAD_IN_MS = 6000;
        /** Hard cap on a single utterance. */
        private static final int MAX_UTTERANCE_MS = 30000;

        private long totalSamples;
        private double noiseAccum;
        private int noisePackets;
        private double threshold;
        private boolean speechStarted;
        private long silenceSamples;
        private boolean fired;

        void reset() {
            totalSamples = 0;
            noiseAccum = 0;
            noisePackets = 0;
            threshold = 0;
            speechStarted = false;
            silenceSamples = 0;
            fired = false;
        }

        /** Returns true exactly once, on the packet that ends the utterance. */
        boolean accept(short[] pcm, int count) {
            if (fired || count <= 0) {
                return false;
            }
            totalSamples += count;
            long elapsedMs = totalSamples * 1000L / SAMPLE_RATE;

            double sumSquares = 0;
            for (int i = 0; i < count; i++) {
                double s = pcm[i];
                sumSquares += s * s;
            }
            double rms = Math.sqrt(sumSquares / count);

            if (elapsedMs <= CALIBRATE_MS) {
                noiseAccum += rms;
                noisePackets++;
                return false;
            }
            if (threshold == 0) {
                double noiseFloor = noisePackets > 0 ? noiseAccum / noisePackets : 0;
                threshold = Math.max(noiseFloor, MIN_RMS);
            }

            if (!speechStarted) {
                if (rms >= threshold * ONSET_FACTOR) {
                    speechStarted = true;
                    silenceSamples = 0;
                } else if (elapsedMs >= LEAD_IN_MS) {
                    // Never heard anything; close the dialog rather than hang.
                    fired = true;
                    return true;
                }
                return false;
            }

            if (rms < threshold * RELEASE_FACTOR) {
                silenceSamples += count;
                if (silenceSamples * 1000L / SAMPLE_RATE >= SILENCE_MS) {
                    fired = true;
                    return true;
                }
            } else {
                silenceSamples = 0;
            }

            if (elapsedMs >= MAX_UTTERANCE_MS) {
                fired = true;
                return true;
            }
            return false;
        }
    }

    private void stopG2Audio() {
        FaceclawBleCommunicator currentCommunicator = communicator;
        if (currentCommunicator != null) {
            currentCommunicator.stopG2AudioCapture();
        }
        maybeEmitAudioStats(true);
    }

    private void releaseSherpa() {
        if (recognizer != null) {
            recognizer.release();
            recognizer = null;
        }
    }

    private void releaseLc3() {
        if (lc3Decoder != null) {
            lc3Decoder.close();
            lc3Decoder = null;
        }
    }

    private void queueAudioPacket(byte[] data, String arm, long arrivalMs) {
        if (!started || data == null) {
            return;
        }
        if (!"L".equals(arm)) {
            wrongArmPackets++;
        }
        synchronized (audioQueueLock) {
            if (audioQueue.size() >= MAX_AUDIO_QUEUE_PACKETS) {
                audioQueue.removeFirst();
                queueDroppedPackets++;
            }
            audioQueue.addLast(new AudioPacket(data, arm, arrivalMs));
            queuedPackets++;
            if (lastPacketArrivalMs > 0) {
                long delta = arrivalMs - lastPacketArrivalMs;
                if (delta > maxInterPacketMs) {
                    maxInterPacketMs = delta;
                }
                if (delta > LATE_PACKET_INTERVAL_MS) {
                    latePackets++;
                }
            }
            lastPacketArrivalMs = arrivalMs;
            audioQueueLock.notifyAll();
        }
    }

    private AudioPacket takeAudioPacket() {
        synchronized (audioQueueLock) {
            while (started && audioQueue.isEmpty()) {
                try {
                    audioQueueLock.wait(250);
                    maybeEmitAudioStats(false);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    return null;
                }
            }
            return audioQueue.pollFirst();
        }
    }

    private void resetAudioStats() {
        queuedPackets = 0;
        queueDroppedPackets = 0;
        decodedSamples = 0;
        latePackets = 0;
        wrongArmPackets = 0;
        lastPacketArrivalMs = 0;
        maxInterPacketMs = 0;
        lastStatsAtMs = SystemClock.elapsedRealtime();
    }

    private void maybeEmitAudioStats(boolean force) {
        long now = SystemClock.elapsedRealtime();
        if (!force && now - lastStatsAtMs < STATS_INTERVAL_MS) {
            return;
        }
        lastStatsAtMs = now;
        FaceclawLc3Decoder currentDecoder = lc3Decoder;
        long real = currentDecoder == null ? 0 : currentDecoder.getRealPackets();
        long duplicate = currentDecoder == null ? 0 : currentDecoder.getDuplicatePackets();
        long missing = currentDecoder == null ? 0 : currentDecoder.getMissingPackets();
        long decodeErrors = currentDecoder == null ? 0 : currentDecoder.getDecodeErrors();
        String status = "G2 mic packets=" + queuedPackets
                + " decoded=" + real
                + " missing=" + missing
                + " duplicate=" + duplicate
                + " late=" + latePackets
                + " maxGapMs=" + maxInterPacketMs
                + "\n"
                + " queueDrop=" + queueDroppedPackets
                + " decodeErrors=" + decodeErrors
                + " wrongArm=" + wrongArmPackets
                + " audioSec=" + String.format(java.util.Locale.US, "%.1f", decodedSamples / (double) SAMPLE_RATE);
        // Audio-pipeline stats are diagnostic; keep them in logcat only, out of
        // the on-glasses voice UI.
        Log.i(TAG, status.replace('\n', ' ') + " expectedIntervalMs=" + EXPECTED_PACKET_INTERVAL_MS);
    }

    private void emitStatus(String status) {
        FaceclawVoiceControllerListener currentListener = listener;
        if (currentListener == null) {
            return;
        }
        mainHandler.post(() -> currentListener.onStatus(status));
    }

    private void emitTranscript(String text, boolean isFinal) {
        FaceclawVoiceControllerListener currentListener = listener;
        if (currentListener == null) {
            return;
        }
        Log.i(TAG, "Emit transcript final=" + isFinal + " textLen=" + (text == null ? 0 : text.trim().length()));
        mainHandler.post(() -> currentListener.onTranscript(text, isFinal));
    }

    private static final class AudioPacket {
        final byte[] data;
        final String arm;
        final long arrivalMs;

        AudioPacket(byte[] data, String arm, long arrivalMs) {
            this.data = data;
            this.arm = arm == null ? "?" : arm;
            this.arrivalMs = arrivalMs;
        }
    }
}
