package com.k2fsa.sherpa.onnx;

public class OnlineRecognizerConfig {
    private final FeatureConfig featConfig;
    private final OnlineModelConfig modelConfig;
    private final OnlineLMConfig lmConfig;
    private final OnlineCtcFstDecoderConfig ctcFstDecoderConfig;
    private final HomophoneReplacerConfig hr;
    private final EndpointConfig endpointConfig;
    private final boolean enableEndpoint;
    private final String decodingMethod;
    private final int maxActivePaths;
    private final String hotwordsFile;
    private final float hotwordsScore;
    private final String ruleFsts;
    private final String ruleFars;
    private final float blankPenalty;

    private OnlineRecognizerConfig(Builder builder) {
        this.featConfig = builder.featConfig;
        this.modelConfig = builder.modelConfig;
        this.lmConfig = builder.lmConfig;
        this.ctcFstDecoderConfig = builder.ctcFstDecoderConfig;
        this.hr = builder.hr;
        this.endpointConfig = builder.endpointConfig;
        this.enableEndpoint = builder.enableEndpoint;
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

    public OnlineModelConfig getModelConfig() {
        return modelConfig;
    }

    public OnlineLMConfig getLmConfig() {
        return lmConfig;
    }

    public OnlineCtcFstDecoderConfig getCtcFstDecoderConfig() {
        return ctcFstDecoderConfig;
    }

    public HomophoneReplacerConfig getHr() {
        return hr;
    }

    public EndpointConfig getEndpointConfig() {
        return endpointConfig;
    }

    public boolean getEnableEndpoint() {
        return enableEndpoint;
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
        private OnlineModelConfig modelConfig = OnlineModelConfig.builder().build();
        private OnlineLMConfig lmConfig = OnlineLMConfig.builder().build();
        private OnlineCtcFstDecoderConfig ctcFstDecoderConfig = OnlineCtcFstDecoderConfig.builder().build();
        private HomophoneReplacerConfig hr = HomophoneReplacerConfig.builder().build();
        private EndpointConfig endpointConfig = EndpointConfig.builder().build();
        private boolean enableEndpoint = true;
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

        public Builder setOnlineModelConfig(OnlineModelConfig modelConfig) {
            this.modelConfig = modelConfig;
            return this;
        }

        public Builder setEndpointConfig(EndpointConfig endpointConfig) {
            this.endpointConfig = endpointConfig;
            return this;
        }

        public Builder setEnableEndpoint(boolean enableEndpoint) {
            this.enableEndpoint = enableEndpoint;
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

        public OnlineRecognizerConfig build() {
            return new OnlineRecognizerConfig(this);
        }
    }
}
