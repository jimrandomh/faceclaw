package com.faceclaw.app

/** Change-notification callback for FaceclawSettings; implemented in JS. */
interface FaceclawSettingsListener {
    fun onSettingChanged(key: String?): Unit
}
