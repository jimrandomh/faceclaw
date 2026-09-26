package com.faceclaw.app

interface FaceclawAudioPacketListener {
    fun onAudioPacket(data: ByteArray?, arm: String?, arrivalMs: Long): Unit
}
