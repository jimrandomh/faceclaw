package com.k2fsa.sherpa.onnx;

public class EndpointConfig {
    private final EndpointRule rule1;
    private final EndpointRule rule2;
    private final EndpointRule rule3;

    private EndpointConfig(Builder builder) {
        this.rule1 = builder.rule1;
        this.rule2 = builder.rule2;
        this.rule3 = builder.rule3;
    }

    public static Builder builder() {
        return new Builder();
    }

    public EndpointRule getRule1() {
        return rule1;
    }

    public EndpointRule getRule2() {
        return rule2;
    }

    public EndpointRule getRule3() {
        return rule3;
    }

    public static class Builder {
        private EndpointRule rule1 = EndpointRule.builder()
                .setMustContainNonSilence(false)
                .setMinTrailingSilence(2.4f)
                .setMinUtteranceLength(0.0f)
                .build();
        private EndpointRule rule2 = EndpointRule.builder()
                .setMustContainNonSilence(true)
                .setMinTrailingSilence(1.2f)
                .setMinUtteranceLength(0.0f)
                .build();
        private EndpointRule rule3 = EndpointRule.builder()
                .setMustContainNonSilence(false)
                .setMinTrailingSilence(0.0f)
                .setMinUtteranceLength(20.0f)
                .build();

        public Builder setRule1(EndpointRule rule1) {
            this.rule1 = rule1;
            return this;
        }

        public Builder setRule2(EndpointRule rule2) {
            this.rule2 = rule2;
            return this;
        }

        public Builder setRule3(EndpointRule rule3) {
            this.rule3 = rule3;
            return this;
        }

        public EndpointConfig build() {
            return new EndpointConfig(this);
        }
    }
}
