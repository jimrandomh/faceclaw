package com.faceclaw.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.VibrationEffect;
import android.os.Vibrator;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The ringing foreground service. One instance carries every item currently
 * ringing. Each item starts silent on the phone (a heads-up / lock-screen
 * notification only, the glasses do the ringing) and escalates to phone
 * sound and vibration when the glasses cannot carry it: not connected, not
 * on a head, charging, no delivery confirmation from the JS side within a
 * few seconds, or no acknowledgement within 30 seconds of delivery. Sound
 * uses the alarm stream, so media volume, the ringer switch and (unless set
 * to total silence) Do Not Disturb do not silence it.
 */
public class FaceclawAlarmService extends Service {
    public static final String CHANNEL_ID = "faceclaw-alarms";
    static final String ACTION_RING = "com.faceclaw.app.action.ALARM_RING";
    static final String ACTION_DELIVERED = "com.faceclaw.app.action.ALARM_DELIVERED";
    static final String ACTION_DISMISS = "com.faceclaw.app.action.ALARM_DISMISS";
    static final String ACTION_SNOOZE = "com.faceclaw.app.action.ALARM_SNOOZE";
    /** Stop an item quietly (acknowledged on the glasses / cancelled by the engine). */
    static final String ACTION_STOP_ITEM = "com.faceclaw.app.action.ALARM_STOP_ITEM";

    /** How long to wait for the JS side to confirm the glasses are showing the item. */
    static final long DELIVERY_WAIT_MS = 5_000L;
    /** How long after delivery to the glasses before the phone joins in. */
    static final long ACK_WAIT_MS = 30_000L;
    /** Sound and vibration stop after this; the notification stays. */
    static final long AUTO_SILENCE_MS = 10 * 60_000L;
    /** Alarm-stream level (fraction of max) used when the wearer has it muted. */
    static final float MUTED_VOLUME_FRACTION = 0.6f;

    static final class Ringing {
        final long id;
        final String title;
        final String text;
        final String kind;
        final int snoozeMinutes;
        final long ringAtMs;
        long deliveredAtMs;
        boolean escalated;
        boolean silenced;

        Ringing(long id, String title, String text, String kind, int snoozeMinutes) {
            this.id = id;
            this.title = title == null || title.trim().isEmpty() ? "Alarm" : title;
            this.text = text == null ? "" : text;
            this.kind = kind == null ? FaceclawAlarms.KIND_ALARM : kind;
            this.snoozeMinutes = Math.max(1, snoozeMinutes);
            this.ringAtMs = System.currentTimeMillis();
        }
    }

    /** Ringing items, oldest first; static so the activity can read them. */
    private static final Map<Long, Ringing> ringing = Collections.synchronizedMap(new LinkedHashMap<>());
    /**
     * Signals that arrived before the ring intent was processed (the JS
     * engine fires, launches its window and reports delivery on the same
     * main thread the service's onStartCommand queues behind), keyed by id
     * with their arrival time. Consumed by startRinging.
     */
    private static final Map<Long, Long> deliveredEarly = Collections.synchronizedMap(new LinkedHashMap<>());
    private static final Map<Long, Long> stoppedEarly = Collections.synchronizedMap(new LinkedHashMap<>());
    private static final long EARLY_SIGNAL_MAX_AGE_MS = 15_000L;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private MediaPlayer player;
    private Vibrator vibrator;
    private PowerManager.WakeLock wakeLock;
    private AudioManager audioManager;
    private AudioFocusRequest focusRequest;
    private int restoreAlarmVolume = -1;
    private long foregroundId;

    // ------------------------------------------------------------------
    // Static entry points

    public static void ring(Context context, long id, String title, String text, String kind, int snoozeMinutes) {
        Context appContext = context.getApplicationContext();
        Intent intent = new Intent(appContext, FaceclawAlarmService.class)
                .setAction(ACTION_RING)
                .putExtra(FaceclawAlarms.EXTRA_ID, id)
                .putExtra(FaceclawAlarms.EXTRA_TITLE, title)
                .putExtra(FaceclawAlarms.EXTRA_TEXT, text)
                .putExtra(FaceclawAlarms.EXTRA_KIND, kind)
                .putExtra(FaceclawAlarms.EXTRA_SNOOZE_MINUTES, snoozeMinutes);
        FaceclawAlarms.startServiceCompat(appContext, intent);
    }

    public static void delivered(Context context, long id) {
        if (!ringing.containsKey(id)) {
            deliveredEarly.put(id, System.currentTimeMillis());
            return;
        }
        Context appContext = context.getApplicationContext();
        appContext.startService(new Intent(appContext, FaceclawAlarmService.class)
                .setAction(ACTION_DELIVERED)
                .putExtra(FaceclawAlarms.EXTRA_ID, id));
    }

