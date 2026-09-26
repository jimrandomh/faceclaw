package com.faceclaw.app

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.bluetooth.le.BluetoothLeScanner
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanRecord
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.SparseArray

import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

import java.util.ArrayList

/**
 * Finds Even Realities hardware over BLE and hands every advertisement up to
 * TypeScript with the raw fields the pairing screen needs: the LIVE local name
 * from the scan record (BluetoothDevice.getName() is a cache that can hold a
 * pre-reset value indefinitely), the full manufacturer-specific payload with
 * its company identifier restored so the "ER"+serial+MAC layout survives
 * intact, RSSI, advertised TX power, and connectability.
 *
 * Admission is deliberately loose — a name containing G2, the stock
 * "EVEN R1…" ring prefix, or the Even "ER" manufacturer signature — because
 * renamed custom firmware may drop the stock name. Side, serial, and pair
 * matching are decided in TypeScript (app/g2/even-advertisement.ts,
 * app/g2/pairing-candidates.ts) where they can be unit-tested; this filter
 * must stay a superset of the TS classifier's admission.
 */
@SuppressLint("MissingPermission")
class FaceclawDeviceDiscovery(context: Context) {
    companion object {
        /** Even Realities' company identifier: the ASCII bytes "ER" read little-endian. */
        const val EVEN_COMPANY_ID = 0x5245

        // ------------------------------------------------------------------
        // Internals
        // ------------------------------------------------------------------

        private fun buildScanSettings(): ScanSettings {
            val builder = ScanSettings.Builder()
                .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
                .setReportDelay(0)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                builder.setCallbackType(ScanSettings.CALLBACK_TYPE_ALL_MATCHES)
                builder.setMatchMode(ScanSettings.MATCH_MODE_AGGRESSIVE)
                builder.setNumOfMatches(ScanSettings.MATCH_NUM_MAX_ADVERTISEMENT)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                // Accept extended advertising too; setLegacy(true) would hide it.
                builder.setLegacy(false)
            }
            return builder.build()
        }

