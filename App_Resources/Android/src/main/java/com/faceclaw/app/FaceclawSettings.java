package com.faceclaw.app;

import android.content.Context;
import android.util.AtomicFile;
import org.json.JSONObject;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import java.util.concurrent.CopyOnWriteArrayList;

/**
 * App settings store shared by every JS isolate (main thread and app
 * workers). JSONC encoding, typed values and migrations live in the shared
 * Kotlin SettingsDocument. This adapter serializes access and commits atomically.
 *
 * Change notifications: each isolate registers one listener from its own
 * thread. The registering thread's Looper is captured, and notifications are
 * posted through it so the JS callback always runs on the isolate's own
 * thread (calling into an isolate from a foreign thread is not allowed).
 * NativeScript worker threads run a message loop, so both the main thread
 * and workers have a Looper; a listener registered from a Looper-less thread
 * is accepted but never notified (it can still read fresh values on demand).
 */
public final class FaceclawSettings {
    private static final String TAG = "FaceclawSettings";
    private static final String PREFS_NAME = "faceclaw_settings";
    private static volatile FaceclawSettings instance;

    private final AtomicFile file;
    private SettingsDocument document;
    private final CopyOnWriteArrayList<ListenerEntry> listeners = new CopyOnWriteArrayList<>();

    private static final class ListenerEntry {
        final FaceclawSettingsListener listener;
        final Handler handler;

        ListenerEntry(FaceclawSettingsListener listener, Handler handler) {
            this.listener = listener;
            this.handler = handler;
        }
    }

    private FaceclawSettings(Context context) {
        this.file = new AtomicFile(configFile(context));
        try {
            // AtomicFile also recovers an interrupted write before we consider XML.
            if (file.getBaseFile().exists() || new File(file.getBaseFile() + ".bak").exists()) {
                String original = new String(file.readFully(), StandardCharsets.UTF_8);
                document = decode(original);
                // Persist a migration, but preserve comments on already-current files.
                if (new SettingsCodec().needsMigration(original)) persist(document);
            } else {
                JSONObject legacy = new JSONObject(context.getApplicationContext()
                        .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).getAll());
                // These keys were still stored through NativeScript's separate preferences.
                for (java.util.Map.Entry<String, ?> entry : context.getSharedPreferences("prefs.db", Context.MODE_PRIVATE).getAll().entrySet()) {
                    String key = entry.getKey();
                    if (key.startsWith("deviceAddress.") || key.startsWith("deviceIdentity.") || key.startsWith("onboarding.") || key.startsWith("evenhub:")) {
                        Object value = entry.getValue();
                        if (key.equals("deviceIdentity.pairedAtMs") && value instanceof Long) value = Double.longBitsToDouble((Long) value);
                        if (!legacy.has(key)) legacy.put(key, value);
                    }
                }
                document = decode("{\"schema\":1,\"settings\":" + legacy + "}");
                persist(document); // Never delete the legacy XML.
            }
        } catch (Exception error) {
            throw new IllegalStateException("Could not load settings; original config retained", error);
        }
    }

    /** Initialize (idempotent) and return the singleton. */
    public static FaceclawSettings getInstance(Context context) {
        if (instance == null) {
            synchronized (FaceclawSettings.class) {
                if (instance == null) {
                    instance = new FaceclawSettings(context);
                }
            }
        }
        return instance;
    }

    /** Return the singleton; the main isolate must have initialized it first. */
    public static FaceclawSettings getInstance() {
        FaceclawSettings result = instance;
        if (result == null) {
            throw new IllegalStateException("FaceclawSettings not initialized; call getInstance(context) first");
        }
        return result;
    }

    public static File configFile(Context context) {
        return new File(context.getFilesDir(), "faceclaw_settings.jsonc");
    }

    private static SettingsDocument decode(String text) throws IOException {
        SettingsDocument value = new SettingsCodec().decode(text);
        if (value == null) throw new IOException("Invalid or unsupported Faceclaw settings config");
        return value;
    }

    private void persist(SettingsDocument next) throws IOException {
        String encoded = next.encodeForStorage();
        if (encoded == null) throw new IOException("Settings exceed format limits");
        FileOutputStream stream = null;
        try {
            stream = file.startWrite();
            stream.write(encoded.getBytes(StandardCharsets.UTF_8));
            file.finishWrite(stream);
        } catch (IOException error) {
            file.failWrite(stream);
            throw error;
        }
        document = next;
    }

    public synchronized String exportConfig() { return document.encode(); }

    public synchronized void importConfig(String text) throws IOException {
        SettingsDocument next = decode(text);
        AtomicFile backup = new AtomicFile(new File(file.getBaseFile() + ".previous"));
        FileOutputStream stream = backup.startWrite();
        try { stream.write(file.readFully()); backup.finishWrite(stream); }
        catch (IOException error) { backup.failWrite(stream); throw error; }
        persist(next);
    }

    public synchronized String getString(String key, String defaultValue) {
        return document.getString(key, defaultValue);
    }

    public synchronized void setString(String key, String value) {
        if (document.containsString(key, value)) return;
        try { persist(document.replacingString(key, value)); }
        catch (IOException error) { throw new IllegalStateException("Could not save settings", error); }
        notifyChanged(key);
    }

    public synchronized boolean getBoolean(String key, boolean defaultValue) {
        return document.getBoolean(key, defaultValue);
    }

    public synchronized void setBoolean(String key, boolean value) {
        if (document.getBoolean(key, !value) == value) return;
        try { persist(document.replacingBoolean(key, value)); }
        catch (IOException error) { throw new IllegalStateException("Could not save settings", error); }
        notifyChanged(key);
    }

    public synchronized double getNumber(String key, double fallback) { return document.getNumber(key, fallback); }
    public synchronized void setNumber(String key, double value) {
        if (!Double.isFinite(value)) throw new IllegalArgumentException("Non-finite setting");
        try { persist(document.replacingNumber(key, value)); }
        catch (IOException error) { throw new IllegalStateException("Could not save settings", error); }
        notifyChanged(key);
    }
    public synchronized void remove(String key) {
        try { persist(document.removing(key)); }
        catch (IOException error) { throw new IllegalStateException("Could not save settings", error); }
        notifyChanged(key);
    }

    /**
     * Register a change listener. Must be called from the thread whose
     * isolate owns the listener; that thread's Looper is captured for
     * dispatch.
     */
    public void registerListener(FaceclawSettingsListener listener) {
        Looper looper = Looper.myLooper();
        if (looper == null) {
            Log.w(TAG, "settings listener registered from a Looper-less thread; it will never be notified");
        }
        listeners.add(new ListenerEntry(listener, looper != null ? new Handler(looper) : null));
    }

    public void unregisterListener(FaceclawSettingsListener listener) {
        for (ListenerEntry entry : listeners) {
            if (entry.listener == listener) {
                listeners.remove(entry);
            }
        }
    }

    private void notifyChanged(String key) {
        for (ListenerEntry entry : listeners) {
            if (entry.handler == null) continue;
            entry.handler.post(() -> {
                try {
                    entry.listener.onSettingChanged(key);
                } catch (Exception e) {
                    Log.w(TAG, "settings listener failed for key " + key, e);
                }
            });
        }
    }
}
