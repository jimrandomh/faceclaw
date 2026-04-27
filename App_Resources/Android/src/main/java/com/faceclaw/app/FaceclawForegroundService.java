package com.faceclaw.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;

import com.tns.NativeScriptActivity;

public class FaceclawForegroundService extends Service {
    public static final String ACTION_START = "com.faceclaw.app.action.START";
    public static final String ACTION_UPDATE = "com.faceclaw.app.action.UPDATE";
    public static final String ACTION_STOP = "com.faceclaw.app.action.STOP";
    public static final String EXTRA_TEXT = "text";

    private static final String CHANNEL_ID = "faceclaw-dashboard";
    private static final int NOTIFICATION_ID = 4201;

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : ACTION_START;
        String text = intent != null ? intent.getStringExtra(EXTRA_TEXT) : null;

        if (ACTION_STOP.equals(action)) {
            stopForeground(STOP_FOREGROUND_REMOVE);
            stopSelf();
            return START_NOT_STICKY;
        }

        ensureNotificationChannel();
        Notification notification = buildNotification(
                text != null && !text.trim().isEmpty() ? text : "Keeping the dashboard connected"
        );

        startForeground(NOTIFICATION_ID, notification);

        if (ACTION_UPDATE.equals(action)) {
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.notify(NOTIFICATION_ID, notification);
            }
        }

        return START_STICKY;
    }

    private void ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }

        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "Faceclaw dashboard",
                NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("Keeps the Faceclaw dashboard connected to the glasses.");

        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) {
            manager.createNotificationChannel(channel);
        }
    }

    private Notification buildNotification(String text) {
        Intent launchIntent = new Intent(this, NativeScriptActivity.class);
        launchIntent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);

        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }

        PendingIntent contentIntent = PendingIntent.getActivity(this, 0, launchIntent, flags);

        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);

        return builder
                .setContentTitle("faceclaw dashboard")
                .setContentText(text)
                .setSmallIcon(getApplicationInfo().icon)
                .setContentIntent(contentIntent)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .build();
    }
}
