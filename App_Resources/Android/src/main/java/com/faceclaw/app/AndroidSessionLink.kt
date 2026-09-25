package com.faceclaw.app

import android.bluetooth.BluetoothGatt

/** [SessionLink] over the Android GATT boundary ([FaceclawBleManager]). */
class AndroidSessionLink(private val bleManager: FaceclawBleManager) : SessionLink {
    override fun connect(address: String, timeoutMs: Int): Boolean = bleManager.connect(address, timeoutMs)

    override fun requestHighPriority(address: String) {
        bleManager.requestConnectionPriority(address, BluetoothGatt.CONNECTION_PRIORITY_HIGH)
    }

    override fun requestMtu(address: String, mtu: Int, timeoutMs: Int): Boolean =
        bleManager.requestMtu(address, mtu, timeoutMs)

    override fun negotiatedMtu(address: String): Int = bleManager.getNegotiatedMtu(address)

    override fun discoverServices(address: String, timeoutMs: Int): Boolean =
        bleManager.discoverServices(address, timeoutMs)

    override fun enableNotifications(address: String, characteristicUuid: String, enable: Boolean, timeoutMs: Int): Boolean =
        bleManager.enableNotifications(address, characteristicUuid, enable, timeoutMs)

    override fun writeFrames(
        address: String,
        characteristicUuid: String,
        frames: List<ByteArray>,
        mode: GattWriteMode,
        timeoutMs: Int,
    ): Boolean = bleManager.writeFrames(address, characteristicUuid, frames, AndroidProtocolPlatform.writeType(mode), timeoutMs)

    override fun disconnect(address: String) = bleManager.disconnect(address)

    override fun close() = bleManager.close()

    override fun isBonded(address: String): Boolean = bleManager.isBonded(address)

    override fun prepareBenchmarkLink(address: String, mode: Int) = bleManager.prepareBenchmarkLink(address, mode)

    override fun recordDisplayFrameSent() = FaceclawBleManager.recordDisplayFrameSent()
}
