package com.faceclaw.app

/** Phone-side alarm actions (dismiss / snooze), delivered to the JS engine; implemented in JS. */
interface FaceclawAlarmListener {
    fun onPhoneAction(id: Long, action: String?, minutes: Int): Unit
}
