package com.faceclaw.app;

import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import com.k2fsa.sherpa.onnx.FastClusteringConfig;
import com.k2fsa.sherpa.onnx.OfflineSpeakerDiarization;
import com.k2fsa.sherpa.onnx.OfflineSpeakerDiarizationConfig;
import com.k2fsa.sherpa.onnx.OfflineSpeakerDiarizationSegment;
import com.k2fsa.sherpa.onnx.OfflineSpeakerSegmentationModelConfig;
import com.k2fsa.sherpa.onnx.OfflineSpeakerSegmentationPyannoteModelConfig;
import com.k2fsa.sherpa.onnx.SpeakerEmbeddingExtractorConfig;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.DataInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.nio.ByteBuffer;

/**
 * Offline re-diarization of a stored conversation recording (16-bit mono
 * WAV): pyannote segmentation plus the shared speaker-embedding model with
 * clustering, via sherpa-onnx. Runs on its own thread; results are handed to
 * TS as JSON turns for reconciliation against the transcript segments.
 */
public class FaceclawDiarizer {
    private static final String TAG = "FaceclawDiarizer";

    public interface Listener {
        /** progress in [0, 1]. */
        void onProgress(double progress);

        /** turns: [{startMs, endMs, cluster}], sorted by start time. */
        void onDone(String turnsJson);

        void onError(String message);
    }

    private final String segmentationModelPath;
    private final String embeddingModelPath;
    private final String wavPath;
    private final int numClusters;
    private final float threshold;
    private final Listener listener;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private volatile boolean cancelled;

    public FaceclawDiarizer(
            String segmentationModelPath,
            String embeddingModelPath,
            String wavPath,
            int numClusters,
            float threshold,
            Listener listener) {
        this.segmentationModelPath = segmentationModelPath;
        this.embeddingModelPath = embeddingModelPath;
        this.wavPath = wavPath;
        this.numClusters = numClusters;
        this.threshold = threshold <= 0 ? 0.5f : threshold;
        this.listener = listener;
    }

    public void start() {
        Thread thread = new Thread(this::run, "FaceclawDiarizer");
        thread.setPriority(Thread.MIN_PRIORITY);
        thread.start();
    }

    public void cancel() {
        cancelled = true;
    }

    private void run() {
        OfflineSpeakerDiarization diarization = null;
        try {
            float[] samples = wavPath.endsWith(".wav")
                    ? readWavMono16(wavPath)
                    : decodeCompressedMono(wavPath);
            OfflineSpeakerDiarizationConfig config = OfflineSpeakerDiarizationConfig.builder()
                    .setSegmentation(OfflineSpeakerSegmentationModelConfig.builder()
                            .setPyannote(OfflineSpeakerSegmentationPyannoteModelConfig.builder()
                                    .setModel(segmentationModelPath)
                                    .build())
                            .setNumThreads(1)
                            .build())
                    .setEmbedding(SpeakerEmbeddingExtractorConfig.builder()
                            .setModel(embeddingModelPath)
                            .setNumThreads(1)
                            .build())
                    .setClustering(FastClusteringConfig.builder()
                            .setNumClusters(numClusters > 0 ? numClusters : -1)
                            .setThreshold(threshold)
                            .build())
                    .setMinDurationOn(0.3f)
                    .setMinDurationOff(0.5f)
                    .build();
            diarization = new OfflineSpeakerDiarization(config);
            OfflineSpeakerDiarizationSegment[] segments = diarization.processWithCallback(
                    samples,
                    (numProcessedChunks, numTotalChunks, arg) -> {
                        emitProgress(numTotalChunks <= 0 ? 0
                                : (double) numProcessedChunks / numTotalChunks);
                        return cancelled ? 1 : 0;
                    });
            JSONArray turns = new JSONArray();
            if (segments != null) {
                for (OfflineSpeakerDiarizationSegment segment : segments) {
                    JSONObject turn = new JSONObject();
                    turn.put("startMs", Math.round(segment.getStart() * 1000));
                    turn.put("endMs", Math.round(segment.getEnd() * 1000));
                    turn.put("cluster", segment.getSpeaker());
                    turns.put(turn);
                }
            }
            String result = turns.toString();
            mainHandler.post(() -> listener.onDone(result));
        } catch (Throwable t) {
            Log.w(TAG, "diarization failed for " + wavPath, t);
            String message = t.getMessage() == null ? t.toString() : t.getMessage();
            mainHandler.post(() -> listener.onError(message));
        } finally {
            if (diarization != null) {
                diarization.release();
            }
        }
    }

    private void emitProgress(double progress) {
        mainHandler.post(() -> listener.onProgress(Math.max(0, Math.min(1, progress))));
    }

