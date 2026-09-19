package com.faceclaw.app;

import android.content.Context;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * Saves screenshots of the composited screen as 4-bit grayscale PNGs (the
 * display's native depth). Retrieve with
 *   adb pull /sdcard/Android/data/com.faceclaw.app/files/screenshots/
 */
public final class ScreenshotUtil {
    private ScreenshotUtil() {}

    /** Returns the absolute path of the written file. */
    public static String savePngScreenshot(Context context, byte[] gray, int width, int height) throws IOException {
        if (gray == null || width <= 0 || height <= 0 || gray.length < width * height) {
            throw new IllegalArgumentException("invalid screenshot buffer");
        }
        byte[] png = SharedScreenshots.encode4BitGrayPng(gray, width, height);
        File file = new File(ensureScreenshotsDir(context), "screen-" + timestamp() + ".png");
        try (FileOutputStream out = new FileOutputStream(file)) {
            out.write(png);
        }
        return file.getAbsolutePath();
    }

    static File ensureScreenshotsDir(Context context) throws IOException {
        File dir = new File(context.getExternalFilesDir(null), "screenshots");
        if (!dir.exists() && !dir.mkdirs()) {
            throw new IOException("failed to create " + dir);
        }
        return dir;
    }

    static String timestamp() {
        return new SimpleDateFormat("yyyyMMdd-HHmmss-SSS", Locale.US).format(new Date());
    }

}