        /** Null when the result is not something we pair with. */
        private fun toJson(result: ScanResult): JSONObject? {
            val device = result.device ?: return null
            val record = result.scanRecord
            val liveName = record?.deviceName
            val name = if (liveName != null && !liveName.isEmpty()) liveName else device.name
            val manufacturerData = extractEvenManufacturerData(record)
            if (!isAdmissible(name, manufacturerData)) {
                return null
            }
            var txPower: Int? = null
            if (record != null && record.txPowerLevel != Int.MIN_VALUE) {
                txPower = record.txPowerLevel
            }
            if (txPower == null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                    && result.txPower != ScanResult.TX_POWER_NOT_PRESENT) {
                txPower = result.txPower
            }
            var connectable: Boolean? = null
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                connectable = result.isConnectable
            }
            val rssi = result.rssi
            // 127 is the "unavailable" sentinel; 0 dBm never happens for a real sample.
            val rssiValue: Int? = if (rssi == 127 || rssi == 0) null else rssi
            val bonded = device.bondState == BluetoothDevice.BOND_BONDED
            return buildJson(
                    device.address, name, FaceclawFirmwareUtil.bytesToHex(manufacturerData), rssiValue, txPower,
                    connectable, bonded, "scan", System.currentTimeMillis())
        }

        /**
         * Android strips the 2-byte company identifier from each manufacturer
         * record and keys the SparseArray by it. Put the bytes back (little-endian)
         * so TypeScript sees the same "ER"+… layout the HCI captures
         * document. Prefers Even's own id; otherwise returns the first record so an
         * unexpected company id still reaches the diagnostics log.
         */
        private fun extractEvenManufacturerData(record: ScanRecord?): ByteArray {
            if (record == null) {
                return ByteArray(0)
            }
            val all: SparseArray<ByteArray>? = record.manufacturerSpecificData
            if (all == null || all.size() == 0) {
                return ByteArray(0)
            }
            var payload: ByteArray? = all.get(EVEN_COMPANY_ID)
            var companyId = EVEN_COMPANY_ID
            if (payload == null) {
                companyId = all.keyAt(0)
                payload = all.valueAt(0)
            }
            if (payload == null) {
                return ByteArray(0)
            }
            val out = ByteArray(payload.size + 2)
            out[0] = (companyId and 0xff).toByte()
            out[1] = ((companyId shr 8) and 0xff).toByte()
            System.arraycopy(payload, 0, out, 2, payload.size)
            return out
        }

        private fun isAdmissible(name: String?, manufacturerData: ByteArray?): Boolean {
            if (manufacturerData != null && manufacturerData.size >= 2
                    && manufacturerData[0] == 0x45.toByte() && manufacturerData[1] == 0x52.toByte()) {
                return true
            }
            if (name == null) {
                return false
            }
            val upper = name.uppercase()
            // A bare "R1" substring also matches unrelated hardware ("Oppo Enco
            // R1"), and TS only classifies rings from the stock name prefix.
            return upper.contains("G2") || upper.startsWith("EVEN R1")
        }

        private fun buildJson(
                address: String?, name: String?, manufacturerHex: String?, rssi: Int?, txPower: Int?,
                connectable: Boolean?, bonded: Boolean, source: String, seenAtMs: Long): JSONObject? {
            if (address == null || address.isEmpty()) {
                return null
            }
            try {
                val obj = JSONObject()
                obj.put("address", address)
                obj.put("name", name ?: "")
                obj.put("manufacturerData", manufacturerHex ?: "")
                obj.put("rssi", rssi ?: JSONObject.NULL)
                obj.put("txPower", txPower ?: JSONObject.NULL)
                obj.put("connectable", connectable ?: JSONObject.NULL)
                obj.put("bonded", bonded)
                obj.put("source", source)
                obj.put("seenAtMs", seenAtMs)
                return obj
            } catch (e: JSONException) {
                return null
            }
        }

        private fun describeScanError(errorCode: Int): String {
            return when (errorCode) {
                ScanCallback.SCAN_FAILED_ALREADY_STARTED ->
                    "a scan is already running"
                ScanCallback.SCAN_FAILED_APPLICATION_REGISTRATION_FAILED ->
                    "the Bluetooth stack refused to register the scan (try toggling Bluetooth)"
                ScanCallback.SCAN_FAILED_FEATURE_UNSUPPORTED ->
                    "BLE scanning is not supported on this device"
                ScanCallback.SCAN_FAILED_INTERNAL_ERROR ->
                    "internal Bluetooth error"
                5 -> // SCAN_FAILED_OUT_OF_HARDWARE_RESOURCES (API 31)
                    "out of Bluetooth hardware resources"
                6 -> // SCAN_FAILED_SCANNING_TOO_FREQUENTLY (API 31)
                    "scanning too frequently; wait a moment and try again"
                else ->
                    "scan failed (code $errorCode)"
            }
        }
    }

    private val bluetoothAdapter: BluetoothAdapter
    private val mainHandler = Handler(Looper.getMainLooper())

    private val lock = Any()
    private var activeCallback: ScanCallback? = null
    @Volatile
    private var listener: FaceclawDeviceDiscoveryListener? = null

    init {
        val appContext = context.applicationContext
        val bluetoothManager =
                appContext.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager?
        if (bluetoothManager == null || bluetoothManager.adapter == null) {
            throw IllegalStateException("Bluetooth adapter unavailable")
        }
        this.bluetoothAdapter = bluetoothManager.adapter
    }

    fun isBluetoothEnabled(): Boolean {
        return bluetoothAdapter.isEnabled
    }

    fun setListener(newListener: FaceclawDeviceDiscoveryListener?) {
        this.listener = newListener
    }

    // ------------------------------------------------------------------
    // Live scan
    // ------------------------------------------------------------------

    /**
     * Start streaming advertisements to the listener. Returns false when the
     * radio is off or the scanner is unavailable; a later platform refusal
     * arrives through onScanFailed. Calling while a scan is running is a no-op.
     */
    fun startScan(): Boolean {
        synchronized(lock) {
            if (activeCallback != null) {
                return true
            }
            if (!bluetoothAdapter.isEnabled) {
                emitLog("scan not started: Bluetooth is off")
                return false
            }
            val scanner: BluetoothLeScanner? = bluetoothAdapter.bluetoothLeScanner
            if (scanner == null) {
                emitLog("scan not started: no BLE scanner")
                return false
            }
            val callback = object : ScanCallback() {
                override fun onScanResult(callbackType: Int, result: ScanResult?) {
                    if (result != null) {
                        emitAdvertisement(result)
                    }
                }

                override fun onBatchScanResults(results: List<ScanResult?>?) {
                    if (results == null) {
                        return
                    }
                    for (result in results) {
                        if (result != null) {
                            emitAdvertisement(result)
                        }
                    }
                }

                override fun onScanFailed(errorCode: Int) {
                    synchronized(lock) {
                        if (activeCallback === this) {
                            activeCallback = null
                        }
                    }
                    val l = listener
                    if (l != null) {
                        val message = describeScanError(errorCode)
                        mainHandler.post { l.onScanFailed(errorCode, message) }
                    }
                }
            }
            activeCallback = callback
            try {
                scanner.startScan(null, buildScanSettings(), callback)
            } catch (t: Throwable) {
                activeCallback = null
                emitLog("scan not started: $t")
                return false
            }
            emitLog("scan started (unfiltered, low latency)")
            return true
        }
    }

    fun stopScan() {
        val callback: ScanCallback?
        synchronized(lock) {
            callback = activeCallback
            activeCallback = null
        }
        if (callback == null) {
            return
        }
        val scanner = bluetoothAdapter.bluetoothLeScanner
        if (scanner != null) {
            try {
                scanner.stopScan(callback)
            } catch (ignored: Throwable) {
            }
        }
        emitLog("scan stopped")
    }

    fun isScanning(): Boolean {
        synchronized(lock) {
            return activeCallback != null
        }
    }

    /**
     * Replay bonded Even devices to the listener. A bonded listing has no
     * signal sample and no manufacturer data, so its serial stays unknown until
     * the device is also heard advertising.
     */
    fun emitBondedDevices() {
        val l = listener ?: return
        for (json in bondedCandidateJsonList()) {
            l.onAdvertisement(json)
        }
    }

    /** Bonded Even devices as one JSON array, for callers without a listener. */
    fun getBondedCandidatesJson(): String {
        val array = JSONArray()
        for (json in bondedCandidateJsonList()) {
            try {
                array.put(JSONObject(json))
            } catch (ignored: JSONException) {
            }
        }
        return array.toString()
    }

    private fun emitAdvertisement(result: ScanResult) {
        val obj = toJson(result) ?: return
        val l = listener ?: return
        val json = obj.toString()
        if (Looper.myLooper() == Looper.getMainLooper()) {
            l.onAdvertisement(json)
        } else {
            mainHandler.post {
                val current = listener
                if (current != null) {
                    current.onAdvertisement(json)
                }
            }
        }
    }

    private fun bondedCandidateJsonList(): List<String> {
        val out = ArrayList<String>()
        val bonded: Set<BluetoothDevice>? = bluetoothAdapter.bondedDevices
        if (bonded == null) {
            return out
        }
        val now = System.currentTimeMillis()
        for (device in bonded) {
            if (device == null) {
                continue
            }
            val name = device.name
            if (!isAdmissible(name, null)) {
                continue
            }
            val obj = buildJson(
                    device.address, name, "", null, null, null, true, "paired", now)
            if (obj != null) {
                out.add(obj.toString())
            }
        }
        return out
    }

    private fun emitLog(line: String) {
        val l = listener
        if (l != null) {
            l.onLog(line)
        }
    }
}
