package com.faceclaw.app

interface FaceclawBleListener {
    fun onNotification(address: String?, characteristicUuid: String?, data: ByteArray?): Unit

    fun onConnectionStateChange(address: String?, connected: Boolean): Unit
}
