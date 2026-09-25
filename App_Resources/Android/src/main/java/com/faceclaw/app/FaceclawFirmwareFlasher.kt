package com.faceclaw.app

import android.content.Context
import android.os.Handler
import android.os.Looper

/**
 * Android host for the shared [OtaFlashFlow] (g2flash.py's OTA procedure over the stock
 * firmware-data service): owns the GATT link (AndroidStockLink) and the worker thread, and
 * delivers listener callbacks on the main thread. Separate from FaceclawBleCommunicator on
 * purpose: this speaks the stock OTA protocol and must run before the custom firmware exists.
 * Public API unchanged for app/native/firmware-flasher.ts.
 */
class FaceclawFirmwareFlasher(context: Context, rightAddress: String?, leftAddress: String?, firmwarePath: String?) {
    private val link = AndroidStockLink(context.applicationContext)
    private val mainHandler = Handler(Looper.getMainLooper())
    private val lock = Any()

    @Volatile
    private var listener: FaceclawFirmwareFlasherListener? = null

    @Volatile
    private var worker: Thread? = null

    private val flow =
        OtaFlashFlow(
            link,
            rightAddress ?: "",
            leftAddress ?: "",
            firmwarePath ?: "",
            object : FaceclawFirmwareFlasherListener {
                override fun onLog(line: String?) {
                    android.util.Log.i(OtaFlashFlow.TAG, line ?: "")
                    post { it.onLog(line) }
                }

                override fun onProgress(
                    lens: String?,
                    componentIndex: Int,
                    componentCount: Int,
                    blockIndex: Int,
                    blockCount: Int,
                    bytesSent: Long,
                    bytesTotal: Long,
                ) = post { it.onProgress(lens, componentIndex, componentCount, blockIndex, blockCount, bytesSent, bytesTotal) }

                override fun onState(state: String?, detail: String?) = post { it.onState(state, detail ?: "") }

                override fun onComplete(success: Boolean, detail: String?) = post { it.onComplete(success, detail ?: "") }
            },
        )

    fun setListener(listener: FaceclawFirmwareFlasherListener?) {
        this.listener = listener
    }

    fun start() {
        synchronized(lock) {
            if (worker != null) {
                return
            }
            val w = Thread({ flow.run() }, "faceclaw-flasher")
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

    private fun post(action: (FaceclawFirmwareFlasherListener) -> Unit) {
        mainHandler.post {
            val current = listener
            if (current != null) {
                action(current)
            }
        }
    }
}
