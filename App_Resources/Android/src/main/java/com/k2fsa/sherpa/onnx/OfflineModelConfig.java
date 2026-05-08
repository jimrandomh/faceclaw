package com.k2fsa.sherpa.onnx;

public class OfflineModelConfig {
    private final OfflineTransducerModelConfig transducer;
    private final OfflineParaformerModelConfig paraformer;
    private final OfflineWhisperModelConfig whisper;
    private final OfflineFireRedAsrModelConfig fireRedAsr;
    private final OfflineMoonshineModelConfig moonshine;
    private final OfflineNemoEncDecCtcModelConfig nemo;
    private final OfflineSenseVoiceModelConfig senseVoice;
    private final OfflineDolphinModelConfig dolphin;
    private final OfflineZipformerCtcModelConfig zipformerCtc;
    private final OfflineWenetCtcModelConfig wenetCtc;
    private final OfflineOmnilingualAsrCtcModelConfig omnilingual;
    private final OfflineMedAsrCtcModelConfig medasr;
    private final OfflineFunAsrNanoModelConfig funasrNano;
    private final OfflineQwen3AsrModelConfig qwen3Asr;
    private final OfflineFireRedAsrCtcModelConfig fireRedAsrCtc;
    private final OfflineCanaryModelConfig canary;
    private final OfflineCohereTranscribeModelConfig cohereTranscribe;
    private final String teleSpeech;
    private final int numThreads;
    private final boolean debug;
    private final String provider;
    private final String modelType;
    private final String tokens;
    private final String modelingUnit;
    private final String bpeVocab;

    private OfflineModelConfig(Builder builder) {
        this.transducer = builder.transducer;
        this.paraformer = builder.paraformer;
        this.whisper = builder.whisper;
        this.fireRedAsr = builder.fireRedAsr;
        this.moonshine = builder.moonshine;
        this.nemo = builder.nemo;
        this.senseVoice = builder.senseVoice;
        this.dolphin = builder.dolphin;
        this.zipformerCtc = builder.zipformerCtc;
        this.wenetCtc = builder.wenetCtc;
        this.omnilingual = builder.omnilingual;
        this.medasr = builder.medasr;
        this.funasrNano = builder.funasrNano;
        this.qwen3Asr = builder.qwen3Asr;
        this.fireRedAsrCtc = builder.fireRedAsrCtc;
        this.canary = builder.canary;
        this.cohereTranscribe = builder.cohereTranscribe;
        this.teleSpeech = builder.teleSpeech;
        this.numThreads = builder.numThreads;
        this.debug = builder.debug;
        this.provider = builder.provider;
        this.modelType = builder.modelType;
        this.tokens = builder.tokens;
        this.modelingUnit = builder.modelingUnit;
        this.bpeVocab = builder.bpeVocab;
    }

    public static Builder builder() {
        return new Builder();
    }

    public OfflineTransducerModelConfig getTransducer() {
        return transducer;
    }

    public OfflineParaformerModelConfig getParaformer() {
        return paraformer;
    }

    public OfflineWhisperModelConfig getWhisper() {
        return whisper;
    }

    public OfflineFireRedAsrModelConfig getFireRedAsr() {
        return fireRedAsr;
    }

    public OfflineMoonshineModelConfig getMoonshine() {
        return moonshine;
    }

    public OfflineNemoEncDecCtcModelConfig getNemo() {
        return nemo;
    }

    public OfflineSenseVoiceModelConfig getSenseVoice() {
        return senseVoice;
    }

    public OfflineDolphinModelConfig getDolphin() {
        return dolphin;
    }

    public OfflineZipformerCtcModelConfig getZipformerCtc() {
        return zipformerCtc;
    }

    public OfflineWenetCtcModelConfig getWenetCtc() {
        return wenetCtc;
    }

    public OfflineOmnilingualAsrCtcModelConfig getOmnilingual() {
        return omnilingual;
    }

    public OfflineMedAsrCtcModelConfig getMedasr() {
        return medasr;
    }

    public OfflineFunAsrNanoModelConfig getFunasrNano() {
        return funasrNano;
    }

    public OfflineQwen3AsrModelConfig getQwen3Asr() {
        return qwen3Asr;
    }

    public OfflineFireRedAsrCtcModelConfig getFireRedAsrCtc() {
        return fireRedAsrCtc;
    }

    public OfflineCanaryModelConfig getCanary() {
        return canary;
    }

    public OfflineCohereTranscribeModelConfig getCohereTranscribe() {
        return cohereTranscribe;
    }

    public String getTeleSpeech() {
        return teleSpeech;
    }

    public int getNumThreads() {
        return numThreads;
    }

    public boolean getDebug() {
        return debug;
    }

    public String getProvider() {
        return provider;
    }

    public String getModelType() {
        return modelType;
    }

    public String getTokens() {
        return tokens;
    }

    public String getModelingUnit() {
        return modelingUnit;
    }

    public String getBpeVocab() {
        return bpeVocab;
    }

