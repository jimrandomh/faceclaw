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

class FaceclawSystemStatusIconProvider private constructor() {
    companion object {
        private const val TAG = "FaceclawStatusIcons"
        private const val ICON_SIZE = 24

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
                append(out, scaleIcon(drawWifiIcon(wifiLevel), size))
            }

            val cellLevel = getCellLevel(appContext)
            if (cellLevel >= 0) {
                append(out, scaleIcon(drawCellIcon(cellLevel), size))
            }

            if (isHotspotEnabled(appContext)) {
                append(out, scaleIcon(drawHotspotIcon(), size))
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

        private fun drawWifiIcon(level: Int): ByteArray {
            val icon = ByteArray(ICON_SIZE * ICON_SIZE)
            val cx = 12
            val cy = 18
            fillRect(icon, cx - 1, cy - 1, 3, 3, 230)
            val radii = intArrayOf(5, 9, 13, 17)
            for (index in radii.indices) {
                if (level <= index) {
                    continue
                }
                drawWifiArc(icon, cx, cy, radii[index], 210)
            }
            return icon
        }

        private fun drawWifiArc(icon: ByteArray, cx: Int, cy: Int, radius: Int, value: Int) {
            val inner = (radius - 1) * (radius - 1)
            val outer = (radius + 1) * (radius + 1)
            for (y in 0 until ICON_SIZE) {
                for (x in 0 until ICON_SIZE) {
                    val dx = x - cx
                    val dy = y - cy
                    val dist = dx * dx + dy * dy
                    if (dy <= 0 && dist >= inner && dist <= outer && Math.abs(dx) <= radius) {
                        setPixel(icon, x, y, value)
                    }
                }
            }
        }

        private fun drawCellIcon(level: Int): ByteArray {
            val icon = ByteArray(ICON_SIZE * ICON_SIZE)
            for (bar in 0 until 4) {
                val x = 5 + bar * 4
                val height = 5 + bar * 4
                val value = if (level > bar) 220 else 55
                fillRect(icon, x, 20 - height, 3, height, value)
            }
            return icon
        }

        private fun drawHotspotIcon(): ByteArray {
            val icon = ByteArray(ICON_SIZE * ICON_SIZE)
            fillRect(icon, 11, 17, 3, 3, 230)
            drawWifiArc(icon, 12, 19, 7, 210)
            drawWifiArc(icon, 12, 19, 12, 210)
            fillRect(icon, 6, 5, 12, 2, 170)
            return icon
        }

        private fun scaleIcon(source: ByteArray, size: Int): ByteArray {
            if (size == ICON_SIZE) {
                return source
            }
            val scaled = ByteArray(size * size)
            for (y in 0 until size) {
                val sy = Math.min(ICON_SIZE - 1, (y * ICON_SIZE) / size)
                for (x in 0 until size) {
                    val sx = Math.min(ICON_SIZE - 1, (x * ICON_SIZE) / size)
                    scaled[y * size + x] = source[sy * ICON_SIZE + sx]
                }
            }
            return scaled
        }

        private fun fillRect(icon: ByteArray, x: Int, y: Int, width: Int, height: Int, value: Int) {
            for (row in y until y + height) {
                for (col in x until x + width) {
                    setPixel(icon, col, row, value)
                }
            }
        }

        private fun setPixel(icon: ByteArray, x: Int, y: Int, value: Int) {
            if (x < 0 || y < 0 || x >= ICON_SIZE || y >= ICON_SIZE) {
                return
            }
            icon[y * ICON_SIZE + x] = Math.max(0, Math.min(255, value)).toByte()
        }

        private fun append(out: ByteArrayOutputStream, bytes: ByteArray) {
            out.write(bytes, 0, bytes.size)
        }
    }
}
