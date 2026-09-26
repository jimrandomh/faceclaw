package com.faceclaw.app

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.wifi.WifiInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.telephony.SignalStrength
import android.telephony.TelephonyManager
import android.util.Log

import java.io.ByteArrayOutputStream
import java.lang.reflect.Method

/** Reads Wi-Fi/cell/hotspot state; the icon artwork is the shared StatusIconArt. */
class FaceclawSystemStatusIconProvider private constructor() {
    companion object {
        private const val TAG = "FaceclawStatusIcons"

        @JvmStatic
        fun getSystemStatusIconGrays(context: Context?, iconSize: Int): ByteArray {
            if (context == null) {
                return ByteArray(0)
            }
            val appContext = context.applicationContext
            val size = Math.max(1, Math.min(96, iconSize))
            val out = ByteArrayOutputStream(size * size * 3)

            val wifiLevel = getWifiLevel(appContext)
            if (wifiLevel >= 0) {
                append(out, StatusIconArt.scale(StatusIconArt.wifi(wifiLevel), size))
            }

            val cellLevel = getCellLevel(appContext)
            if (cellLevel >= 0) {
                append(out, StatusIconArt.scale(StatusIconArt.cell(cellLevel), size))
            }

            if (isHotspotEnabled(appContext)) {
                append(out, StatusIconArt.scale(StatusIconArt.hotspot(), size))
            }

            return out.toByteArray()
        }

        private fun getWifiLevel(context: Context): Int {
            try {
                val connectivityManager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager?
                val activeNetwork: Network? = if (connectivityManager == null) null else connectivityManager.activeNetwork
                val capabilities: NetworkCapabilities? = if (activeNetwork == null) null else connectivityManager!!.getNetworkCapabilities(activeNetwork)
                if (capabilities == null || !capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) {
                    return -1
                }
                val wifiManager = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager?
                val info: WifiInfo? = if (wifiManager == null) null else wifiManager.connectionInfo
                if (info == null || !isValidRssi(info.rssi)) {
                    return -1
                }
                return Math.max(0, Math.min(4, WifiManager.calculateSignalLevel(info.rssi, 5)))
            } catch (t: Throwable) {
                Log.w(TAG, "failed to read Wi-Fi status", t)
                return -1
            }
        }

        private fun getCellLevel(context: Context): Int {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) {
                return -1
            }
            try {
                val telephonyManager = context.getSystemService(Context.TELEPHONY_SERVICE) as TelephonyManager?
                val signalStrength: SignalStrength? = if (telephonyManager == null) null else telephonyManager.signalStrength
                if (signalStrength == null) {
                    return -1
                }
                return Math.max(0, Math.min(4, signalStrength.level))
            } catch (e: SecurityException) {
                // Most Android versions require READ_PHONE_STATE for this. We skip it
                // rather than prompting for a broad phone permission just for an icon.
                return -1
            } catch (t: Throwable) {
                Log.w(TAG, "failed to read cellular status", t)
                return -1
            }
        }

        private fun isHotspotEnabled(context: Context): Boolean {
            try {
                val wifiManager = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager?
                if (wifiManager == null) {
                    return false
                }
                val method: Method = wifiManager.javaClass.getDeclaredMethod("getWifiApState")
                method.isAccessible = true
                val result: Any? = method.invoke(wifiManager)
                val state = if (result is Int) result else -1
                return state == 13 || state == 12 // WIFI_AP_STATE_ENABLED / ENABLING
            } catch (ignored: Throwable) {
                return false
            }
        }

        private fun isValidRssi(rssi: Int): Boolean {
            return rssi > -127 && rssi < 0
        }

        private fun append(out: ByteArrayOutputStream, bytes: ByteArray) {
            out.write(bytes, 0, bytes.size)
        }
    }
}
