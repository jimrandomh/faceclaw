package com.faceclaw.app;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

import androidx.core.content.ContextCompat;

import com.tns.NativeScriptActivity;

public class FaceclawForegroundService extends Service {
    public static final String ACTION_START = "com.faceclaw.app.action.START";
    public static final String ACTION_UPDATE = "com.faceclaw.app.action.UPDATE";
    public static final String ACTION_STOP = "com.faceclaw.app.action.STOP";
    public static final String EXTRA_TEXT = "text";

    // Channel id was bumped from "faceclaw-dashboard" when the badge setting
    // changed: Android freezes a channel's showBadge flag at creation, so the
    // old channel (which let Samsung's launcher count the pinned notification
    // as a red "1" badge) is deleted on upgrade rather than reused.
    private static final String LEGACY_CHANNEL_ID = "faceclaw-dashboard";
    private static final String CHANNEL_ID = "faceclaw-connection";
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
                text != null && !text.trim().isEmpty() ? text : "Connected to glasses"
        );

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, foregroundServiceType());
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }

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
                "Glasses connection",
                NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("Keeps Faceclaw connected to the glasses.");
        // The pinned status notification must not count toward the launcher
        // icon's notification badge.
        channel.setShowBadge(false);

        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) {
            manager.createNotificationChannel(channel);
            manager.deleteNotificationChannel(LEGACY_CHANNEL_ID);
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
                .setContentTitle("Faceclaw")
                .setContentText(text)
                .setSmallIcon(getApplicationInfo().icon)
                .setContentIntent(contentIntent)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .build();
    }

    private int foregroundServiceType() {
        int type = ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE;
        // TODO: Make this depend on which audio path (G2 vs phone) is selected
        if (hasRecordAudioPermission()) {
            type |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
        }
        // The location type keeps while-in-use location flowing to the
        // Navigate app when the phone screen locks. Only claimed once the
        // permission exists: on API 34+ claiming it without the permission
        // makes startForeground throw.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && hasFineLocationPermission()) {
            type |= ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION;
        }
        return type;
    }

    private boolean hasRecordAudioPermission() {
        return ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
                == PackageManager.PERMISSION_GRANTED;
    }

    private boolean hasFineLocationPermission() {
        return ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION)
                == PackageManager.PERMISSION_GRANTED;
    }
}
