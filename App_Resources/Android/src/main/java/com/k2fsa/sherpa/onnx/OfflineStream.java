package com.k2fsa.sherpa.onnx;

public class OfflineStream {
    private long ptr;

    public OfflineStream(long ptr) {
        this.ptr = ptr;
    }

    public long getPtr() {
        return ptr;
    }

    public void acceptWaveform(float[] samples, int sampleRate) {
        acceptWaveform(ptr, samples, sampleRate);
    }

    public void release() {
        if (ptr == 0) {
            return;
        }
        delete(ptr);
        ptr = 0;
    }

    private native void acceptWaveform(long ptr, float[] samples, int sampleRate);

    private native void delete(long ptr);
}
