package com.faceclaw.starter;

import android.graphics.Bitmap;
import android.graphics.Canvas;
import com.faceclaw.sdk.FaceclawAppService;
import org.json.JSONObject;

/** Small, benign preview window demonstrating the SDK lifecycle. */
public final class PreviewService extends FaceclawAppService {
    private static final String PREFS = "starter-settings";
    private static PreviewService active;
    private int width;
    private int height;
    private boolean visible;
    private boolean screenOn;
    private int clicks;

    @Override public void onCreate() {
        super.onCreate();
        active = this;
    }

    @Override protected void onHostConnected() {
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString("hostPackage", selectedHostPackage()).apply();
    }

    @Override protected void onHostEvent(String type, JSONObject data) {
        if ("open".equals(type) || "resize".equals(type)) {
            width = data.optInt("width", 0);
            height = data.optInt("height", 0);
        } else if ("visibility".equals(type)) {
            visible = data.optBoolean("visible", false);
            screenOn = data.optBoolean("screenOn", false);
        } else if ("input".equals(type) && "click".equals(data.optString("type", ""))) {
            clicks++;
        } else if ("close".equals(type)) {
            visible = false;
        }
        drawPreview();
    }

    @Override protected void onHostDisconnected() {
        visible = false;
        width = 0;
        height = 0;
    }

    @Override public void onDestroy() {
        if (active == this) active = null;
        super.onDestroy();
    }

    static void refreshFromSettings() {
        if (active != null) active.drawPreview();
    }

    static String savedHostStatus(android.content.Context context) {
        if (active != null && !active.extensionsCompatibility().equals("disconnected")) {
            return "Connected to " + active.selectedHostLabel();
        }
        String previous = savedHostPackage(context);
        return previous.isEmpty() ? "No host selected" : "Disconnected. Last selected: " + previous;
    }

    static String savedHostPackage(android.content.Context context) {
        return context.getSharedPreferences(PREFS, MODE_PRIVATE).getString("hostPackage", "");
    }

    private void drawPreview() {
        if (!visible || !screenOn || width <= 0 || height <= 0) return;
        Bitmap frame = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
        try {
            PreviewDrawing.draw(new Canvas(frame), width, height, clicks,
                    getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean("showMarker", true));
            submitBitmap(frame);
        } finally {
            frame.recycle();
        }
    }
}
