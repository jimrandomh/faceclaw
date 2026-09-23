package com.faceclaw.app

import android.content.Context
import android.os.Handler
import android.os.Looper

/**
 * Android host for the shared [FlashPromptFlow] (the stock-firmware pre-flash Yes/No prompt
 * plus battery read): owns the GATT link (AndroidStockLink) and the worker thread, and
 * delivers listener callbacks on the main thread. It expects the main app to be disconnected
 * while it runs (onboarding, before flashing). Public API unchanged for
 * app/native/flash-prompt-communicator.ts.
 */
class FaceclawFlashPromptCommunicator(
    context: Context,
    rightAddress: String?,
    leftAddress: String?,
    warningText: String?,
    skipPrompt: Boolean,
) {
    private val link = AndroidStockLink(context.applicationContext)
    private val mainHandler = Handler(Looper.getMainLooper())
    private val lock = Any()

    @Volatile
    private var listener: FaceclawFlashPromptListener? = null

    @Volatile
    private var worker: Thread? = null

    private val flow =
        FlashPromptFlow(
            link,
            rightAddress ?: "",
            leftAddress ?: "",
            warningText ?: "",
            skipPrompt,
            object : FaceclawFlashPromptListener {
                override fun onLog(line: String?) {
                    android.util.Log.i(FlashPromptFlow.TAG, line ?: "")
                    post { it.onLog(line) }
                }

                override fun onState(state: String?, detail: String?) = post { it.onState(state, detail ?: "") }

                override fun onBattery(rightPercent: Int, leftPercent: Int) = post { it.onBattery(rightPercent, leftPercent) }

                override fun onResult(approved: Boolean) = post { it.onResult(approved) }
            },
        )

    fun setListener(listener: FaceclawFlashPromptListener?) {
        this.listener = listener
    }

    fun start() {
        synchronized(lock) {
            if (worker != null) {
                return
            }
            val w = Thread({ flow.run() }, "faceclaw-flash-prompt")
            worker = w
            w.start()
        }
    }

    /** Abort the prompt (e.g. the user backed out on the phone). */
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

    private fun post(action: (FaceclawFlashPromptListener) -> Unit) {
        mainHandler.post {
            val current = listener
            if (current != null) {
                action(current)
            }
        }
    }
}