    public static class Builder {
        private OfflineTransducerModelConfig transducer = new OfflineTransducerModelConfig();
        private OfflineParaformerModelConfig paraformer = new OfflineParaformerModelConfig();
        private OfflineWhisperModelConfig whisper = new OfflineWhisperModelConfig();
        private OfflineFireRedAsrModelConfig fireRedAsr = new OfflineFireRedAsrModelConfig();
        private OfflineMoonshineModelConfig moonshine = OfflineMoonshineModelConfig.builder().build();
        private OfflineNemoEncDecCtcModelConfig nemo = new OfflineNemoEncDecCtcModelConfig();
        private OfflineSenseVoiceModelConfig senseVoice = new OfflineSenseVoiceModelConfig();
        private OfflineDolphinModelConfig dolphin = new OfflineDolphinModelConfig();
        private OfflineZipformerCtcModelConfig zipformerCtc = new OfflineZipformerCtcModelConfig();
        private OfflineWenetCtcModelConfig wenetCtc = new OfflineWenetCtcModelConfig();
        private OfflineOmnilingualAsrCtcModelConfig omnilingual = new OfflineOmnilingualAsrCtcModelConfig();
        private OfflineMedAsrCtcModelConfig medasr = new OfflineMedAsrCtcModelConfig();
        private OfflineFunAsrNanoModelConfig funasrNano = new OfflineFunAsrNanoModelConfig();
        private OfflineQwen3AsrModelConfig qwen3Asr = new OfflineQwen3AsrModelConfig();
        private OfflineFireRedAsrCtcModelConfig fireRedAsrCtc = new OfflineFireRedAsrCtcModelConfig();
        private OfflineCanaryModelConfig canary = new OfflineCanaryModelConfig();
        private OfflineCohereTranscribeModelConfig cohereTranscribe = new OfflineCohereTranscribeModelConfig();
        private String teleSpeech = "";
        private int numThreads = 1;
        private boolean debug = false;
        private String provider = "cpu";
        private String modelType = "";
        private String tokens = "";
        private String modelingUnit = "";
        private String bpeVocab = "";

        public Builder setMoonshine(OfflineMoonshineModelConfig moonshine) {
            this.moonshine = moonshine;
            return this;
        }

        public Builder setTokens(String tokens) {
            this.tokens = tokens;
            return this;
        }

        public Builder setNumThreads(int numThreads) {
            this.numThreads = numThreads;
            return this;
        }

        public Builder setProvider(String provider) {
            this.provider = provider;
            return this;
        }

        public Builder setModelType(String modelType) {
            this.modelType = modelType;
            return this;
        }

        public OfflineModelConfig build() {
            return new OfflineModelConfig(this);
        }
    }
}

class OfflineTransducerModelConfig {
    private final String encoder = "";
    private final String decoder = "";
    private final String joiner = "";
}

class OfflineParaformerModelConfig {
    private final String model = "";
    private final QnnConfig qnnConfig = new QnnConfig();
}

class OfflineWhisperModelConfig {
    private final String encoder = "";
    private final String decoder = "";
    private final String language = "en";
    private final String task = "transcribe";
    private final int tailPaddings = 1000;
    private final boolean enableTokenTimestamps = false;
    private final boolean enableSegmentTimestamps = false;
}

class OfflineFireRedAsrModelConfig {
    private final String encoder = "";
    private final String decoder = "";
}

class OfflineNemoEncDecCtcModelConfig {
    private final String model = "";
}

class OfflineSenseVoiceModelConfig {
    private final String model = "";
    private final String language = "";
    private final boolean useInverseTextNormalization = true;
    private final QnnConfig qnnConfig = new QnnConfig();
}

class OfflineDolphinModelConfig {
    private final String model = "";
}

class OfflineZipformerCtcModelConfig {
    private final String model = "";
    private final QnnConfig qnnConfig = new QnnConfig();
}

class OfflineWenetCtcModelConfig {
    private final String model = "";
}

class OfflineOmnilingualAsrCtcModelConfig {
    private final String model = "";
}

class OfflineMedAsrCtcModelConfig {
    private final String model = "";
}

class OfflineFunAsrNanoModelConfig {
    private final String encoderAdaptor = "";
    private final String llm = "";
    private final String embedding = "";
    private final String tokenizer = "";
    private final String systemPrompt = "You are a helpful assistant.";
    private final String userPrompt = "Speech transcription:";
    private final int maxNewTokens = 512;
    private final float temperature = 1e-6f;
    private final float topP = 0.8f;
    private final int seed = 42;
    private final String language = "";
    private final boolean itn = true;
    private final String hotwords = "";
}

class OfflineQwen3AsrModelConfig {
    private final String convFrontend = "";
    private final String encoder = "";
    private final String decoder = "";
    private final String tokenizer = "";
    private final int maxTotalLen = 512;
    private final int maxNewTokens = 128;
    private final float temperature = 1e-6f;
    private final float topP = 0.8f;
    private final int seed = 42;
    private final String hotwords = "";
}

class OfflineFireRedAsrCtcModelConfig {
    private final String model = "";
}

class OfflineCanaryModelConfig {
    private final String encoder = "";
    private final String decoder = "";
    private final String srcLang = "en";
    private final String tgtLang = "en";
    private final boolean usePnc = true;
}

class OfflineCohereTranscribeModelConfig {
    private final String encoder = "";
    private final String decoder = "";
    private final String language = "";
    private final boolean usePunct = true;
    private final boolean useItn = true;
}
