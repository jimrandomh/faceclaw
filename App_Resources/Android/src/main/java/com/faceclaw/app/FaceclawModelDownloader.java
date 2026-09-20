package com.faceclaw.app;

import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.security.MessageDigest;
import java.util.concurrent.TimeUnit;

import okhttp3.Call;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;

/**
 * Large-file downloader for on-phone model weights (multi-GB, from Hugging
 * Face). Downloads to "<dest>.part" with HTTP Range resume across app
 * restarts, verifies a pinned sha256 (hashed incrementally, including the
 * resumed prefix), then renames into place. Listener callbacks are posted to
 * the constructing thread's Looper, like the other Faceclaw bridges.
 */
public class FaceclawModelDownloader {
    private static final String TAG = "FaceclawModelDl";
    private static final long PROGRESS_INTERVAL_MS = 500;

    private static volatile OkHttpClient sharedClient;

    private final Handler callbackHandler;
    private final String url;
    private final File destFile;
    private final File partFile;
    private final String expectedSha256;
    private final long expectedTotalBytes;
    private final FaceclawModelDownloaderListener listener;

    private volatile boolean cancelled;
    private volatile Call call;
    private Thread worker;

    public FaceclawModelDownloader(String url, String destPath, String expectedSha256,
                                   long expectedTotalBytes, FaceclawModelDownloaderListener listener) {
        if (listener == null) throw new IllegalArgumentException("listener is required");
        Looper looper = Looper.myLooper();
        this.callbackHandler = new Handler(looper != null ? looper : Looper.getMainLooper());
        this.url = url;
        this.destFile = new File(destPath);
        this.partFile = new File(destPath + ".part");
        this.expectedSha256 = expectedSha256 == null ? "" : expectedSha256.toLowerCase();
        this.expectedTotalBytes = expectedTotalBytes;
        this.listener = listener;
    }

    private static OkHttpClient getClient() {
        if (sharedClient == null) {
            synchronized (FaceclawModelDownloader.class) {
                if (sharedClient == null) {
                    sharedClient = new OkHttpClient.Builder()
                        .connectTimeout(30, TimeUnit.SECONDS)
                        .readTimeout(60, TimeUnit.SECONDS)
                        .addInterceptor(FaceclawHttp.userAgentInterceptor())
                        .build();
                }
            }
        }
        return sharedClient;
    }

    public void start() {
        worker = new Thread(this::run, "FaceclawModelDl");
        worker.start();
    }

    /** Stops the download but keeps the .part file so a later start() resumes. */
    public void cancel() {
        cancelled = true;
        Call current = call;
        if (current != null) current.cancel();
    }

    private void run() {
        try {
            if (destFile.exists() && destFile.length() > 0) {
                post(() -> listener.onDone(destFile.getAbsolutePath()));
                return;
            }
            destFile.getParentFile().mkdirs();

            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            long offset = 0;
            if (partFile.exists()) {
                offset = hashExistingPrefix(digest);
                if (cancelled) return;
            }

            Request.Builder builder = new Request.Builder().url(url);
            if (offset > 0) builder.header("Range", "bytes=" + offset + "-");
            call = getClient().newCall(builder.build());

            try (Response response = call.execute()) {
                ResponseBody body = response.body();
                if (!response.isSuccessful() || body == null) {
                    postError("Model download failed: HTTP " + response.code());
                    return;
                }
                boolean resumed = response.code() == 206;
                if (offset > 0 && !resumed) {
                    // Server ignored the Range header; start over.
                    offset = 0;
                    digest = MessageDigest.getInstance("SHA-256");
                }
                long total = expectedTotalBytes > 0 ? expectedTotalBytes
                    : (body.contentLength() > 0 ? offset + body.contentLength() : -1);

                try (FileOutputStream out = new FileOutputStream(partFile, resumed);
                     InputStream in = body.byteStream()) {
                    byte[] buffer = new byte[1 << 16];
                    long done = offset;
                    long lastProgressAt = 0;
                    int read;
                    while ((read = in.read(buffer)) != -1) {
                        if (cancelled) return;
                        out.write(buffer, 0, read);
                        digest.update(buffer, 0, read);
                        done += read;
                        long now = System.currentTimeMillis();
                        if (now - lastProgressAt >= PROGRESS_INTERVAL_MS) {
                            lastProgressAt = now;
                            final long doneFinal = done;
                            final long totalFinal = total;
                            post(() -> listener.onProgress(doneFinal, totalFinal));
                        }
                    }
                }
            }

            if (expectedTotalBytes > 0 && partFile.length() != expectedTotalBytes) {
                postError("Model download ended early (" + partFile.length() + " of "
                    + expectedTotalBytes + " bytes); try again to resume");
                return;
            }
            String actualSha = FaceclawFirmwareUtil.bytesToHex(digest.digest());
            if (!expectedSha256.isEmpty() && !actualSha.equals(expectedSha256)) {
                partFile.delete();
                postError("Model download was corrupted (checksum mismatch); download it again");
                return;
            }
            if (!partFile.renameTo(destFile)) {
                postError("Could not move the downloaded model into place");
                return;
            }
            post(() -> listener.onDone(destFile.getAbsolutePath()));
        } catch (Exception e) {
            if (cancelled) return;
            Log.w(TAG, "download failed", e);
            postError("Model download failed: " + e);
        }
    }

    /** Hash the already-downloaded prefix so the final digest covers the whole file. */
    private long hashExistingPrefix(MessageDigest digest) throws IOException {
        long hashed = 0;
        try (FileInputStream in = new FileInputStream(partFile)) {
            byte[] buffer = new byte[1 << 16];
            int read;
            while ((read = in.read(buffer)) != -1) {
                if (cancelled) return hashed;
                digest.update(buffer, 0, read);
                hashed += read;
            }
        }
        return hashed;
    }

    private void post(Runnable runnable) {
        callbackHandler.post(runnable);
    }

    private void postError(final String message) {
        post(() -> listener.onError(message));
    }
}
