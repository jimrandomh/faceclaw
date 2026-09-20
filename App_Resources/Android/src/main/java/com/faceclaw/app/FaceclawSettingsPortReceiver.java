package com.faceclaw.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.util.Xml;

import org.xmlpull.v1.XmlPullParser;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * adb-triggered export/import of the faceclaw_settings SharedPreferences
 * file, so configuration (API keys, device addresses, ...) can be moved off a
 * release build, where run-as is unavailable. See scripts/pull_config.sh and
 * scripts/push_config.sh, which use run-as on debuggable builds and fall back
 * to this receiver otherwise.
 *
 *   adb shell am broadcast -n com.faceclaw.app/.FaceclawSettingsPortReceiver \
 *       -a com.faceclaw.app.SETTINGS_EXPORT
 *   adb pull /sdcard/Android/data/com.faceclaw.app/files/faceclaw-settings-export.xml
 *
 *   adb push settings.xml /sdcard/Android/data/com.faceclaw.app/files/faceclaw-settings-import.xml
 *   adb shell am broadcast -n com.faceclaw.app/.FaceclawSettingsPortReceiver \
 *       -a com.faceclaw.app.SETTINGS_IMPORT
 *
 * Security: the settings file contains API tokens, so the manifest guards
 * this receiver with android.permission.DUMP — a development permission the
 * adb shell holds but ordinary apps cannot obtain without adb's help, keeping
 * the trigger reachable from adb only. The transfer file lives in
 * getExternalFilesDir(), which other apps cannot read on Android 11+ (and
 * which the scripts delete as soon as the transfer completes); on the
 * Android 7-10 devices minSdk still admits, apps holding READ_EXTERNAL_STORAGE
 * could read it during that window.
 */
public class FaceclawSettingsPortReceiver extends BroadcastReceiver {
    private static final String TAG = "FaceclawSettingsPort";
    public static final String ACTION_EXPORT = "com.faceclaw.app.SETTINGS_EXPORT";
    public static final String ACTION_IMPORT = "com.faceclaw.app.SETTINGS_IMPORT";
    private static final String PREFS_FILE = "faceclaw_settings.xml";
    private static final String EXPORT_NAME = "faceclaw-settings-export.xml";
    private static final String IMPORT_NAME = "faceclaw-settings-import.xml";

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent == null ? null : intent.getAction();
        try {
            if (ACTION_EXPORT.equals(action)) {
                setResultData(exportSettings(context));
            } else if (ACTION_IMPORT.equals(action)) {
                setResultData(importSettings(context));
                // Exit once the broadcast result has been delivered: this
                // process may hold stale in-memory SharedPreferences that a
                // later apply() would flush over the imported file, and the
                // next launch must re-read from disk.
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

    private File prefsFile(Context context) {
        return new File(context.getApplicationInfo().dataDir, "shared_prefs/" + PREFS_FILE);
    }

    private File externalFile(Context context, String name) throws IOException {
        File dir = context.getExternalFilesDir(null);
        if (dir == null) {
            throw new IOException("external files dir unavailable");
        }
        return new File(dir, name);
    }

    private String exportSettings(Context context) throws IOException {
        File prefs = prefsFile(context);
        if (!prefs.exists()) {
            return "error: no settings file yet (" + prefs + ")";
        }
        File out = externalFile(context, EXPORT_NAME);
        copy(prefs, out);
        return "exported: " + out;
    }

    private String importSettings(Context context) throws Exception {
        File staged = externalFile(context, IMPORT_NAME);
        if (!staged.exists()) {
            return "error: nothing staged at " + staged;
        }
        validatePrefsXml(staged);
        File prefs = prefsFile(context);
        prefs.getParentFile().mkdirs();
        if (prefs.exists()) {
            copy(prefs, new File(prefs.getPath() + ".bak"));
        }
        copy(staged, prefs);
        staged.delete();
        return "imported: " + prefs + " (previous settings in " + PREFS_FILE + ".bak)";
    }

    /** Reject files that are not a SharedPreferences <map> document. */
    private void validatePrefsXml(File file) throws Exception {
        try (InputStream in = new FileInputStream(file)) {
            XmlPullParser parser = Xml.newPullParser();
            parser.setInput(in, null);
            int event = parser.next();
            while (event != XmlPullParser.START_TAG && event != XmlPullParser.END_DOCUMENT) {
                event = parser.next();
            }
            if (event != XmlPullParser.START_TAG || !"map".equals(parser.getName())) {
                throw new IOException("not a SharedPreferences <map> document");
            }
            // Walk the rest so malformed XML is caught before it replaces
            // the live settings file.
            while (parser.next() != XmlPullParser.END_DOCUMENT) { }
        }
    }

    private void copy(File from, File to) throws IOException {
        try (InputStream in = new FileInputStream(from);
             OutputStream out = new FileOutputStream(to)) {
            byte[] buffer = new byte[8192];
            int n;
            while ((n = in.read(buffer)) > 0) {
                out.write(buffer, 0, n);
            }
        }
    }
}
