package com.faceclaw.app

import android.os.Handler
import android.os.Looper
import android.util.Log

import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * On-phone LLM inference for the voice assistant (llama.cpp over JNI).
 *
 * All model work (load, generate, free) runs on a single background executor
 * thread so calls are naturally serialized; listener callbacks are posted to
 * the Looper of the thread that constructed this object (the JS thread), the
 * same contract as FaceclawSseRequest. cancel() may be called from any thread
 * and interrupts the in-flight generation at the next token boundary.
 *
 * The model stays loaded between generations (turn iterations reuse the KV
 * cache prefix); the TypeScript side calls unload() on an idle timer to give
 * the ~3GB back.
 */
class FaceclawLlamaRunner {
    companion object {
        private const val TAG = "FaceclawLlamaRunner"

        init {
            System.loadLibrary("faceclaw_llama")
        }

        @JvmStatic
        private external fun nativeLoadModel(path: String?, nCtx: Int, nThreads: Int): Long
        @JvmStatic
        private external fun nativeGenerate(
            handle: Long, prompt: String?, grammar: String,
            maxTokens: Int, temperature: Float, topP: Float, topK: Int, listener: FaceclawLlamaListener
        )
        @JvmStatic
        private external fun nativeCancel(handle: Long)
        @JvmStatic
        private external fun nativeFree(handle: Long)
    }

    private val callbackHandler: Handler
    private val executor: ExecutorService = Executors.newSingleThreadExecutor { runnable ->
        val thread = Thread(runnable, "FaceclawLlama")
        thread.priority = Thread.NORM_PRIORITY
        thread
    }

    // Mutated only on the executor thread; volatile so cancel() can read it.
    @Volatile
    private var handle: Long = 0
    private var loadedPath: String? = null

    init {
        val looper = Looper.myLooper()
        callbackHandler = Handler(looper ?: Looper.getMainLooper())
    }

    fun isModelLoaded(): Boolean {
        return handle != 0L
    }

    /**
     * Generate a completion, loading (or swapping) the model first if needed.
     * grammar may be null/empty for unconstrained generation.
     */
    fun generate(
        modelPath: String?, nCtx: Int, nThreads: Int,
        prompt: String?, grammar: String?, maxTokens: Int,
        temperature: Float, topP: Float, topK: Int,
        listener: FaceclawLlamaListener
    ) {
        executor.execute {
            try {
                if (handle != 0L && modelPath != loadedPath) {
                    nativeFree(handle)
                    handle = 0
                    loadedPath = null
                }
                if (handle == 0L) {
                    val loaded = nativeLoadModel(modelPath, nCtx, nThreads)
                    if (loaded == 0L) {
                        post { listener.onError("Could not load the on-phone model") }
                        return@execute
                    }
                    handle = loaded
                    loadedPath = modelPath
                }
                nativeGenerate(handle, prompt, grammar ?: "",
                    maxTokens, temperature, topP, topK, object : FaceclawLlamaListener {
                        override fun onToken(piece: String?) {
                            post { listener.onToken(piece) }
                        }
                        override fun onDone(stopReason: String?) {
                            post { listener.onDone(stopReason) }
                        }
                        override fun onError(message: String?) {
                            post { listener.onError(message) }
                        }
                    })
            } catch (t: Throwable) {
                Log.e(TAG, "generation failed", t)
                val message = t.toString()
                post { listener.onError("On-phone model failed: $message") }
            }
        }
    }

    /** Interrupt the current generation (its listener gets onDone("cancelled")). */
    fun cancel() {
        val current = handle
        if (current != 0L) {
            nativeCancel(current)
        }
    }

    /** Free the model and its KV cache. Safe to call when nothing is loaded. */
    fun unload() {
        executor.execute {
            if (handle != 0L) {
                nativeFree(handle)
                handle = 0
                loadedPath = null
            }
        }
    }

    private fun post(runnable: Runnable) {
        callbackHandler.post(runnable)
    }
}
