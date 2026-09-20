package com.k2fsa.sherpa.onnx;

/**
 * Config for sherpa-onnx's offline (non-streaming) Whisper backend.
 *
 * Field names and types here are load-bearing: the native JNI glue reads
 * them by name via reflection (GetFieldID), not through the getters below,
 * so they must match sherpa-onnx's own OfflineWhisperModelConfig exactly
 * (verified against sherpa-onnx/jni/offline-recognizer.cc at the pinned
 * release tag: it unconditionally reads encoder, decoder, language, task,
 * tailPaddings, enableTokenTimestamps and enableSegmentTimestamps off the
 * OfflineModelConfig's "whisper" field). This mirrors the
 * OfflineMoonshineModelConfig.java pattern already used in this package.
 */
public class OfflineWhisperModelConfig {
    private final String encoder;
    private final String decoder;
    private final String language;
    private final String task;
    private final int tailPaddings;
    private final boolean enableTokenTimestamps;
    private final boolean enableSegmentTimestamps;

    private OfflineWhisperModelConfig(Builder builder) {
        this.encoder = builder.encoder;
        this.decoder = builder.decoder;
        this.language = builder.language;
        this.task = builder.task;
        this.tailPaddings = builder.tailPaddings;
        this.enableTokenTimestamps = builder.enableTokenTimestamps;
        this.enableSegmentTimestamps = builder.enableSegmentTimestamps;
    }

    public static Builder builder() {
        return new Builder();
    }

    public String getEncoder() {
        return encoder;
    }

    public String getDecoder() {
        return decoder;
    }

    public String getLanguage() {
        return language;
    }

    public String getTask() {
        return task;
    }

    public int getTailPaddings() {
        return tailPaddings;
    }

    public boolean getEnableTokenTimestamps() {
        return enableTokenTimestamps;
    }

    public boolean getEnableSegmentTimestamps() {
        return enableSegmentTimestamps;
    }

    public static class Builder {
        private String encoder = "";
        private String decoder = "";
        private String language = "en";
        private String task = "transcribe";
        private int tailPaddings = 1000;
        private boolean enableTokenTimestamps = false;
        private boolean enableSegmentTimestamps = false;

        public Builder setEncoder(String encoder) {
            this.encoder = encoder;
            return this;
        }

        public Builder setDecoder(String decoder) {
            this.decoder = decoder;
            return this;
        }

        public Builder setLanguage(String language) {
            this.language = language;
            return this;
        }

        public Builder setTask(String task) {
            this.task = task;
            return this;
        }

        public Builder setTailPaddings(int tailPaddings) {
            this.tailPaddings = tailPaddings;
            return this;
        }

        public Builder setEnableTokenTimestamps(boolean enableTokenTimestamps) {
            this.enableTokenTimestamps = enableTokenTimestamps;
            return this;
        }

        public Builder setEnableSegmentTimestamps(boolean enableSegmentTimestamps) {
            this.enableSegmentTimestamps = enableSegmentTimestamps;
            return this;
        }

        public OfflineWhisperModelConfig build() {
            return new OfflineWhisperModelConfig(this);
        }
    }
}
