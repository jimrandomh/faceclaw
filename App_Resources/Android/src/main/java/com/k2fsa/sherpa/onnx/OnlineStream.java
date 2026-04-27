package com.k2fsa.sherpa.onnx;

public class OnlineStream {
    private long ptr;

    public OnlineStream(long ptr) {
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

    @Override
    protected void finalize() throws Throwable {
        release();
        super.finalize();
    }

    private native void acceptWaveform(long ptr, float[] samples, int sampleRate);

    private native void delete(long ptr);
}
