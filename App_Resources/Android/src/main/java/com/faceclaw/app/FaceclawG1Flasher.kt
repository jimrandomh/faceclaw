package com.faceclaw.app

import android.content.Context
import android.os.Handler
import android.os.Looper

/**
 * Android host for the shared [G1ArmFlashFlow]: owns the GATT link and the worker thread for one G1 arm's install, or a
 * question about what it runs, and delivers listener callbacks on the main thread. For app/native/g1-flasher.ts.
 */
class FaceclawG1Flasher(context: Context, address: String?, side: String?, firmwarePath: String?, mode: String?, connectWindowMs: Int) {
    private val link = AndroidStockLink(context.applicationContext)
    private val mainHandler = Handler(Looper.getMainLooper())
    private val lock = Any()

    @Volatile
    private var listener: FaceclawFirmwareFlasherListener? = null

    @Volatile
    private var worker: Thread? = null

    private val flow =
        G1ArmFlashFlow(
            link,
            address ?: "",
            side ?: "",
            firmwarePath ?: "",
            G1ArmFlashFlow.mode(mode ?: ""),
            connectWindowMs,
            object : FaceclawFirmwareFlasherListener {
                override fun onLog(line: String?) {
                    android.util.Log.i(G1ArmFlashFlow.TAG, line ?: "")
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
            val w = Thread({ flow.run() }, "faceclaw-g1-flash")
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
