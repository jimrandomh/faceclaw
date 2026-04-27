package com.k2fsa.sherpa.onnx;

public class KeywordSpotter {
    private long ptr;

    public KeywordSpotter(KeywordSpotterConfig config) {
        System.loadLibrary("onnxruntime");
        System.loadLibrary("sherpa-onnx-jni");
        ptr = newFromFile(config);
        if (ptr == 0) {
            throw new IllegalArgumentException("Invalid KeywordSpotterConfig");
        }
    }

    public OnlineStream createStream() {
        return createStream("");
    }

    public OnlineStream createStream(String keywords) {
        return new OnlineStream(createStream(ptr, keywords == null ? "" : keywords));
    }

    public boolean isReady(OnlineStream stream) {
        return stream != null && stream.getPtr() != 0 && isReady(ptr, stream.getPtr());
    }

    public void decode(OnlineStream stream) {
        decode(ptr, stream.getPtr());
    }

    public void reset(OnlineStream stream) {
        reset(ptr, stream.getPtr());
    }

    public KeywordSpotterResult getResult(OnlineStream stream) {
        return getResult(ptr, stream.getPtr());
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

    private native long newFromFile(KeywordSpotterConfig config);

    private native void delete(long ptr);

    private native long createStream(long ptr, String keywords);

    private native boolean isReady(long ptr, long streamPtr);

    private native void decode(long ptr, long streamPtr);

    private native void reset(long ptr, long streamPtr);

    private native KeywordSpotterResult getResult(long ptr, long streamPtr);
}
