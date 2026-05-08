package com.k2fsa.sherpa.onnx;

public class OfflineRecognizerConfig {
    private final FeatureConfig featConfig;
    private final OfflineModelConfig modelConfig;
    private final HomophoneReplacerConfig hr;
    private final String decodingMethod;
    private final int maxActivePaths;
    private final String hotwordsFile;
    private final float hotwordsScore;
    private final String ruleFsts;
    private final String ruleFars;
    private final float blankPenalty;

    private OfflineRecognizerConfig(Builder builder) {
        this.featConfig = builder.featConfig;
        this.modelConfig = builder.modelConfig;
        this.hr = builder.hr;
        this.decodingMethod = builder.decodingMethod;
        this.maxActivePaths = builder.maxActivePaths;
        this.hotwordsFile = builder.hotwordsFile;
        this.hotwordsScore = builder.hotwordsScore;
        this.ruleFsts = builder.ruleFsts;
        this.ruleFars = builder.ruleFars;
        this.blankPenalty = builder.blankPenalty;
    }

    public static Builder builder() {
        return new Builder();
    }

    public FeatureConfig getFeatConfig() {
        return featConfig;
    }

    public OfflineModelConfig getModelConfig() {
        return modelConfig;
    }

    public HomophoneReplacerConfig getHr() {
        return hr;
    }

    public String getDecodingMethod() {
        return decodingMethod;
    }

    public int getMaxActivePaths() {
        return maxActivePaths;
    }

    public String getHotwordsFile() {
        return hotwordsFile;
    }

    public float getHotwordsScore() {
        return hotwordsScore;
    }

    public String getRuleFsts() {
        return ruleFsts;
    }

    public String getRuleFars() {
        return ruleFars;
    }

    public float getBlankPenalty() {
        return blankPenalty;
    }

    public static class Builder {
        private FeatureConfig featConfig = FeatureConfig.builder().build();
        private OfflineModelConfig modelConfig = OfflineModelConfig.builder().build();
        private HomophoneReplacerConfig hr = HomophoneReplacerConfig.builder().build();
        private String decodingMethod = "greedy_search";
        private int maxActivePaths = 4;
        private String hotwordsFile = "";
        private float hotwordsScore = 1.5f;
        private String ruleFsts = "";
        private String ruleFars = "";
        private float blankPenalty = 0.0f;

        public Builder setFeatureConfig(FeatureConfig featConfig) {
            this.featConfig = featConfig;
            return this;
        }

        public Builder setModelConfig(OfflineModelConfig modelConfig) {
            this.modelConfig = modelConfig;
            return this;
        }

        public Builder setDecodingMethod(String decodingMethod) {
            this.decodingMethod = decodingMethod;
            return this;
        }

        public Builder setMaxActivePaths(int maxActivePaths) {
            this.maxActivePaths = maxActivePaths;
            return this;
        }

        public OfflineRecognizerConfig build() {
            return new OfflineRecognizerConfig(this);
        }
    }
}
