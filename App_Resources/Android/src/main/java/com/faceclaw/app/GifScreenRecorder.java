package com.faceclaw.app;

import android.content.Context;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;

/** Android storage adapter for the shared GIF recorder. */
public final class GifScreenRecorder {
    private final SharedGifScreenRecorder recorder = new SharedGifScreenRecorder();

    public void addFrame(byte[] gray, int width, int height, long timestampMs) {
        recorder.addFrame(gray, width, height, timestampMs);
    }

    public boolean isOverflowed() { return recorder.isOverflowed(); }

    public String save(Context context) throws IOException {
        byte[] gif = recorder.encode();
        if (gif.length == 0) return "";
        File file = new File(ScreenshotUtil.ensureScreenshotsDir(context),
                "recording-" + ScreenshotUtil.timestamp() + ".gif");
        try (FileOutputStream out = new FileOutputStream(file)) { out.write(gif); }
        return file.getAbsolutePath();
    }
}
