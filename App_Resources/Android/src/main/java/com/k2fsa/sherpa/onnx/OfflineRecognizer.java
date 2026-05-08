package com.k2fsa.sherpa.onnx;

public class OfflineRecognizer {
    private long ptr;

    public OfflineRecognizer(OfflineRecognizerConfig config) {
        System.loadLibrary("onnxruntime");
        System.loadLibrary("sherpa-onnx-jni");
        ptr = newFromFile(config);
        if (ptr == 0) {
            throw new IllegalArgumentException("Invalid OfflineRecognizerConfig");
        }
    }

    public OfflineStream createStream() {
        return new OfflineStream(createStream(ptr));
    }

    public void decode(OfflineStream stream) {
        if (stream != null) {
            decode(ptr, stream.getPtr());
        }
    }

    public OfflineRecognizerResult getResult(OfflineStream stream) {
        if (stream == null) {
            return new OfflineRecognizerResult("", new String[0], new float[0], "", "", "", new float[0]);
        }
        return getResult(stream.getPtr());
    }

    public void release() {
        if (ptr != 0) {
            delete(ptr);
            ptr = 0;
        }
    }

    private native long newFromFile(OfflineRecognizerConfig config);
    private native void delete(long ptr);
    private native long createStream(long ptr);
    private native void decode(long ptr, long streamPtr);
    private native OfflineRecognizerResult getResult(long streamPtr);
}
