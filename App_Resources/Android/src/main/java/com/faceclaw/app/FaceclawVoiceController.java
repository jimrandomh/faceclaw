package com.faceclaw.app;

import android.content.Context;
import android.content.res.AssetManager;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;

import com.k2fsa.sherpa.onnx.FeatureConfig;
import com.k2fsa.sherpa.onnx.KeywordSpotter;
import com.k2fsa.sherpa.onnx.KeywordSpotterConfig;
import com.k2fsa.sherpa.onnx.KeywordSpotterResult;
import com.k2fsa.sherpa.onnx.OfflineModelConfig;
import com.k2fsa.sherpa.onnx.OfflineMoonshineModelConfig;
import com.k2fsa.sherpa.onnx.OfflineRecognizer;
import com.k2fsa.sherpa.onnx.OfflineRecognizerConfig;
import com.k2fsa.sherpa.onnx.OfflineRecognizerResult;
import com.k2fsa.sherpa.onnx.OfflineStream;
import com.k2fsa.sherpa.onnx.OnlineModelConfig;
import com.k2fsa.sherpa.onnx.OnlineStream;
import com.k2fsa.sherpa.onnx.OnlineTransducerModelConfig;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
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
    private static final int TRANSCRIPT_DECODE_INTERVAL_MS = 900;
    private static final int TRANSCRIPT_MIN_SAMPLES = SAMPLE_RATE / 2;
    private static final int TRANSCRIPT_MAX_SAMPLES = SAMPLE_RATE * 8;
    private static final int TRANSCRIPT_SILENCE_ENDPOINT_SAMPLES = (int) (SAMPLE_RATE * 1.2);
    private static final float TRANSCRIPT_SILENCE_PEAK = 0.015f;
    private static final int TRANSCRIPT_LOG_PREVIEW_CHARS = 80;
    private static final String ASSET_ROOT = "faceclaw-voice";
    private static final String MODEL_DIR = "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01";
    private static final String ASR_ASSET_ROOT = "faceclaw-voice-asr";
    private static final String ASR_MODEL_DIR = "sherpa-onnx-moonshine-base-en-quantized-2026-02-27";
    private static final String[] MODEL_FILES = {
            "encoder-epoch-12-avg-2-chunk-16-left-64.onnx",
            "decoder-epoch-12-avg-2-chunk-16-left-64.onnx",
            "joiner-epoch-12-avg-2-chunk-16-left-64.onnx",
            "tokens.txt",
            "screen-on-keywords.txt"
    };
    private static final String[] ASR_MODEL_FILES = {
            "encoder_model.ort",
            "decoder_model_merged.ort",
            "tokens.txt"
    };

    private enum VoiceInputMode {
        WAKEWORD,
        FULL
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
    private VoiceInputMode mode = VoiceInputMode.WAKEWORD;
    private KeywordSpotter keywordSpotter;
    private OfflineRecognizer recognizer;
    private OnlineStream stream;
    private FaceclawLc3Decoder lc3Decoder;
    private float[] transcriptSamples = new float[TRANSCRIPT_MAX_SAMPLES];
    private int transcriptSampleCount;
    private int transcriptSilentSamples;
    private boolean transcriptHadSpeech;
    private long lastTranscriptDecodeAtMs;
    private String lastTranscript = "";
    private float lastTranscriptPeak;
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

    public void start() {
        start("wakeword");
    }

    public void start(String requestedMode) {
        synchronized (lock) {
            if (started) {
                emitStatus("Voice control is already listening.");
                return;
            }
            if (communicator == null || !communicator.isSessionReady()) {
                emitStatus("Voice control needs an active G2 connection.");
                return;
            }
            mode = parseMode(requestedMode);
            started = true;
            workerThread = new Thread(this::runLoop, "FaceclawVoiceController");
            workerThread.start();
        }
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
        return "full".equals(requestedMode) ? VoiceInputMode.FULL : VoiceInputMode.WAKEWORD;
    }

    private void runLoop() {
        try {
            VoiceInputMode currentMode = mode;
            emitStatus(currentMode == VoiceInputMode.FULL
                    ? "Voice control loading transcription model..."
                    : "Voice control loading wake-word model...");
            if (currentMode == VoiceInputMode.FULL) {
                File modelDir = installAsrModelFiles();
                recognizer = new OfflineRecognizer(buildRecognizerConfig(modelDir));
                resetTranscriptState();
                lastTranscript = "";
            } else {
                File modelDir = installModelFiles();
                keywordSpotter = new KeywordSpotter(buildConfig(modelDir));
                stream = keywordSpotter.createStream();
            }
            lc3Decoder = new FaceclawLc3Decoder();
            if (!startG2Audio()) {
                emitStatus("Voice control could not start G2 microphone input.");
                return;
            }

            emitStatus(currentMode == VoiceInputMode.FULL
                    ? "Voice control transcribing from the G2 mic."
                    : "Voice control listening for \"screen on\" from the G2 mic.");
            processG2Audio();
        } catch (Throwable error) {
            Log.e(TAG, "Voice control failed", error);
            emitStatus("Voice control failed: " + error.getMessage());
        } finally {
            stopG2Audio();
            releaseSherpa();
            releaseLc3();
            synchronized (lock) {
                started = false;
                workerThread = null;
            }
        }
    }

    private KeywordSpotterConfig buildConfig(File modelDir) {
        return KeywordSpotterConfig.builder()
                .setFeatureConfig(FeatureConfig.builder()
                        .setSampleRate(SAMPLE_RATE)
                        .setFeatureDim(FEATURE_DIM)
                        .build())
                .setOnlineModelConfig(OnlineModelConfig.builder()
                        .setTransducer(OnlineTransducerModelConfig.builder()
                                .setEncoder(new File(modelDir, "encoder-epoch-12-avg-2-chunk-16-left-64.onnx").getAbsolutePath())
                                .setDecoder(new File(modelDir, "decoder-epoch-12-avg-2-chunk-16-left-64.onnx").getAbsolutePath())
                                .setJoiner(new File(modelDir, "joiner-epoch-12-avg-2-chunk-16-left-64.onnx").getAbsolutePath())
                                .build())
                        .setTokens(new File(modelDir, "tokens.txt").getAbsolutePath())
                        .setModelType("zipformer2")
                        .setModelingUnit("")
                        .setNumThreads(1)
                        .build())
                .setKeywordsFile(new File(modelDir, "screen-on-keywords.txt").getAbsolutePath())
                .setKeywordsScore(1.5f)
                .setKeywordsThreshold(0.35f)
                .build();
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

    private File installModelFiles() throws IOException {
        File modelDir = new File(appContext.getFilesDir(), ASSET_ROOT + File.separator + MODEL_DIR);
        if (!modelDir.exists() && !modelDir.mkdirs()) {
            throw new IOException("Could not create " + modelDir.getAbsolutePath());
        }
        AssetManager assets = appContext.getAssets();
        for (String fileName : MODEL_FILES) {
            copyAssetIfNeeded(
                    assets,
                    ASSET_ROOT + "/" + MODEL_DIR + "/" + fileName,
                    new File(modelDir, fileName)
            );
        }
        return modelDir;
    }

    private File installAsrModelFiles() throws IOException {
        File modelDir = new File(appContext.getFilesDir(), ASR_ASSET_ROOT + File.separator + ASR_MODEL_DIR);
        if (!modelDir.exists() && !modelDir.mkdirs()) {
            throw new IOException("Could not create " + modelDir.getAbsolutePath());
        }
        AssetManager assets = appContext.getAssets();
        for (String fileName : ASR_MODEL_FILES) {
            copyAssetIfNeeded(
                    assets,
                    ASR_ASSET_ROOT + "/" + ASR_MODEL_DIR + "/" + fileName,
                    new File(modelDir, fileName)
            );
        }
        return modelDir;
    }

    private void copyAssetIfNeeded(AssetManager assets, String assetPath, File destination) throws IOException {
        if (destination.exists() && destination.length() > 0) {
            return;
        }
        try (InputStream input = assets.open(assetPath);
             FileOutputStream output = new FileOutputStream(destination)) {
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = input.read(buffer)) >= 0) {
                output.write(buffer, 0, read);
            }
        }
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
            OnlineStream currentStream = stream;
            FaceclawLc3Decoder currentDecoder = lc3Decoder;
            if (currentDecoder == null || (mode == VoiceInputMode.WAKEWORD && currentStream == null)) {
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
            float[] samples = new float[count];
            for (int i = 0; i < count; i++) {
                samples[i] = pcm[i] / 32768.0f;
            }
            if (mode == VoiceInputMode.FULL) {
                processRecognizer(samples);
            } else {
                currentStream.acceptWaveform(samples, SAMPLE_RATE);
                processKeywordSpotter(currentStream);
            }
            maybeEmitAudioStats(false);
        }
    }

    private void processKeywordSpotter(OnlineStream currentStream) {
        KeywordSpotter currentSpotter = keywordSpotter;
        if (currentSpotter == null) {
            return;
        }
        while (currentSpotter.isReady(currentStream)) {
            currentSpotter.decode(currentStream);
            KeywordSpotterResult result = currentSpotter.getResult(currentStream);
            String keyword = result == null ? "" : result.getKeyword();
            if (keyword != null && keyword.trim().length() > 0) {
                currentSpotter.reset(currentStream);
                emitWakeWord(keyword);
            }
        }
    }

    private void processRecognizer(float[] samples) {
        appendTranscriptSamples(samples);
        updateTranscriptSilence(samples);

        if (transcriptSampleCount >= TRANSCRIPT_MAX_SAMPLES) {
            decodeTranscriptSegment(true);
            resetTranscriptState();
            lastTranscript = "";
            return;
        }

        long now = SystemClock.elapsedRealtime();
        if (transcriptSampleCount >= TRANSCRIPT_MIN_SAMPLES && now - lastTranscriptDecodeAtMs >= TRANSCRIPT_DECODE_INTERVAL_MS) {
            decodeTranscriptSegment(false);
            lastTranscriptDecodeAtMs = now;
        }

        if (transcriptHadSpeech && transcriptSilentSamples >= TRANSCRIPT_SILENCE_ENDPOINT_SAMPLES) {
            decodeTranscriptSegment(true);
            resetTranscriptState();
            lastTranscript = "";
        }
    }

    private void appendTranscriptSamples(float[] samples) {
        int available = TRANSCRIPT_MAX_SAMPLES - transcriptSampleCount;
        if (samples.length > available) {
            int drop = samples.length - available;
            if (drop >= transcriptSampleCount) {
                transcriptSampleCount = 0;
            } else {
                System.arraycopy(transcriptSamples, drop, transcriptSamples, 0, transcriptSampleCount - drop);
                transcriptSampleCount -= drop;
            }
        }
        System.arraycopy(samples, 0, transcriptSamples, transcriptSampleCount, samples.length);
        transcriptSampleCount += samples.length;
    }

    private void updateTranscriptSilence(float[] samples) {
        float peak = 0.0f;
        for (float sample : samples) {
            float abs = Math.abs(sample);
            if (abs > peak) {
                peak = abs;
            }
        }
        if (peak > lastTranscriptPeak) {
            lastTranscriptPeak = peak;
        }
        if (peak < TRANSCRIPT_SILENCE_PEAK) {
            transcriptSilentSamples += samples.length;
        } else {
            transcriptSilentSamples = 0;
            transcriptHadSpeech = true;
        }
    }

    private void decodeTranscriptSegment(boolean isFinal) {
        OfflineRecognizer currentRecognizer = recognizer;
        if (currentRecognizer == null || transcriptSampleCount <= 0) {
            return;
        }
        OfflineStream offlineStream = currentRecognizer.createStream();
        try {
            offlineStream.acceptWaveform(Arrays.copyOf(transcriptSamples, transcriptSampleCount), SAMPLE_RATE);
            currentRecognizer.decode(offlineStream);
            emitRecognizerResult(currentRecognizer.getResult(offlineStream), isFinal, transcriptSampleCount, lastTranscriptPeak);
        } finally {
            offlineStream.release();
        }
    }

    private void emitRecognizerResult(OfflineRecognizerResult result, boolean isFinal, int sampleCount, float peak) {
        String text = result == null ? "" : result.getText();
        if (text == null) {
            text = "";
        }
        String trimmed = text.trim();
        String preview = trimmed.length() <= TRANSCRIPT_LOG_PREVIEW_CHARS
                ? trimmed
                : trimmed.substring(0, TRANSCRIPT_LOG_PREVIEW_CHARS) + "...";
        Log.i(TAG, "Moonshine decode final=" + isFinal
                + " audioSec=" + String.format(java.util.Locale.US, "%.2f", sampleCount / (double) SAMPLE_RATE)
                + " peak=" + String.format(java.util.Locale.US, "%.4f", peak)
                + " textLen=" + trimmed.length()
                + " text=\"" + preview + "\"");
        emitStatus("Moonshine decode "
                + String.format(java.util.Locale.US, "%.1fs", sampleCount / (double) SAMPLE_RATE)
                + ", textLen=" + trimmed.length());
        if (text.equals(lastTranscript)) {
            if (isFinal && lastTranscript.length() > 0) {
                emitTranscript("", true);
                lastTranscript = "";
            }
            return;
        }
        String delta = text;
        if (lastTranscript.length() > 0 && text.startsWith(lastTranscript)) {
            delta = text.substring(lastTranscript.length());
        }
        if (delta.trim().length() > 0) {
            emitTranscript(delta, false);
        }
        lastTranscript = isFinal ? "" : text;
        if (isFinal) {
            emitTranscript("", true);
        }
    }

    private void resetTranscriptState() {
        transcriptSampleCount = 0;
        transcriptSilentSamples = 0;
        transcriptHadSpeech = false;
        lastTranscriptDecodeAtMs = 0;
        lastTranscriptPeak = 0.0f;
    }

    private void stopG2Audio() {
        FaceclawBleCommunicator currentCommunicator = communicator;
        if (currentCommunicator != null) {
            currentCommunicator.stopG2AudioCapture();
        }
        maybeEmitAudioStats(true);
    }

    private void releaseSherpa() {
        if (stream != null) {
            stream.release();
            stream = null;
        }
        if (keywordSpotter != null) {
            keywordSpotter.release();
            keywordSpotter = null;
        }
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
        Log.i(TAG, status + " expectedIntervalMs=" + EXPECTED_PACKET_INTERVAL_MS);
        emitStatus(status);
    }

    private void emitStatus(String status) {
        FaceclawVoiceControllerListener currentListener = listener;
        if (currentListener == null) {
            return;
        }
        mainHandler.post(() -> currentListener.onStatus(status));
    }

    private void emitWakeWord(String keyword) {
        FaceclawVoiceControllerListener currentListener = listener;
        if (currentListener == null) {
            return;
        }
        mainHandler.post(() -> currentListener.onWakeWord(keyword));
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
