package com.k2fsa.sherpa.onnx;

public class OnlineRecognizer {
    private long ptr;

    public OnlineRecognizer(OnlineRecognizerConfig config) {
        System.loadLibrary("onnxruntime");
        System.loadLibrary("sherpa-onnx-jni");
        ptr = newFromFile(config);
        if (ptr == 0) {
            throw new IllegalArgumentException("Invalid OnlineRecognizerConfig");
        }
    }

    public OnlineStream createStream() {
        return createStream("");
    }

    public OnlineStream createStream(String hotwords) {
        long streamPtr = createStream(ptr, hotwords == null ? "" : hotwords);
        return new OnlineStream(streamPtr);
    }

    public boolean isReady(OnlineStream stream) {
        return stream != null && isReady(ptr, stream.getPtr());
    }

    public void decode(OnlineStream stream) {
        if (stream != null) {
            decode(ptr, stream.getPtr());
        }
    }

    public void reset(OnlineStream stream) {
        if (stream != null) {
            reset(ptr, stream.getPtr());
        }
    }

    public boolean isEndpoint(OnlineStream stream) {
        return stream != null && isEndpoint(ptr, stream.getPtr());
    }

    public OnlineRecognizerResult getResult(OnlineStream stream) {
        if (stream == null) {
            return new OnlineRecognizerResult("", new String[0], new float[0], new float[0]);
        }
        return getResult(ptr, stream.getPtr());
    }

    public void release() {
        if (ptr != 0) {
            delete(ptr);
            ptr = 0;
        }
    }

    private native long newFromFile(OnlineRecognizerConfig config);
    private native void delete(long ptr);
    private native long createStream(long ptr, String hotwords);
    private native void reset(long ptr, long streamPtr);
    private native void decode(long ptr, long streamPtr);
    private native boolean isEndpoint(long ptr, long streamPtr);
    private native boolean isReady(long ptr, long streamPtr);
    private native OnlineRecognizerResult getResult(long ptr, long streamPtr);
}
