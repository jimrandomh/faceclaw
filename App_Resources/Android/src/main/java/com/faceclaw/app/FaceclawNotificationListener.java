package com.faceclaw.app;

public interface FaceclawNotificationListener {
    void onNotificationPosted(String key);
    // Must be abstract: NativeScript does not override default interface methods.
    void onNotificationRemoved(String key);
    void onNotificationsChanged();
}
