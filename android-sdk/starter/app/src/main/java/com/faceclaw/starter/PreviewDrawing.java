package com.faceclaw.starter;

import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import com.faceclaw.sdk.Ui;

/** The phone preview and glasses share the same app-owned drawing code. */
final class PreviewDrawing {
    static void draw(Canvas canvas, int width, int height, int clicks, boolean markerVisible) {
        canvas.drawColor(Color.BLACK);
        Ui.card(canvas, 10, 10, width - 10, height - 10, 8, Color.rgb(28, 28, 28));
        Ui.text(canvas, "Faceclaw APK", 24, 40, 18, Color.WHITE);
        Ui.text(canvas, "Starter preview", 24, 68, 14, Color.LTGRAY);
        Ui.text(canvas, "Clicks: " + clicks, 24, 94, 14, Color.WHITE);
        if (markerVisible) {
            Paint marker = new Paint(Paint.ANTI_ALIAS_FLAG);
            marker.setColor(Color.WHITE);
            canvas.drawCircle(width - 30, height - 30, 10, marker);
        }
    }
    private PreviewDrawing() {}
}