    /**
     * Decode a compressed recording (M4A/AAC from the transcode sweep) into
     * [-1, 1] floats via MediaExtractor + MediaCodec. Recordings are written
     * as 16 kHz mono, so no resampling is needed.
     */
    private static float[] decodeCompressedMono(String path) throws IOException {
        android.media.MediaExtractor extractor = new android.media.MediaExtractor();
        android.media.MediaCodec codec = null;
        java.io.ByteArrayOutputStream pcm = new java.io.ByteArrayOutputStream();
        try {
            extractor.setDataSource(path);
            int trackIndex = -1;
            android.media.MediaFormat format = null;
            for (int i = 0; i < extractor.getTrackCount(); i++) {
                android.media.MediaFormat candidate = extractor.getTrackFormat(i);
                String mime = candidate.getString(android.media.MediaFormat.KEY_MIME);
                if (mime != null && mime.startsWith("audio/")) {
                    trackIndex = i;
                    format = candidate;
                    break;
                }
            }
            if (trackIndex < 0 || format == null) {
                throw new IOException("no audio track in " + path);
            }
            extractor.selectTrack(trackIndex);
            codec = android.media.MediaCodec.createDecoderByType(
                    format.getString(android.media.MediaFormat.KEY_MIME));
            codec.configure(format, null, null, 0);
            codec.start();
            android.media.MediaCodec.BufferInfo info = new android.media.MediaCodec.BufferInfo();
            boolean inputDone = false;
            boolean outputDone = false;
            while (!outputDone) {
                if (!inputDone) {
                    int inIndex = codec.dequeueInputBuffer(10_000);
                    if (inIndex >= 0) {
                        ByteBuffer inBuf = codec.getInputBuffer(inIndex);
                        int size = extractor.readSampleData(inBuf, 0);
                        if (size < 0) {
                            codec.queueInputBuffer(inIndex, 0, 0, 0,
                                    android.media.MediaCodec.BUFFER_FLAG_END_OF_STREAM);
                            inputDone = true;
                        } else {
                            codec.queueInputBuffer(inIndex, 0, size, extractor.getSampleTime(), 0);
                            extractor.advance();
                        }
                    }
                }
                int outIndex = codec.dequeueOutputBuffer(info, 10_000);
                if (outIndex >= 0) {
                    ByteBuffer outBuf = codec.getOutputBuffer(outIndex);
                    byte[] chunk = new byte[info.size];
                    outBuf.position(info.offset);
                    outBuf.get(chunk);
                    pcm.write(chunk);
                    codec.releaseOutputBuffer(outIndex, false);
                    if ((info.flags & android.media.MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) {
                        outputDone = true;
                    }
                }
            }
        } finally {
            extractor.release();
            if (codec != null) {
                try {
                    codec.stop();
                } catch (Throwable ignored) {
                }
                codec.release();
            }
        }
        byte[] bytes = pcm.toByteArray();
        int count = bytes.length / 2;
        float[] samples = new float[count];
        for (int i = 0; i < count; i++) {
            samples[i] = ((short) ((bytes[i * 2] & 0xff) | (bytes[i * 2 + 1] << 8))) / 32768.0f;
        }
        return samples;
    }

    /** Load a 16-bit mono PCM WAV into [-1, 1] floats. */
    private static float[] readWavMono16(String path) throws IOException {
        File file = new File(path);
        long fileLength = file.length();
        try (DataInputStream in = new DataInputStream(new FileInputStream(file))) {
            byte[] header = new byte[44];
            in.readFully(header);
            if (header[0] != 'R' || header[1] != 'I' || header[8] != 'W') {
                throw new IOException("not a WAV file");
            }
            int channels = (header[22] & 0xff) | (header[23] << 8);
            int bits = (header[34] & 0xff) | (header[35] << 8);
            if (channels != 1 || bits != 16) {
                throw new IOException("only 16-bit mono WAV is supported");
            }
            long dataBytes = fileLength - 44;
            int count = (int) Math.min(dataBytes / 2, Integer.MAX_VALUE);
            float[] samples = new float[count];
            byte[] chunk = new byte[65536];
            int sampleIndex = 0;
            int carried = 0;
            byte carriedByte = 0;
            int read;
            while (sampleIndex < count && (read = in.read(chunk)) > 0) {
                int offset = 0;
                if (carried == 1) {
                    samples[sampleIndex++] =
                            ((short) ((carriedByte & 0xff) | (chunk[0] << 8))) / 32768.0f;
                    offset = 1;
                    carried = 0;
                }
                int pairs = (read - offset) / 2;
                for (int i = 0; i < pairs && sampleIndex < count; i++) {
                    int base = offset + i * 2;
                    samples[sampleIndex++] =
                            ((short) ((chunk[base] & 0xff) | (chunk[base + 1] << 8))) / 32768.0f;
                }
                if (((read - offset) & 1) == 1) {
                    carried = 1;
                    carriedByte = chunk[read - 1];
                }
            }
            return samples;
        }
    }
}
