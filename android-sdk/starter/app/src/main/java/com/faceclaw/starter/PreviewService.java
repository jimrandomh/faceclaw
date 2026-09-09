package com.faceclaw.starter;

import android.graphics.Bitmap;
import android.graphics.Canvas;
import com.faceclaw.sdk.FaceclawAppService;
import com.faceclaw.sdk.HostEvent;
import com.faceclaw.sdk.WindowState;

/** Small, benign preview window demonstrating the SDK lifecycle. */
public final class PreviewService extends FaceclawAppService {
    private static final String PREFS = "starter-settings";
    private static PreviewService active;
    private final WindowState window = new WindowState();
    private int clicks;

    @Override public void onCreate() {
        super.onCreate();
        active = this;
    }

    @Override protected void onHostConnected() {
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString("hostPackage", selectedHostPackage()).apply();
    }

    @Override protected void onHostEvent(HostEvent event) {
        window.accept(event);
        if (event instanceof HostEvent.Input && window.canDraw() && ((HostEvent.Input) event).isClick()) clicks++;
        drawPreview();
    }

    @Override protected void onHostDisconnected() {
        window.disconnect();
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
        if (!window.canDraw()) return;
        int width = window.width(), height = window.height();
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
