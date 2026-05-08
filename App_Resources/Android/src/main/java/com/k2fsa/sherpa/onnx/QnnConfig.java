package com.k2fsa.sherpa.onnx;

public class QnnConfig {
    private final String backendLib;
    private final String contextBinary;
    private final String systemLib;

    public QnnConfig() {
        this.backendLib = "";
        this.contextBinary = "";
        this.systemLib = "";
    }
}