    public static void stopItem(Context context, long id) {
        if (!ringing.containsKey(id)) {
            stoppedEarly.put(id, System.currentTimeMillis());
            return;
        }
        Context appContext = context.getApplicationContext();
        appContext.startService(new Intent(appContext, FaceclawAlarmService.class)
                .setAction(ACTION_STOP_ITEM)
                .putExtra(FaceclawAlarms.EXTRA_ID, id));
    }

    public static boolean isRinging(long id) {
        return ringing.containsKey(id);
    }

    public static boolean isAnythingRinging() {
        return !ringing.isEmpty();
    }

    static List<Ringing> snapshot() {
        synchronized (ringing) {
            return new ArrayList<>(ringing.values());
        }
    }

    static PendingIntent actionIntent(Context appContext, String action, long id) {
        Intent intent = new Intent(appContext, FaceclawAlarmService.class)
                .setAction(action)
                .putExtra(FaceclawAlarms.EXTRA_ID, id);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        int code = FaceclawAlarms.requestCode(id) ^ action.hashCode();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            return PendingIntent.getForegroundService(appContext, code, intent, flags);
        }
        return PendingIntent.getService(appContext, code, intent, flags);
    }

    // ------------------------------------------------------------------
    // Service lifecycle

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();
        long id = intent == null ? 0 : intent.getLongExtra(FaceclawAlarms.EXTRA_ID, 0);
        if (action == null) {
            // Restarted by the system with nothing to do.
            finishIfIdle();
            return START_NOT_STICKY;
        }
        switch (action) {
            case ACTION_RING:
                startRinging(new Ringing(
                        id,
                        intent.getStringExtra(FaceclawAlarms.EXTRA_TITLE),
                        intent.getStringExtra(FaceclawAlarms.EXTRA_TEXT),
                        intent.getStringExtra(FaceclawAlarms.EXTRA_KIND),
                        intent.getIntExtra(FaceclawAlarms.EXTRA_SNOOZE_MINUTES, 10)
                ));
                break;
            case ACTION_DELIVERED:
                markDelivered(id);
                break;
            case ACTION_DISMISS:
                dismiss(id);
                break;
            case ACTION_SNOOZE:
                snooze(id);
                break;
            case ACTION_STOP_ITEM:
                stopItemQuietly(id, "acknowledged");
                break;
            default:
                break;
        }
        finishIfIdle();
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        stopSound();
        releaseWakeLock();
        super.onDestroy();
    }

    // ------------------------------------------------------------------
    // Ringing

    private void startRinging(Ringing item) {
        if (item.id == 0) {
            return;
        }
        ensureChannel();
        Ringing existing = ringing.get(item.id);
        if (existing != null) {
            // The engine's JS timeout and the AlarmManager alarm both fired: one ring.
            showNotification(existing);
            return;
        }
        if (takeEarlySignal(stoppedEarly, item.id)) {
            // Acknowledged or cancelled before this intent was processed.
            FaceclawAlarms.log(this, "ring " + item.id + " already acknowledged");
            return;
        }
        ringing.put(item.id, item);
        FaceclawAlarms.log(this, "ring " + item.kind + " " + item.id + " (" + FaceclawAlarms.glassesStatusDescription() + ")");
        acquireWakeLock();
        showNotification(item);
        if (!FaceclawAlarms.glassesCanCarryAlarm()) {
            escalate(item, FaceclawAlarms.glassesStatusDescription());
            return;
        }
        if (takeEarlySignal(deliveredEarly, item.id)) {
            markDelivered(item.id);
            return;
        }
        // The glasses could carry it: give the JS side a moment to confirm
        // they are actually showing it, then hold for the acknowledgement.
        handler.postDelayed(() -> {
            Ringing current = ringing.get(item.id);
            if (current != null && !current.escalated && current.deliveredAtMs == 0) {
                escalate(current, "not delivered to the glasses");
            }
        }, DELIVERY_WAIT_MS);
    }

    /** Consume an early signal for the id; stale entries are dropped. */
    private static boolean takeEarlySignal(Map<Long, Long> signals, long id) {
        Long at = signals.remove(id);
        long now = System.currentTimeMillis();
        synchronized (signals) {
            signals.values().removeIf(stamp -> now - stamp > EARLY_SIGNAL_MAX_AGE_MS);
        }
        return at != null && now - at <= EARLY_SIGNAL_MAX_AGE_MS;
    }

    private void markDelivered(long id) {
        Ringing item = ringing.get(id);
        if (item == null || item.deliveredAtMs != 0) {
            return;
        }
        item.deliveredAtMs = System.currentTimeMillis();
        FaceclawAlarms.log(this, "delivered " + id + " to glasses");
        handler.postDelayed(() -> {
            Ringing current = ringing.get(id);
            if (current != null && !current.escalated) {
                escalate(current, "not acknowledged on the glasses");
            }
        }, ACK_WAIT_MS);
    }

    private void escalate(Ringing item, String reason) {
        if (item.escalated) {
            return;
        }
        item.escalated = true;
        FaceclawAlarms.log(this, "phone sound for " + item.id + ": " + reason);
        showNotification(item);
        startSound();
        handler.postDelayed(() -> {
            Ringing current = ringing.get(item.id);
            if (current != null && current.escalated && !current.silenced) {
                current.silenced = true;
                FaceclawAlarms.log(this, "auto-silenced " + current.id);
                showNotification(current);
                syncSound();
            }
        }, AUTO_SILENCE_MS);
    }

    private void dismiss(long id) {
        Ringing item = ringing.get(id);
        if (item == null) {
            return;
        }
        FaceclawAlarms.recordPhoneAction(this, id, "dismiss", 0);
        removeItem(item);
        // Also drop the schedule entry (a one-off is over; the engine re-arms repeats).
        FaceclawAlarms.cancel(this, id);
    }

    private void snooze(long id) {
        Ringing item = ringing.get(id);
        if (item == null) {
            return;
        }
        int minutes = item.snoozeMinutes;
        FaceclawAlarms.recordPhoneAction(this, id, "snooze", minutes);
        removeItem(item);
        // Re-arm on the phone directly so the snooze holds even with the JS
        // side gone; the engine replays the journal and lands on the same id.
        FaceclawAlarms.schedule(
                this,
                id,
                System.currentTimeMillis() + minutes * 60_000L,
                item.title,
                item.text,
                item.kind,
                minutes
        );
    }

    private void stopItemQuietly(long id, String reason) {
        Ringing item = ringing.get(id);
        if (item == null) {
            return;
        }
        FaceclawAlarms.log(this, reason + " " + id);
        removeItem(item);
    }

    private void removeItem(Ringing item) {
        ringing.remove(item.id);
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) {
            manager.cancel(notificationId(item.id));
        }
        syncSound();
        if (item.id == foregroundId) {
            promoteAnotherToForeground();
        }
    }

    private void finishIfIdle() {
        if (!ringing.isEmpty()) {
            return;
        }
        handler.removeCallbacksAndMessages(null);
        stopSound();
        releaseWakeLock();
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    // ------------------------------------------------------------------
    // Notification (the phone's silent display of the alarm)

    private void showNotification(Ringing item) {
        Notification notification = buildNotification(item);
        if (foregroundId == 0 || foregroundId == item.id || !ringing.containsKey(foregroundId)) {
            foregroundId = item.id;
            startForegroundCompat(notificationId(item.id), notification);
        } else {
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.notify(notificationId(item.id), notification);
            }
        }
    }

    private void promoteAnotherToForeground() {
        List<Ringing> items = snapshot();
        if (items.isEmpty()) {
            foregroundId = 0;
            return;
        }
        Ringing next = items.get(0);
        foregroundId = next.id;
        startForegroundCompat(notificationId(next.id), buildNotification(next));
    }

    private void startForegroundCompat(int id, Notification notification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(id, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        } else {
            startForeground(id, notification);
        }
    }

    private Notification buildNotification(Ringing item) {
        Intent activity = new Intent(this, FaceclawAlarmActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP)
                .putExtra(FaceclawAlarms.EXTRA_ID, item.id);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        PendingIntent open = PendingIntent.getActivity(this, FaceclawAlarms.requestCode(item.id), activity, flags);

        String status;
        if (item.silenced) {
            status = "Not answered";
        } else if (item.escalated) {
            status = "Ringing";
        } else {
            status = "Ringing on the glasses";
        }
        String text = item.text.isEmpty() ? status : item.text + " · " + status;

        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this).setPriority(Notification.PRIORITY_MAX);
        builder.setContentTitle(item.title)
                .setContentText(text)
                .setSmallIcon(getApplicationInfo().icon)
                .setContentIntent(open)
                .setFullScreenIntent(open, true)
                .setCategory(Notification.CATEGORY_ALARM)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setOngoing(true)
                .setAutoCancel(false)
                .setOnlyAlertOnce(true)
                .setWhen(item.ringAtMs)
                .setShowWhen(true)
                .addAction(new Notification.Action.Builder(
                        null,
                        FaceclawAlarms.KIND_TIMER.equals(item.kind) ? "+" + item.snoozeMinutes + " min" : "Snooze " + item.snoozeMinutes + " min",
                        actionIntent(this, ACTION_SNOOZE, item.id)).build())
                .addAction(new Notification.Action.Builder(
                        null,
                        "Dismiss",
                        actionIntent(this, ACTION_DISMISS, item.id)).build());
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            // Pre-channel: the builder controls sound, and we want none.
            builder.setSound(null).setVibrate(null);
        }
        return builder.build();
    }

    private void ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) {
            return;
        }
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "Alarms", NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription("Timers and alarms going off. Silent here: the sound is played by the alarm itself.");
        // The service plays the sound itself (on the alarm stream) so the
        // notification stays silent and vibration-free on purpose.
        channel.setSound(null, null);
        channel.enableVibration(false);
        channel.setBypassDnd(true);
        channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        manager.createNotificationChannel(channel);
    }

    private static int notificationId(long id) {
        return 0x41000000 | (FaceclawAlarms.requestCode(id) & 0x00ffffff);
    }

    // ------------------------------------------------------------------
    // Sound and vibration (only while some item is escalated and not yet silenced)

    private void syncSound() {
        boolean wanted = false;
        for (Ringing item : snapshot()) {
            if (item.escalated && !item.silenced) {
                wanted = true;
                break;
            }
        }
        if (wanted) {
            startSound();
        } else {
            stopSound();
        }
    }

    private void startSound() {
        if (player != null) {
            return;
        }
        audioManager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        AudioAttributes attributes = new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ALARM)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build();
        raiseMutedAlarmVolume();
        requestAudioFocus(attributes);
        Uri tone = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM);
        if (tone == null) {
            tone = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
        }
        try {
            MediaPlayer created = new MediaPlayer();
            created.setAudioAttributes(attributes);
            created.setDataSource(this, tone);
            created.setLooping(true);
            created.prepare();
            created.start();
            player = created;
        } catch (Exception error) {
            FaceclawAlarms.log(this, "alarm sound failed: " + error.getMessage());
            player = null;
        }
        startVibration();
    }

    private void stopSound() {
        if (player != null) {
            try {
                player.stop();
            } catch (RuntimeException ignored) {
                // Already stopped.
            }
            player.release();
            player = null;
        }
        if (vibrator != null) {
            vibrator.cancel();
            vibrator = null;
        }
        abandonAudioFocus();
        restoreAlarmVolume();
    }

    /**
     * A muted alarm stream is the one thing that would keep an alarm clock
     * silent; raise it for the duration of the ring and put it back after.
     */
    private void raiseMutedAlarmVolume() {
        if (audioManager == null) {
            return;
        }
        try {
            int current = audioManager.getStreamVolume(AudioManager.STREAM_ALARM);
            int max = audioManager.getStreamMaxVolume(AudioManager.STREAM_ALARM);
            if (current == 0 && max > 0) {
                restoreAlarmVolume = current;
                audioManager.setStreamVolume(AudioManager.STREAM_ALARM, Math.max(1, Math.round(max * MUTED_VOLUME_FRACTION)), 0);
            }
        } catch (RuntimeException error) {
            FaceclawAlarms.log(this, "alarm volume change failed: " + error.getMessage());
        }
    }

    private void restoreAlarmVolume() {
        if (audioManager == null || restoreAlarmVolume < 0) {
            return;
        }
        try {
            audioManager.setStreamVolume(AudioManager.STREAM_ALARM, restoreAlarmVolume, 0);
        } catch (RuntimeException ignored) {
            // Best effort.
        }
        restoreAlarmVolume = -1;
    }

    private void requestAudioFocus(AudioAttributes attributes) {
        if (audioManager == null) {
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            focusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                    .setAudioAttributes(attributes)
                    .build();
            audioManager.requestAudioFocus(focusRequest);
        } else {
            audioManager.requestAudioFocus(null, AudioManager.STREAM_ALARM, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT);
        }
    }

    private void abandonAudioFocus() {
        if (audioManager == null) {
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (focusRequest != null) {
                audioManager.abandonAudioFocusRequest(focusRequest);
                focusRequest = null;
            }
        } else {
            audioManager.abandonAudioFocus(null);
        }
    }

    private void startVibration() {
        Vibrator device = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
        if (device == null || !device.hasVibrator()) {
            return;
        }
        vibrator = device;
        long[] pattern = {0, 600, 400, 600, 1200};
        AudioAttributes attributes = new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ALARM)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build();
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                device.vibrate(VibrationEffect.createWaveform(pattern, 0), attributes);
            } else {
                device.vibrate(pattern, 0, attributes);
            }
        } catch (RuntimeException error) {
            FaceclawAlarms.log(this, "vibration failed: " + error.getMessage());
        }
    }

    // ------------------------------------------------------------------
    // Wake lock

    private void acquireWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) {
            return;
        }
        PowerManager power = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (power == null) {
            return;
        }
        wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "faceclaw:alarm");
        // Bounded: sound auto-silences at AUTO_SILENCE_MS, and a stuck lock
        // past that would only drain the battery.
        wakeLock.acquire(AUTO_SILENCE_MS + ACK_WAIT_MS + DELIVERY_WAIT_MS + 10_000L);
    }

    private void releaseWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) {
            wakeLock.release();
        }
        wakeLock = null;
    }
}
