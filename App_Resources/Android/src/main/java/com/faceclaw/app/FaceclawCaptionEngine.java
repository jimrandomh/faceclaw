package com.faceclaw.app;

import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import com.k2fsa.sherpa.onnx.FeatureConfig;
import com.k2fsa.sherpa.onnx.OfflineModelConfig;
import com.k2fsa.sherpa.onnx.OfflineMoonshineModelConfig;
import com.k2fsa.sherpa.onnx.OfflineRecognizer;
import com.k2fsa.sherpa.onnx.OfflineRecognizerConfig;
import com.k2fsa.sherpa.onnx.OfflineRecognizerResult;
import com.k2fsa.sherpa.onnx.OfflineStream;

import java.io.File;
import java.util.ArrayDeque;
import java.util.Arrays;

/**
 * Continuous captioning over the decoded mic PCM: segments speech into
 * utterances with an adaptive energy gate, transcribes each utterance with
 * the on-device Moonshine model, and attaches a speaker voice-print per
 * utterance. PCM is pushed in from the TS side (which owns mic arbitration
 * and any beam-direction gating), so this engine has no BLE dependencies.
 *
 * Utterance boundaries are measured on the sample clock, not the wall clock:
 * BLE delivers mic packets in bursts, so elapsed real time overestimates the
 * audio heard. The TS side converts startMs/endMs to wall-clock times using
 * the engine start timestamp.
 */
public class FaceclawCaptionEngine {
    private static final String TAG = "FaceclawCaptions";
    private static final int SAMPLE_RATE = 16000;
    private static final int FEATURE_DIM = 80;
    private static final int MAX_QUEUE_PACKETS = 200;

    // Segmentation: RMS thresholds relative to a rolling noise floor, in the
    // same spirit as FaceclawVoiceController.EndpointDetector but recurring.
    private static final double ONSET_FACTOR = 3.0;
    private static final double RELEASE_FACTOR = 1.8;
    private static final double MIN_RMS = 220.0;
    private static final double NOISE_EMA_ALPHA = 0.05;
    private static final int PRE_ROLL_MS = 400;
    private static final int DEFAULT_SILENCE_MS = 800;
    private static final int MIN_UTTERANCE_MS = 350;
    private static final int MAX_UTTERANCE_MS = 15000;
    // Moonshine v2 fails past ~9.1 s of input; decode long utterances in
    // segments cut at the quietest window (mirrors FaceclawVoiceController).
    private static final int DECODE_SEGMENT_MAX_SAMPLES = SAMPLE_RATE * 8;
    private static final int CUT_SEARCH_SAMPLES = SAMPLE_RATE * 2;
    private static final int CUT_WINDOW_SAMPLES = SAMPLE_RATE * 30 / 1000;
    private static final float NORMALIZE_TARGET_PEAK = 0.9f;
    private static final float NORMALIZE_MAX_GAIN = 30f;
    // Voice-prints degrade on very long inputs; embed at most the first 10 s.
    private static final int EMBED_MAX_SAMPLES = SAMPLE_RATE * 10;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final Object lock = new Object();
    private final Object queueLock = new Object();
    private final ArrayDeque<byte[]> queue = new ArrayDeque<>();

    private volatile FaceclawCaptionEngineListener listener;
    private volatile String asrModelDir;
    private volatile String speakerModelPath;
    private volatile int silenceMs = DEFAULT_SILENCE_MS;
    private Thread workerThread;
    private volatile boolean started;

    private OfflineRecognizer recognizer;
    private FaceclawSpeakerId speakerId;

    // Segmentation state (worker thread only).
    private long totalSamples;
    private double noiseFloor;
    private boolean inUtterance;
    private long utteranceStartSample;
    private long silenceRunSamples;
    private double utterancePeakRms;
    private short[] utterance = new short[SAMPLE_RATE * (MAX_UTTERANCE_MS / 1000)];
    private int utteranceLength;
    private final short[] preRoll = new short[SAMPLE_RATE * PRE_ROLL_MS / 1000];
    private int preRollLength;

    public void setListener(FaceclawCaptionEngineListener listener) {
        this.listener = listener;
    }

    /** Directory holding the Moonshine model files, or null to disable ASR. */
    public void setAsrModelDir(String dir) {
        this.asrModelDir = dir;
    }

    /** Speaker-embedding ONNX model path, or null to disable voice-prints. */
    public void setSpeakerModelPath(String path) {
        this.speakerModelPath = path;
    }

    public void setSilenceMs(int ms) {
        this.silenceMs = Math.max(200, Math.min(3000, ms));
    }

