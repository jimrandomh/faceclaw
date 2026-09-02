package com.faceclaw.app;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.media.AudioManager;
import android.media.MediaDescription;
import android.media.MediaMetadata;
import android.media.session.MediaController;
import android.media.session.MediaSession;
import android.media.session.MediaSessionManager;
import android.media.session.PlaybackState;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.Settings;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.List;

public class FaceclawMediaController {
    private final Context appContext;
    private final Object lock = new Object();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final ComponentName listenerComponent;
    private final MediaSessionManager sessionManager;
    private final AudioManager audioManager;

    private final MediaController.Callback controllerCallback = new MediaController.Callback() {
        @Override
        public void onPlaybackStateChanged(PlaybackState state) {
            synchronized (lock) {
                emitStateLocked();
            }
        }

        @Override
        public void onMetadataChanged(MediaMetadata metadata) {
            synchronized (lock) {
                emitStateLocked();
            }
        }

        @Override
        public void onQueueChanged(List<MediaSession.QueueItem> queue) {
            synchronized (lock) {
                emitStateLocked();
            }
        }

        @Override
        public void onSessionDestroyed() {
            synchronized (lock) {
                refreshActiveControllerLocked(null);
            }
        }
    };

    private final MediaSessionManager.OnActiveSessionsChangedListener sessionsChangedListener = controllers -> {
        synchronized (lock) {
            refreshActiveControllerLocked(controllers);
        }
    };

    private volatile FaceclawMediaControllerListener listener;
    private MediaController activeController;
    private boolean started;

    public FaceclawMediaController(Context context) {
        this.appContext = context.getApplicationContext();
        this.listenerComponent = new ComponentName(appContext, FaceclawMediaNotificationListenerService.class);
        this.sessionManager = (MediaSessionManager) appContext.getSystemService(Context.MEDIA_SESSION_SERVICE);
        this.audioManager = (AudioManager) appContext.getSystemService(Context.AUDIO_SERVICE);
    }

    public void setListener(FaceclawMediaControllerListener listener) {
        synchronized (lock) {
            this.listener = listener;
            emitStateLocked();
        }
    }

    public void start() {
        synchronized (lock) {
            if (started) {
                emitStateLocked();
                return;
            }
            started = true;
            if (!isNotificationAccessEnabled()) {
                emitStateLocked();
                return;
            }
            if (sessionManager != null) {
                try {
                    sessionManager.addOnActiveSessionsChangedListener(
                            sessionsChangedListener,
                            listenerComponent,
                            mainHandler
                    );
                } catch (SecurityException ignored) {
                    emitStateLocked();
                    return;
                }
            }
            refreshActiveControllerLocked(null);
        }
    }

    public void stop() {
        synchronized (lock) {
            if (!started) {
                return;
            }
            started = false;
            if (sessionManager != null) {
                try {
                    sessionManager.removeOnActiveSessionsChangedListener(sessionsChangedListener);
                } catch (SecurityException ignored) {
                }
            }
            setActiveControllerLocked(null);
            emitStateLocked();
        }
    }

    public void playPause() {
        synchronized (lock) {
            if (activeController == null) {
                return;
            }
            PlaybackState playbackState = activeController.getPlaybackState();
            MediaController.TransportControls controls = activeController.getTransportControls();
            if (playbackState == null) {
                controls.play();
                return;
            }
            switch (playbackState.getState()) {
                case PlaybackState.STATE_PLAYING:
                case PlaybackState.STATE_BUFFERING:
                case PlaybackState.STATE_CONNECTING:
                    controls.pause();
                    return;
                default:
                    controls.play();
            }
        }
    }

    public void skipNext() {
        synchronized (lock) {
            if (activeController != null) {
                activeController.getTransportControls().skipToNext();
            }
        }
    }

    public void skipPrevious() {
        synchronized (lock) {
            if (activeController != null) {
                activeController.getTransportControls().skipToPrevious();
            }
        }
    }

    public void skipToQueueItem(long queueId) {
        synchronized (lock) {
            if (activeController != null) {
                activeController.getTransportControls().skipToQueueItem(queueId);
            }
        }
    }

    /** Current phone media-stream volume normalized to the range 0..100. */
    public int getMediaVolumePercent() {
        if (audioManager == null) {
            return -1;
        }
        int maxVolume = audioManager.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
        if (maxVolume <= 0) {
            return 0;
        }
        int currentVolume = audioManager.getStreamVolume(AudioManager.STREAM_MUSIC);
        return Math.max(0, Math.min(100, Math.round(currentVolume * 100f / maxVolume)));
    }

    /** Set the phone media-stream volume from a normalized 0..100 value. */
    public void setMediaVolumePercent(int volumePercent) {
        if (audioManager == null) {
            return;
        }
        int clampedPercent = Math.max(0, Math.min(100, volumePercent));
        int maxVolume = audioManager.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
        int streamVolume = Math.round(clampedPercent * maxVolume / 100f);
        audioManager.setStreamVolume(AudioManager.STREAM_MUSIC, streamVolume, 0);
    }

