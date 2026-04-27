package com.faceclaw.app;

public interface FaceclawBleListener {
    void onNotification(String address, String characteristicUuid, byte[] data);
    void onConnectionStateChange(String address, boolean connected);
}
