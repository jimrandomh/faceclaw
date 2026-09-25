package com.faceclaw.app

import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.content.Context

/**
 * Android [StockLink]: a 1:1 wrapper over FaceclawBleManager for the stock-firmware flows
 * (device-info probe, flash prompt, OTA flasher). Owns its own GATT manager, exactly as each
 * flow did before the shared cores existed.
 */
class AndroidStockLink(context: Context) : StockLink, FaceclawBleListener {
    private val bleManager = FaceclawBleManager(context.applicationContext)

    @Volatile
    private var listener: StockLinkListener? = null

    init {
        bleManager.setListener(this)
    }

    override fun setListener(listener: StockLinkListener?) {
        this.listener = listener
    }

    override fun connect(address: String, timeoutMs: Int): Boolean = bleManager.connect(address, timeoutMs)

    override fun prepareLink(address: String, desiredMtu: Int, timeoutMs: Int) {
        bleManager.requestConnectionPriority(address, BluetoothGatt.CONNECTION_PRIORITY_HIGH)
        bleManager.requestMtu(address, desiredMtu, timeoutMs)
    }

    override fun discoverServices(address: String, timeoutMs: Int): Boolean = bleManager.discoverServices(address, timeoutMs)

    override fun enableNotifications(address: String, characteristicUuid: String, timeoutMs: Int): Boolean =
        bleManager.enableNotifications(address, characteristicUuid, true, timeoutMs)

    override fun writeFrames(address: String, characteristicUuid: String, frames: List<ByteArray>, mode: GattWriteMode, timeoutMs: Int): Boolean =
        bleManager.writeFrames(address, characteristicUuid, frames, AndroidProtocolPlatform.writeType(mode), timeoutMs)

    override fun isConnected(address: String): Boolean = bleManager.isConnected(address)

    override fun bondState(address: String): BondState =
        when (bleManager.getBondState(address)) {
            BluetoothDevice.BOND_NONE -> BondState.NONE
            BluetoothDevice.BOND_BONDING -> BondState.BONDING
            BluetoothDevice.BOND_BONDED -> BondState.BONDED
            else -> BondState.UNKNOWN
        }

    override fun disconnect(address: String) = bleManager.disconnect(address)

    override fun close() = bleManager.close()

    override fun onNotification(address: String?, characteristicUuid: String?, data: ByteArray?) {
        if (address == null || characteristicUuid == null || data == null) return
        listener?.onNotification(address, characteristicUuid, data)
    }

    override fun onConnectionStateChange(address: String?, connected: Boolean) {
        if (address == null) return
        listener?.onConnectionStateChange(address, connected)
    }
}