    /**
     * Album art for the active session's current item, grayscale, scaled to
     * fit within maxSize x maxSize preserving aspect. Returns a gray packet
     * (see ImageFileLoader.bitmapToGrayPacket) or an empty array when no art
     * is available. gamma and dither are the photographic tone handling
     * described on ImageFileLoader.bitmapToGrayPacket; the TS side passes
     * its shared photo preset.
     */
    public byte[] getAlbumArtGray(int maxSize, float gamma, boolean dither) {
        Bitmap art;
        synchronized (lock) {
            if (activeController == null) {
                return new byte[0];
            }
            MediaMetadata metadata = activeController.getMetadata();
            if (metadata == null) {
                return new byte[0];
            }
            art = metadata.getBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART);
            if (art == null) {
                art = metadata.getBitmap(MediaMetadata.METADATA_KEY_ART);
            }
            if (art == null) {
                art = metadata.getBitmap(MediaMetadata.METADATA_KEY_DISPLAY_ICON);
            }
        }
        return ImageFileLoader.bitmapToGrayPacket(art, maxSize, maxSize, gamma, dither);
    }

    /**
     * The active session's queue (playlist) as JSON:
     * [{"id": long, "title": string, "active": bool}, ...]. Empty string when
     * the player exposes no queue.
     */
    public String getQueueJson() {
        synchronized (lock) {
            if (activeController == null) {
                return "";
            }
            List<MediaSession.QueueItem> queue = activeController.getQueue();
            if (queue == null || queue.isEmpty()) {
                return "";
            }
            PlaybackState state = activeController.getPlaybackState();
            long activeId = state == null ? -1 : state.getActiveQueueItemId();
            try {
                JSONArray out = new JSONArray();
                for (MediaSession.QueueItem item : queue) {
                    MediaDescription description = item.getDescription();
                    CharSequence title = description == null ? null : description.getTitle();
                    JSONObject entry = new JSONObject();
                    entry.put("id", item.getQueueId());
                    entry.put("title", title == null ? "" : title.toString());
                    entry.put("active", item.getQueueId() == activeId);
                    out.put(entry);
                }
                return out.toString();
            } catch (Exception e) {
                Log.w("FaceclawMedia", "queue serialization failed", e);
                return "";
            }
        }
    }

    public void openNotificationAccessSettings() {
        Intent intent = new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        appContext.startActivity(intent);
    }

    private void refreshActiveControllerLocked(List<MediaController> controllers) {
        if (!started) {
            setActiveControllerLocked(null);
            emitStateLocked();
            return;
        }
        if (!isNotificationAccessEnabled()) {
            setActiveControllerLocked(null);
            emitStateLocked();
            return;
        }
        if (controllers == null && sessionManager != null) {
            try {
                controllers = sessionManager.getActiveSessions(listenerComponent);
            } catch (SecurityException ignored) {
                controllers = null;
            }
        }
        setActiveControllerLocked(chooseController(controllers));
        emitStateLocked();
    }

    private MediaController chooseController(List<MediaController> controllers) {
        if (controllers == null || controllers.isEmpty()) {
            return null;
        }
        MediaController first = controllers.get(0);
        for (MediaController controller : controllers) {
            PlaybackState playbackState = controller.getPlaybackState();
            if (playbackState != null && playbackState.getState() == PlaybackState.STATE_PLAYING) {
                return controller;
            }
        }
        return first;
    }

    private void setActiveControllerLocked(MediaController controller) {
        if (sameController(activeController, controller)) {
            return;
        }
        if (activeController != null) {
            activeController.unregisterCallback(controllerCallback);
        }
        activeController = controller;
        if (activeController != null) {
            activeController.registerCallback(controllerCallback, mainHandler);
        }
    }

    private boolean sameController(MediaController a, MediaController b) {
        if (a == b) {
            return true;
        }
        if (a == null || b == null) {
            return false;
        }
        return a.getSessionToken().equals(b.getSessionToken());
    }

    private boolean isNotificationAccessEnabled() {
        String enabledListeners = Settings.Secure.getString(
                appContext.getContentResolver(),
                "enabled_notification_listeners"
        );
        if (enabledListeners == null || enabledListeners.isEmpty()) {
            return false;
        }
        String fullName = listenerComponent.flattenToString();
        String shortName = listenerComponent.flattenToShortString();
        return enabledListeners.contains(fullName)
                || enabledListeners.contains(shortName)
                || enabledListeners.contains(appContext.getPackageName());
    }

    private void emitStateLocked() {
        FaceclawMediaControllerListener currentListener = listener;
        if (currentListener == null) {
            return;
        }

        String playbackState = started ? "idle" : "stopped";
        String packageName = "";
        String appName = "";
        String title = "";
        String artist = "";
        String album = "";
        long positionMs = -1L;
        long durationMs = -1L;
        float playbackSpeed = 0f;
        boolean canPlayPause = false;
        boolean canSkipNext = false;
        boolean canSkipPrevious = false;
        boolean accessEnabled = isNotificationAccessEnabled();
        String status;

        if (!accessEnabled) {
            playbackState = "notification-access-required";
            status = "Notification access required.";
        } else if (activeController == null) {
            status = "No active media session.";
        } else {
            packageName = safe(activeController.getPackageName());
            appName = getApplicationLabel(packageName);
            PlaybackState state = activeController.getPlaybackState();
            MediaMetadata metadata = activeController.getMetadata();
            playbackState = playbackStateName(state);
            if (metadata != null) {
                title = safe(metadata.getString(MediaMetadata.METADATA_KEY_TITLE));
                artist = safe(metadata.getString(MediaMetadata.METADATA_KEY_ARTIST));
                album = safe(metadata.getString(MediaMetadata.METADATA_KEY_ALBUM));
                durationMs = metadata.getLong(MediaMetadata.METADATA_KEY_DURATION);
                if (durationMs <= 0L) {
                    durationMs = -1L;
                }
            }
            if (state != null) {
                positionMs = estimatedPositionMs(state, durationMs);
                playbackSpeed = state.getPlaybackSpeed();
            }
            long actions = state == null ? 0L : state.getActions();
            canPlayPause = (actions & PlaybackState.ACTION_PLAY_PAUSE) != 0
                    || (actions & PlaybackState.ACTION_PLAY) != 0
                    || (actions & PlaybackState.ACTION_PAUSE) != 0;
            canSkipNext = (actions & PlaybackState.ACTION_SKIP_TO_NEXT) != 0;
            canSkipPrevious = (actions & PlaybackState.ACTION_SKIP_TO_PREVIOUS) != 0;
            status = packageName.isEmpty() ? "Active media session." : "Active session: " + packageName;
        }

        final String finalPlaybackState = playbackState;
        final String finalPackageName = packageName;
        final String finalAppName = appName;
        final String finalTitle = title;
        final String finalArtist = artist;
        final String finalAlbum = album;
        final long finalPositionMs = positionMs;
        final long finalDurationMs = durationMs;
        final float finalPlaybackSpeed = playbackSpeed;
        final boolean finalCanPlayPause = canPlayPause;
        final boolean finalCanSkipNext = canSkipNext;
        final boolean finalCanSkipPrevious = canSkipPrevious;
        final boolean finalAccessEnabled = accessEnabled;
        final String finalStatus = status;

        mainHandler.post(() -> currentListener.onStateChange(
                finalPlaybackState,
                finalPackageName,
                finalAppName,
                finalTitle,
                finalArtist,
                finalAlbum,
                finalPositionMs,
                finalDurationMs,
                finalPlaybackSpeed,
                finalCanPlayPause,
                finalCanSkipNext,
                finalCanSkipPrevious,
                finalAccessEnabled,
                finalStatus
        ));
    }

    private String playbackStateName(PlaybackState state) {
        if (state == null) {
            return "idle";
        }
        switch (state.getState()) {
            case PlaybackState.STATE_PLAYING:
                return "playing";
            case PlaybackState.STATE_PAUSED:
                return "paused";
            case PlaybackState.STATE_BUFFERING:
            case PlaybackState.STATE_CONNECTING:
                return "buffering";
            case PlaybackState.STATE_STOPPED:
                return "stopped";
            default:
                return "idle";
        }
    }

    /** PlaybackState positions are snapshots; advance a playing snapshot to now. */
    private long estimatedPositionMs(PlaybackState state, long durationMs) {
        long positionMs = state.getPosition();
        if (positionMs == PlaybackState.PLAYBACK_POSITION_UNKNOWN) {
            return -1L;
        }
        if (state.getState() == PlaybackState.STATE_PLAYING) {
            long updatedAtMs = state.getLastPositionUpdateTime();
            if (updatedAtMs > 0L) {
                positionMs += (long) ((SystemClock.elapsedRealtime() - updatedAtMs) * state.getPlaybackSpeed());
            }
        }
        positionMs = Math.max(0L, positionMs);
        return durationMs > 0L ? Math.min(positionMs, durationMs) : positionMs;
    }

    /** Resolve a media session's package id to the user-facing installed app name. */
    private String getApplicationLabel(String packageName) {
        if (packageName == null || packageName.isEmpty()) {
            return "";
        }
        PackageManager packageManager = appContext.getPackageManager();
        try {
            ApplicationInfo applicationInfo = packageManager.getApplicationInfo(packageName, 0);
            CharSequence label = packageManager.getApplicationLabel(applicationInfo);
            if (label != null && label.length() > 0) {
                return label.toString();
            }
        } catch (PackageManager.NameNotFoundException ignored) {
        }
        return packageName;
    }

    private String safe(String value) {
        return value == null ? "" : value;
    }
}
