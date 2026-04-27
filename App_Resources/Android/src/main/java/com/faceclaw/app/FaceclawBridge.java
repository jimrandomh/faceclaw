package com.faceclaw.app;

import android.os.Looper;

public class FaceclawBridge {
    public static String ping(String value) {
        return "java-ping:" + value;
    }

    public static String currentThreadName() {
        return Thread.currentThread().getName();
    }

    public static boolean isMainThread() {
        return Looper.getMainLooper().isCurrentThread();
    }

    public int add(int a, int b) {
        return a + b;
    }

    public String describeEnvironment() {
        return "thread=" + currentThreadName() + " main=" + isMainThread();
    }

    public String runCallback(String label, Runnable callback) {
        callback.run();
        return "java-callback-complete:" + label;
    }
}
