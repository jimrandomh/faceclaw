package com.faceclaw.app;

/** Receives stock compass heading and calibration notifications on the thread that subscribed. */
public interface FaceclawCompassListener {
    void onCompassEvent(int command, int headingDegrees);
}
