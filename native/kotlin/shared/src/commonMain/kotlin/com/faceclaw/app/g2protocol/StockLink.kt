package com.faceclaw.app

import kotlin.jvm.JvmField

/** Android bond state of a peripheral; iOS reports UNKNOWN (pairing is invisible to the app). */
enum class BondState {
    NONE,
    BONDING,
    BONDED,
    UNKNOWN,
}

/** Inbound side of a [StockLink]; called on whatever thread the platform stack delivers on. */
interface StockLinkListener {
    fun onNotification(address: String, characteristicUuid: String, data: ByteArray)

    fun onConnectionStateChange(address: String, connected: Boolean)
}

/**
 * The GATT boundary used by the stock-firmware flows (device-info probe, flash prompt, OTA
 * flasher). Calls block on the caller's thread with explicit timeouts; addresses are opaque
 * strings (Android MAC, iOS peripheral identifier). Android wraps FaceclawBleManager; an iOS
 * implementation sits on CoreBluetooth. Methods other than [isConnected]/[bondState]/
 * [disconnect]/[close] may throw IllegalStateException when the link is not connected.
 */
interface StockLink {
    fun setListener(listener: StockLinkListener?)

    fun connect(address: String, timeoutMs: Int): Boolean

    /** Best-effort link tuning after connect (connection priority, MTU). */
    fun prepareLink(address: String, desiredMtu: Int, timeoutMs: Int)

    fun discoverServices(address: String, timeoutMs: Int): Boolean

    fun enableNotifications(address: String, characteristicUuid: String, timeoutMs: Int): Boolean

    fun writeFrames(
        address: String,
        characteristicUuid: String,
        frames: List<ByteArray>,
        mode: GattWriteMode,
        timeoutMs: Int,
    ): Boolean

    fun isConnected(address: String): Boolean

    fun bondState(address: String): BondState

    fun disconnect(address: String)

    fun close()
}

/** A wait for a lens reply expired. */
class StockTimeoutException(message: String) : Exception(message)

/**
 * Timeouts and pacing shared by the stock flows. Production uses the defaults; tests shrink
 * them. Values are milliseconds unless named otherwise.
 */
class StockFlowTimings(
    @JvmField val connectTimeoutMs: Int = ConnectionOptions.CONNECT_TIMEOUT_MS,
    @JvmField val servicesTimeoutMs: Int = ConnectionOptions.SERVICES_TIMEOUT_MS,
    @JvmField val descriptorTimeoutMs: Int = ConnectionOptions.DESCRIPTOR_TIMEOUT_MS,
    @JvmField val writeTimeoutMs: Int = ConnectionOptions.WRITE_TIMEOUT_MS,
    @JvmField val preludeTimeoutMs: Int = ConnectionOptions.PRELUDE_TIMEOUT_MS,
    @JvmField val securityAuthTimeoutMs: Int = ConnectionOptions.SECURITY_AUTH_TIMEOUT_MS,
    @JvmField val securityAuthSoftTimeoutMs: Int = ConnectionOptions.SECURITY_AUTH_SOFT_TIMEOUT_MS,
    /** Upper bound on waiting while the OS reports pairing in progress (a dialog may be up). */
    @JvmField val pairingWaitCapMs: Int = 90_000,
    /** After a fresh bond, how long the firmware gets to notify success before the auth request is re-sent. */
    @JvmField val postBondGraceMs: Int = 2_000,
    @JvmField val pollMs: Int = 250,
    /** Delay between connect/auth attempts on one arm and between auth re-sends. */
    @JvmField val armRetryDelayMs: Int = 1_000,
    @JvmField val queryTimeoutMs: Int = 4_000,
    @JvmField val heartbeatIntervalMs: Int = 4_000,
    @JvmField val selectionTimeoutMs: Int = 120_000,
    @JvmField val createAckTimeoutMs: Int = 3_000,
    @JvmField val batteryAckTimeoutMs: Int = 3_000,
    @JvmField val blockAckTimeoutMs: Int = 4_000,
    @JvmField val ctrlAckTimeoutMs: Int = 8_000,
    @JvmField val firstLensConnectWindowMs: Int = 30_000,
    @JvmField val secondLensConnectWindowMs: Int = 120_000,
    @JvmField val rebootSettleMs: Int = 5_000,
    @JvmField val notifySettleMs: Int = 2_500,
    @JvmField val otaRetryDelayMs: Int = 2_500,
    @JvmField val componentRetryDelayMs: Int = 1_500,
)
