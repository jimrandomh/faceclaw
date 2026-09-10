package com.faceclaw.app;

/** Phone-side alarm actions (dismiss / snooze), delivered to the JS engine; implemented in JS. */
public interface FaceclawAlarmListener {
    void onPhoneAction(long id, String action, int minutes);
}
