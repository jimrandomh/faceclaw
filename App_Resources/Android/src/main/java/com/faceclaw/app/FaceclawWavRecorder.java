package com.faceclaw.app;

import android.util.Log;

import java.io.File;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;

/**
 * Streaming WAV writer for conversation recordings: the header is written up
 * front with zero sizes and patched on finish, so a crash mid-session leaves
 * a recoverable file (data length can be derived from the file size).
 */
public class FaceclawWavRecorder {
    private static final String TAG = "FaceclawWavRecorder";

    private final String path;
    private final int sampleRate;
    private final int channels;
    private RandomAccessFile file;
    private long dataBytes;

    public FaceclawWavRecorder(String path, int sampleRate, int channels) throws IOException {
        this.path = path;
        this.sampleRate = sampleRate;
        this.channels = channels;
        File parent = new File(path).getParentFile();
        if (parent != null && !parent.exists() && !parent.mkdirs()) {
            throw new IOException("could not create " + parent);
        }
        file = new RandomAccessFile(path, "rw");
        file.setLength(0);
        file.write(buildHeader(0));
    }

    public synchronized void append(byte[] pcm16le) {
        if (file == null || pcm16le == null || pcm16le.length == 0) {
            return;
        }
        try {
            file.write(pcm16le);
            dataBytes += pcm16le.length;
        } catch (IOException e) {
            Log.w(TAG, "append failed", e);
        }
    }

    public synchronized long getDurationMs() {
        return dataBytes * 1000L / (sampleRate * channels * 2L);
    }

    public String getPath() {
        return path;
    }

    /** Patch the header and close. Returns the PCM byte count (0 = empty). */
    public synchronized long finish() {
        RandomAccessFile current = file;
        file = null;
        if (current == null) {
            return dataBytes;
        }
        try {
            current.seek(0);
            current.write(buildHeader((int) Math.min(dataBytes, Integer.MAX_VALUE)));
            current.close();
        } catch (IOException e) {
            Log.w(TAG, "finish failed", e);
        }
        return dataBytes;
    }

    /** Delete the (finished or abandoned) recording. */
    public synchronized void discard() {
        finish();
        new File(path).delete();
    }

    private byte[] buildHeader(int pcmBytes) {
        int byteRate = sampleRate * channels * 2;
        ByteBuffer b = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN);
        b.put("RIFF".getBytes(StandardCharsets.US_ASCII));
        b.putInt(36 + pcmBytes);
        b.put("WAVE".getBytes(StandardCharsets.US_ASCII));
        b.put("fmt ".getBytes(StandardCharsets.US_ASCII));
        b.putInt(16);
        b.putShort((short) 1);
        b.putShort((short) channels);
        b.putInt(sampleRate);
        b.putInt(byteRate);
        b.putShort((short) (channels * 2));
        b.putShort((short) 16);
        b.put("data".getBytes(StandardCharsets.US_ASCII));
        b.putInt(pcmBytes);
        return b.array();
    }
}
