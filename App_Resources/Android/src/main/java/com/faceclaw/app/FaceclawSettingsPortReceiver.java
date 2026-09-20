package com.faceclaw.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import java.nio.charset.StandardCharsets;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;

/** adb-only JSONC config transfer, guarded by android.permission.DUMP.
 * Files are staged in the external app directory and removed after transfer.
 */
public class FaceclawSettingsPortReceiver extends BroadcastReceiver {
    private static final String TAG = "FaceclawSettingsPort";
    public static final String ACTION_EXPORT = "com.faceclaw.app.SETTINGS_EXPORT";
    public static final String ACTION_IMPORT = "com.faceclaw.app.SETTINGS_IMPORT";
    private static final String EXPORT_NAME = "faceclaw-settings-export.jsonc";
    private static final String IMPORT_NAME = "faceclaw-settings-import.jsonc";

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent == null ? null : intent.getAction();
        try {
            if (ACTION_EXPORT.equals(action)) {
                setResultData(exportSettings(context));
            } else if (ACTION_IMPORT.equals(action)) {
                setResultData(importSettings(context));
                // Exit once the broadcast result has been delivered: this
                // app components may cache derived settings; restart them
                // against the imported document.
                new Handler(Looper.getMainLooper()).postDelayed(() -> {
                    Log.i(TAG, "Exiting after settings import");
                    System.exit(0);
                }, 500);
            }
        } catch (Exception e) {
            Log.e(TAG, "Settings " + action + " failed", e);
            setResultData("error: " + e);
        }
    }

    private File externalFile(Context context, String name) throws IOException {
        File dir = context.getExternalFilesDir(null);
        if (dir == null) {
            throw new IOException("external files dir unavailable");
        }
        return new File(dir, name);
    }

    private String exportSettings(Context context) throws IOException {
        String config = FaceclawSettings.getInstance(context).exportConfig();
        File out = externalFile(context, EXPORT_NAME);
        try (OutputStream stream = new FileOutputStream(out)) {
            stream.write(config.getBytes(StandardCharsets.UTF_8));
        }
        return "exported: " + out;
    }

    private String importSettings(Context context) throws Exception {
        File staged = externalFile(context, IMPORT_NAME);
        if (!staged.exists() || staged.length() > 2 * 1024 * 1024) {
            throw new IOException("Missing or oversized staged config");
        }
        try {
            byte[] data = new byte[(int) staged.length()];
            try (java.io.DataInputStream in = new java.io.DataInputStream(new FileInputStream(staged))) {
                in.readFully(data);
            }
            FaceclawSettings.getInstance(context).importConfig(new String(data, StandardCharsets.UTF_8));
        } finally { staged.delete(); }
        return "imported: " + FaceclawSettings.configFile(context) + " (previous settings in .previous)";
    }
}
