package com.faceclaw.app;

import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaFormat;
import android.media.MediaMuxer;
import android.util.Log;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;

/**
 * Transcodes a 16-bit PCM WAV conversation recording into AAC-LC in an M4A
 * container, cutting speech recordings to roughly a tenth of their WAV size.
 * Runs on its own thread; the source WAV is deleted on success when requested.
 */
public class FaceclawAudioTranscoder {
    private static final String TAG = "FaceclawTranscode";
    private static final long CODEC_TIMEOUT_US = 10_000;

    public interface Listener {
        void onDone(String outputPath, long outputBytes);

        void onError(String message);
    }

    private final String wavPath;
    private final String outputPath;
    private final int bitrateBps;
    private final boolean deleteSourceOnSuccess;
    private final Listener listener;

    public FaceclawAudioTranscoder(
            String wavPath,
            String outputPath,
            int bitrateBps,
            boolean deleteSourceOnSuccess,
            Listener listener) {
        this.wavPath = wavPath;
        this.outputPath = outputPath;
        this.bitrateBps = bitrateBps > 0 ? bitrateBps : 32_000;
        this.deleteSourceOnSuccess = deleteSourceOnSuccess;
        this.listener = listener;
    }

    public void start() {
        Thread thread = new Thread(this::run, "FaceclawTranscode");
        thread.setPriority(Thread.MIN_PRIORITY);
        thread.start();
    }

    private void run() {
        try {
            transcode();
            long size = new File(outputPath).length();
            if (deleteSourceOnSuccess) {
                new File(wavPath).delete();
            }
            if (listener != null) {
                listener.onDone(outputPath, size);
            }
        } catch (Throwable t) {
            Log.w(TAG, "transcode failed for " + wavPath, t);
            new File(outputPath).delete();
            if (listener != null) {
                listener.onError(t.getMessage() == null ? t.toString() : t.getMessage());
            }
        }
    }

    private void transcode() throws IOException {
        WavInfo wav = readWavHeader(wavPath);
        MediaFormat format = MediaFormat.createAudioFormat(
                MediaFormat.MIMETYPE_AUDIO_AAC, wav.sampleRate, wav.channels);
        format.setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC);
        format.setInteger(MediaFormat.KEY_BIT_RATE, bitrateBps);
        format.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 16 * 1024);

        MediaCodec codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC);
        MediaMuxer muxer = null;
        FileInputStream input = null;
        try {
            codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
            codec.start();
            muxer = new MediaMuxer(outputPath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4);
            input = new FileInputStream(wavPath);
            long skipped = 0;
            while (skipped < wav.dataOffset) {
                long step = input.skip(wav.dataOffset - skipped);
                if (step <= 0) {
                    throw new IOException("could not seek past WAV header");
                }
                skipped += step;
            }

            MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
            byte[] chunk = new byte[8192];
            int track = -1;
            boolean muxerStarted = false;
            boolean inputDone = false;
            boolean outputDone = false;
            long remaining = wav.dataBytes;
            long presentationUs = 0;
            long bytesPerSecond = (long) wav.sampleRate * wav.channels * 2;

            while (!outputDone) {
                if (!inputDone) {
                    int inIndex = codec.dequeueInputBuffer(CODEC_TIMEOUT_US);
                    if (inIndex >= 0) {
                        ByteBuffer inBuf = codec.getInputBuffer(inIndex);
                        int wanted = (int) Math.min(chunk.length, Math.min(remaining, inBuf.capacity()));
                        int read = wanted > 0 ? input.read(chunk, 0, wanted) : -1;
                        if (read <= 0) {
                            codec.queueInputBuffer(inIndex, 0, 0, presentationUs,
                                    MediaCodec.BUFFER_FLAG_END_OF_STREAM);
                            inputDone = true;
                        } else {
                            inBuf.clear();
                            inBuf.put(chunk, 0, read);
                            codec.queueInputBuffer(inIndex, 0, read, presentationUs, 0);
                            remaining -= read;
                            presentationUs += read * 1_000_000L / bytesPerSecond;
                        }
                    }
                }
                int outIndex = codec.dequeueOutputBuffer(info, CODEC_TIMEOUT_US);
                if (outIndex == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    track = muxer.addTrack(codec.getOutputFormat());
                    muxer.start();
                    muxerStarted = true;
                } else if (outIndex >= 0) {
                    if (info.size > 0 && (info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0) {
                        if (!muxerStarted) {
                            throw new IOException("encoder produced data before format");
                        }
                        ByteBuffer outBuf = codec.getOutputBuffer(outIndex);
                        outBuf.position(info.offset);
                        outBuf.limit(info.offset + info.size);
                        muxer.writeSampleData(track, outBuf, info);
                    }
                    codec.releaseOutputBuffer(outIndex, false);
                    if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) {
                        outputDone = true;
                    }
                }
            }
        } finally {
            if (input != null) {
                try {
                    input.close();
                } catch (IOException ignored) {
                }
            }
            try {
                codec.stop();
            } catch (Throwable ignored) {
            }
            codec.release();
            if (muxer != null) {
                try {
                    muxer.stop();
                } catch (Throwable ignored) {
                }
                muxer.release();
            }
        }
    }

    private static final class WavInfo {
        int sampleRate;
        int channels;
        long dataOffset;
        long dataBytes;
    }

    /** Minimal RIFF walk: locates fmt and data chunks, 16-bit PCM only. */
    private static WavInfo readWavHeader(String path) throws IOException {
        try (FileInputStream in = new FileInputStream(path)) {
            byte[] head = new byte[12];
            if (in.read(head) != 12 || head[0] != 'R' || head[1] != 'I' || head[8] != 'W') {
                throw new IOException("not a WAV file");
            }
            WavInfo info = new WavInfo();
            long offset = 12;
            byte[] chunkHead = new byte[8];
            while (in.read(chunkHead) == 8) {
                ByteBuffer b = ByteBuffer.wrap(chunkHead).order(ByteOrder.LITTLE_ENDIAN);
                int id = b.getInt();
                long size = b.getInt() & 0xffffffffL;
                offset += 8;
                if (id == 0x20746d66) { // "fmt "
                    byte[] fmt = new byte[(int) Math.min(size, 16)];
                    if (in.read(fmt) != fmt.length) {
                        throw new IOException("truncated fmt chunk");
                    }
                    ByteBuffer f = ByteBuffer.wrap(fmt).order(ByteOrder.LITTLE_ENDIAN);
                    int audioFormat = f.getShort();
                    info.channels = f.getShort();
                    info.sampleRate = f.getInt();
                    f.getInt();
                    f.getShort();
                    int bits = f.getShort();
                    if (audioFormat != 1 || bits != 16) {
                        throw new IOException("only 16-bit PCM WAV is supported");
                    }
                    long skip = size - fmt.length;
                    while (skip > 0) {
                        long step = in.skip(skip);
                        if (step <= 0) {
                            break;
                        }
                        skip -= step;
                    }
                    offset += size;
                } else if (id == 0x61746164) { // "data"
                    info.dataOffset = offset;
                    // A zero size means the header was never patched (crash
                    // mid-recording); recover the length from the file size.
                    info.dataBytes = size > 0 ? size : new File(path).length() - offset;
                    break;
                } else {
                    long skip = size;
                    while (skip > 0) {
                        long step = in.skip(skip);
                        if (step <= 0) {
                            break;
                        }
                        skip -= step;
                    }
                    offset += size;
                }
            }
            if (info.sampleRate == 0 || info.dataOffset == 0) {
                throw new IOException("missing fmt or data chunk");
            }
            return info;
        }
    }
}
