package com.faceclaw.app

interface FaceclawNotificationListener {
    fun onNotificationPosted(key: String?): Unit
    fun onNotificationRemoved(key: String?): Unit
}
