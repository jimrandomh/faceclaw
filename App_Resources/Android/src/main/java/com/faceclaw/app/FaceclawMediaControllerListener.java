package com.faceclaw.app;

public interface FaceclawMediaControllerListener {
    void onStateChange(
            String playbackState,
            String packageName,
            String title,
            String artist,
            String album,
            boolean canPlayPause,
            boolean canSkipNext,
            boolean canSkipPrevious,
            boolean accessEnabled,
            String status
    );
}
