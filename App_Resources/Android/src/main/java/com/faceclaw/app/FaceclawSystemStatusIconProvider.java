package com.faceclaw.app;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.wifi.WifiInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.telephony.SignalStrength;
import android.telephony.TelephonyManager;
import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.lang.reflect.Method;

public final class FaceclawSystemStatusIconProvider {
    private static final String TAG = "FaceclawStatusIcons";
    private static final int ICON_SIZE = 24;

    private FaceclawSystemStatusIconProvider() {
    }

    public static byte[] getSystemStatusIconGrays(Context context, int iconSize) {
        if (context == null) {
            return new byte[0];
        }
        Context appContext = context.getApplicationContext();
        int size = Math.max(1, Math.min(96, iconSize));
        ByteArrayOutputStream out = new ByteArrayOutputStream(size * size * 3);

        int wifiLevel = getWifiLevel(appContext);
        if (wifiLevel >= 0) {
            append(out, scaleIcon(drawWifiIcon(wifiLevel), size));
        }

        int cellLevel = getCellLevel(appContext);
        if (cellLevel >= 0) {
            append(out, scaleIcon(drawCellIcon(cellLevel), size));
        }

        if (isHotspotEnabled(appContext)) {
            append(out, scaleIcon(drawHotspotIcon(), size));
        }

        return out.toByteArray();
    }

    private static int getWifiLevel(Context context) {
        try {
            ConnectivityManager connectivityManager = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
            Network activeNetwork = connectivityManager == null ? null : connectivityManager.getActiveNetwork();
            NetworkCapabilities capabilities = activeNetwork == null ? null : connectivityManager.getNetworkCapabilities(activeNetwork);
            if (capabilities == null || !capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) {
                return -1;
            }
            WifiManager wifiManager = (WifiManager) context.getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            WifiInfo info = wifiManager == null ? null : wifiManager.getConnectionInfo();
            if (info == null || !isValidRssi(info.getRssi())) {
                return -1;
            }
            return Math.max(0, Math.min(4, WifiManager.calculateSignalLevel(info.getRssi(), 5)));
        } catch (Throwable t) {
            Log.w(TAG, "failed to read Wi-Fi status", t);
            return -1;
        }
    }

    private static int getCellLevel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) {
            return -1;
        }
        try {
            TelephonyManager telephonyManager = (TelephonyManager) context.getSystemService(Context.TELEPHONY_SERVICE);
            SignalStrength signalStrength = telephonyManager == null ? null : telephonyManager.getSignalStrength();
            if (signalStrength == null) {
                return -1;
            }
            return Math.max(0, Math.min(4, signalStrength.getLevel()));
        } catch (SecurityException e) {
            // Most Android versions require READ_PHONE_STATE for this. We skip it
            // rather than prompting for a broad phone permission just for an icon.
            return -1;
        } catch (Throwable t) {
            Log.w(TAG, "failed to read cellular status", t);
            return -1;
        }
    }

    private static boolean isHotspotEnabled(Context context) {
        try {
            WifiManager wifiManager = (WifiManager) context.getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wifiManager == null) {
                return false;
            }
            Method method = wifiManager.getClass().getDeclaredMethod("getWifiApState");
            method.setAccessible(true);
            Object result = method.invoke(wifiManager);
            int state = result instanceof Integer ? (Integer) result : -1;
            return state == 13 || state == 12; // WIFI_AP_STATE_ENABLED / ENABLING
        } catch (Throwable ignored) {
            return false;
        }
    }

    private static boolean isValidRssi(int rssi) {
        return rssi > -127 && rssi < 0;
    }

    private static byte[] drawWifiIcon(int level) {
        byte[] icon = new byte[ICON_SIZE * ICON_SIZE];
        int cx = 12;
        int cy = 18;
        fillRect(icon, cx - 1, cy - 1, 3, 3, 230);
        int[] radii = new int[] {5, 9, 13, 17};
        for (int index = 0; index < radii.length; index++) {
            if (level <= index) {
                continue;
            }
            drawWifiArc(icon, cx, cy, radii[index], 210);
        }
        return icon;
    }

    private static void drawWifiArc(byte[] icon, int cx, int cy, int radius, int value) {
        int inner = (radius - 1) * (radius - 1);
        int outer = (radius + 1) * (radius + 1);
        for (int y = 0; y < ICON_SIZE; y++) {
            for (int x = 0; x < ICON_SIZE; x++) {
                int dx = x - cx;
                int dy = y - cy;
                int dist = dx * dx + dy * dy;
                if (dy <= 0 && dist >= inner && dist <= outer && Math.abs(dx) <= radius) {
                    setPixel(icon, x, y, value);
                }
            }
        }
    }

    private static byte[] drawCellIcon(int level) {
        byte[] icon = new byte[ICON_SIZE * ICON_SIZE];
        for (int bar = 0; bar < 4; bar++) {
            int x = 5 + bar * 4;
            int height = 5 + bar * 4;
            int value = level > bar ? 220 : 55;
            fillRect(icon, x, 20 - height, 3, height, value);
        }
        return icon;
    }

    private static byte[] drawHotspotIcon() {
        byte[] icon = new byte[ICON_SIZE * ICON_SIZE];
        fillRect(icon, 11, 17, 3, 3, 230);
        drawWifiArc(icon, 12, 19, 7, 210);
        drawWifiArc(icon, 12, 19, 12, 210);
        fillRect(icon, 6, 5, 12, 2, 170);
        return icon;
    }

    private static byte[] scaleIcon(byte[] source, int size) {
        if (size == ICON_SIZE) {
            return source;
        }
        byte[] scaled = new byte[size * size];
        for (int y = 0; y < size; y++) {
            int sy = Math.min(ICON_SIZE - 1, (y * ICON_SIZE) / size);
            for (int x = 0; x < size; x++) {
                int sx = Math.min(ICON_SIZE - 1, (x * ICON_SIZE) / size);
                scaled[y * size + x] = source[sy * ICON_SIZE + sx];
            }
        }
        return scaled;
    }

    private static void fillRect(byte[] icon, int x, int y, int width, int height, int value) {
        for (int row = y; row < y + height; row++) {
            for (int col = x; col < x + width; col++) {
                setPixel(icon, col, row, value);
            }
        }
    }

    private static void setPixel(byte[] icon, int x, int y, int value) {
        if (x < 0 || y < 0 || x >= ICON_SIZE || y >= ICON_SIZE) {
            return;
        }
        icon[y * ICON_SIZE + x] = (byte) Math.max(0, Math.min(255, value));
    }

    private static void append(ByteArrayOutputStream out, byte[] bytes) {
        out.write(bytes, 0, bytes.length);
    }
}