    public void start() {
        synchronized (lock) {
            if (started) {
                return;
            }
            started = true;
            workerThread = new Thread(this::runLoop, "FaceclawCaptionEngine");
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
            workerThread = null;
        }
        synchronized (queueLock) {
            queueLock.notifyAll();
        }
        if (threadToJoin != null) {
            threadToJoin.interrupt();
            if (Thread.currentThread() != threadToJoin) {
                try {
                    threadToJoin.join(2000);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            }
        }
    }

    /** Push decoded 16 kHz mono S16LE PCM (any chunking). */
    public void acceptPcm(byte[] pcm16le) {
        if (!started || pcm16le == null || pcm16le.length < 2) {
            return;
        }
        synchronized (queueLock) {
            if (queue.size() >= MAX_QUEUE_PACKETS) {
                queue.removeFirst();
            }
            queue.addLast(pcm16le);
            queueLock.notifyAll();
        }
    }

    private void runLoop() {
        try {
            loadModels();
            resetSegmentation();
            while (started && !Thread.currentThread().isInterrupted()) {
                byte[] chunk = takeChunk();
                if (chunk == null) {
                    continue;
                }
                processChunk(chunk);
            }
            // Flush a trailing utterance so its text isn't lost on stop.
            if (inUtterance && utteranceLength > 0) {
                finalizeUtterance();
            }
        } catch (Throwable t) {
            Log.e(TAG, "caption engine failed", t);
            emitStatus("Captions failed: " + t.getMessage());
        } finally {
            releaseModels();
        }
    }

    private void loadModels() {
        String modelDir = asrModelDir;
        if (modelDir != null && new File(modelDir, "tokens.txt").exists()) {
            emitStatus("Loading caption model...");
            recognizer = new OfflineRecognizer(OfflineRecognizerConfig.builder()
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
                    .build());
        } else {
            recognizer = null;
        }
        String embedModel = speakerModelPath;
        if (embedModel != null && new File(embedModel).exists()) {
            speakerId = new FaceclawSpeakerId(embedModel);
            speakerId.ensureLoaded();
        } else {
            speakerId = null;
        }
        emitStatus(recognizer != null ? "Captions listening..." : "Captions listening (no ASR model)...");
    }

    private void releaseModels() {
        if (recognizer != null) {
            recognizer.release();
            recognizer = null;
        }
        if (speakerId != null) {
            speakerId.close();
            speakerId = null;
        }
    }

    private byte[] takeChunk() {
        synchronized (queueLock) {
            while (started && queue.isEmpty()) {
                try {
                    queueLock.wait(250);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    return null;
                }
            }
            return queue.pollFirst();
        }
    }

    private void resetSegmentation() {
        totalSamples = 0;
        noiseFloor = 0;
        inUtterance = false;
        utteranceLength = 0;
        preRollLength = 0;
        silenceRunSamples = 0;
        utterancePeakRms = 0;
    }

    private void processChunk(byte[] chunk) {
        int count = chunk.length / 2;
        short[] pcm = new short[count];
        double sumSquares = 0;
        for (int i = 0; i < count; i++) {
            short s = (short) ((chunk[i * 2] & 0xff) | (chunk[i * 2 + 1] << 8));
            pcm[i] = s;
            sumSquares += (double) s * s;
        }
        double rms = Math.sqrt(sumSquares / Math.max(1, count));
        totalSamples += count;

        if (!inUtterance) {
            // Track the noise floor only while idle so speech doesn't raise it.
            noiseFloor = noiseFloor == 0 ? rms : noiseFloor * (1 - NOISE_EMA_ALPHA) + rms * NOISE_EMA_ALPHA;
            double threshold = Math.max(noiseFloor, MIN_RMS);
            if (rms >= threshold * ONSET_FACTOR) {
                inUtterance = true;
                utteranceLength = 0;
                silenceRunSamples = 0;
                utterancePeakRms = rms;
                appendUtterance(preRoll, preRollLength);
                utteranceStartSample = Math.max(0, totalSamples - count - preRollLength);
                appendUtterance(pcm, count);
                emitSpeechStart(utteranceStartSample * 1000 / SAMPLE_RATE);
            } else {
                appendPreRoll(pcm, count);
            }
            return;
        }

        appendUtterance(pcm, count);
        utterancePeakRms = Math.max(utterancePeakRms, rms);
        double threshold = Math.max(noiseFloor, MIN_RMS);
        if (rms < threshold * RELEASE_FACTOR) {
            silenceRunSamples += count;
        } else {
            silenceRunSamples = 0;
        }
        long utteranceMs = (long) utteranceLength * 1000 / SAMPLE_RATE;
        boolean silenceEnded = silenceRunSamples * 1000L / SAMPLE_RATE >= silenceMs;
        if (silenceEnded || utteranceMs >= MAX_UTTERANCE_MS) {
            finalizeUtterance();
            inUtterance = false;
            preRollLength = 0;
        }
    }

    private void appendPreRoll(short[] pcm, int count) {
        // Keep the last PRE_ROLL_MS of idle audio so onset consonants survive.
        if (count >= preRoll.length) {
            System.arraycopy(pcm, count - preRoll.length, preRoll, 0, preRoll.length);
            preRollLength = preRoll.length;
            return;
        }
        int keep = Math.min(preRollLength, preRoll.length - count);
        System.arraycopy(preRoll, preRollLength - keep, preRoll, 0, keep);
        System.arraycopy(pcm, 0, preRoll, keep, count);
        preRollLength = keep + count;
    }

    private void appendUtterance(short[] pcm, int count) {
        int room = utterance.length - utteranceLength;
        int copied = Math.min(room, count);
        if (copied > 0) {
            System.arraycopy(pcm, 0, utterance, utteranceLength, copied);
            utteranceLength += copied;
        }
    }

    private void finalizeUtterance() {
        int length = utteranceLength;
        long startMs = utteranceStartSample * 1000 / SAMPLE_RATE;
        long endMs = (utteranceStartSample + length) * 1000 / SAMPLE_RATE;
        if (endMs - startMs < MIN_UTTERANCE_MS) {
            return;
        }
        String text = recognizeUtterance(length);
        float[] embedding = embedUtterance(length);
        emitUtterance(text, embedding, startMs, endMs, utterancePeakRms);
    }

    private String recognizeUtterance(int length) {
        if (recognizer == null || length <= 0) {
            return "";
        }
        StringBuilder joined = new StringBuilder();
        int offset = 0;
        while (offset < length) {
            int remaining = length - offset;
            int segment = Math.min(remaining, DECODE_SEGMENT_MAX_SAMPLES);
            if (remaining > DECODE_SEGMENT_MAX_SAMPLES) {
                segment = findQuietCut(offset, segment);
            }
            String part = recognizeRange(offset, segment);
            if (part.length() > 0) {
                if (joined.length() > 0 && ".,!?;:%)]}".indexOf(part.charAt(0)) < 0) {
                    joined.append(' ');
                }
                joined.append(part);
            }
            offset += segment;
        }
        return joined.toString().trim();
    }

    /**
     * End a decode segment at the center of the quietest window near its end
     * so the cut lands between words (same approach as the PTT controller).
     */
    private int findQuietCut(int offset, int segment) {
        int searchStart = Math.max(0, segment - CUT_SEARCH_SAMPLES);
        int win = CUT_WINDOW_SAMPLES;
        if (segment - searchStart <= win) {
            return segment;
        }
        double sum = 0;
        for (int i = searchStart; i < searchStart + win; i++) {
            double s = utterance[offset + i];
            sum += s * s;
        }
        double best = sum;
        int bestStart = searchStart;
        for (int start = searchStart + 1; start + win <= segment; start++) {
            double dropped = utterance[offset + start - 1];
            double added = utterance[offset + start + win - 1];
            sum += added * added - dropped * dropped;
            if (sum < best) {
                best = sum;
                bestStart = start;
            }
        }
        return bestStart + win / 2;
    }

    private String recognizeRange(int offset, int count) {
        float[] samples = new float[count];
        float peak = 0f;
        for (int i = 0; i < count; i++) {
            float v = utterance[offset + i] / 32768.0f;
            samples[i] = v;
            float a = Math.abs(v);
            if (a > peak) {
                peak = a;
            }
        }
        if (peak > 0f) {
            float gain = Math.min(NORMALIZE_TARGET_PEAK / peak, NORMALIZE_MAX_GAIN);
            if (gain > 1f) {
                for (int i = 0; i < count; i++) {
                    samples[i] *= gain;
                }
            }
        }
        OfflineStream stream = recognizer.createStream();
        try {
            stream.acceptWaveform(samples, SAMPLE_RATE);
            recognizer.decode(stream);
            OfflineRecognizerResult result = recognizer.getResult(stream);
            String raw = result == null ? "" : result.getText();
            return raw == null ? "" : raw.trim();
        } finally {
            stream.release();
        }
    }

    private float[] embedUtterance(int length) {
        FaceclawSpeakerId currentSpeakerId = speakerId;
        if (currentSpeakerId == null || length <= 0) {
            return null;
        }
        int count = Math.min(length, EMBED_MAX_SAMPLES);
        byte[] le = new byte[count * 2];
        for (int i = 0; i < count; i++) {
            short s = utterance[i];
            le[i * 2] = (byte) (s & 0xff);
            le[i * 2 + 1] = (byte) ((s >> 8) & 0xff);
        }
        return currentSpeakerId.embed(le, SAMPLE_RATE);
    }

    private void emitUtterance(String text, float[] embedding, long startMs, long endMs, double peakRms) {
        FaceclawCaptionEngineListener currentListener = listener;
        if (currentListener == null) {
            return;
        }
        float[] embeddingCopy = embedding == null ? null : Arrays.copyOf(embedding, embedding.length);
        mainHandler.post(() -> currentListener.onUtterance(text, embeddingCopy, startMs, endMs, peakRms));
    }

    private void emitSpeechStart(long startMs) {
        FaceclawCaptionEngineListener currentListener = listener;
        if (currentListener == null) {
            return;
        }
        mainHandler.post(() -> currentListener.onSpeechStart(startMs));
    }

    private void emitStatus(String status) {
        FaceclawCaptionEngineListener currentListener = listener;
        if (currentListener == null) {
            return;
        }
        mainHandler.post(() -> currentListener.onStatus(status));
    }
}
