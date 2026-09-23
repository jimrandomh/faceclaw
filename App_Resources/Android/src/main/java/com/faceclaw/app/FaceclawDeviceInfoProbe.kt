package com.faceclaw.app

import android.content.Context
import android.os.Handler
import android.os.Looper

/**
 * Android host for the shared [DeviceInfoProbeFlow]: owns the GATT link (AndroidStockLink),
 * the worker thread the flow runs on, and delivers listener callbacks on the main thread.
 * Public API unchanged for the TypeScript wrapper (app/native/device-info-probe.ts).
 */
class FaceclawDeviceInfoProbe(context: Context, rightAddress: String?, leftAddress: String?) {
    private val link = AndroidStockLink(context.applicationContext)
    private val mainHandler = Handler(Looper.getMainLooper())
    private val lock = Any()

    @Volatile
    private var listener: FaceclawDeviceInfoProbeListener? = null

    @Volatile
    private var worker: Thread? = null

    private val flow =
        DeviceInfoProbeFlow(
            link,
            rightAddress ?: "",
            leftAddress ?: "",
            object : FaceclawDeviceInfoProbeListener {
                override fun onLog(line: String?) {
                    android.util.Log.i(DeviceInfoProbeFlow.TAG, line ?: "")
                    post { it.onLog(line) }
                }

                override fun onState(state: String?, detail: String?) = post { it.onState(state, detail ?: "") }

                override fun onResult(leftVersion: String?, rightVersion: String?, extension: String?) =
                    post { it.onResult(leftVersion, rightVersion, extension) }

                override fun onError(message: String?) = post { it.onError(message ?: "") }
            },
        )

    fun setListener(listener: FaceclawDeviceInfoProbeListener?) {
        this.listener = listener
    }

    fun start() {
        synchronized(lock) {
            if (worker != null) {
                return
            }
            val w = Thread({ flow.run() }, "faceclaw-device-info")
            worker = w
            w.start()
        }
    }

    fun cancel() {
        flow.cancel()
    }

    fun close() {
        cancel()
        try {
            link.close()
        } catch (ignored: Exception) {
        }
    }

    private fun post(action: (FaceclawDeviceInfoProbeListener) -> Unit) {
        mainHandler.post {
            val current = listener
            if (current != null) {
                action(current)
            }
        }
    }
}
