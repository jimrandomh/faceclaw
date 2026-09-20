package com.faceclaw.app;

import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

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
public class FaceclawLlamaRunner {
    private static final String TAG = "FaceclawLlamaRunner";

    static {
        System.loadLibrary("faceclaw_llama");
    }

    private final Handler callbackHandler;
    private final ExecutorService executor = Executors.newSingleThreadExecutor(runnable -> {
        Thread thread = new Thread(runnable, "FaceclawLlama");
        thread.setPriority(Thread.NORM_PRIORITY);
        return thread;
    });

    // Mutated only on the executor thread; volatile so cancel() can read it.
    private volatile long handle;
    private String loadedPath;

    public FaceclawLlamaRunner() {
        Looper looper = Looper.myLooper();
        callbackHandler = new Handler(looper != null ? looper : Looper.getMainLooper());
    }

    public boolean isModelLoaded() {
        return handle != 0;
    }

    /**
     * Generate a completion, loading (or swapping) the model first if needed.
     * grammar may be null/empty for unconstrained generation.
     */
    public void generate(final String modelPath, final int nCtx, final int nThreads,
                         final String prompt, final String grammar, final int maxTokens,
                         final float temperature, final float topP, final int topK,
                         final FaceclawLlamaListener listener) {
        executor.execute(() -> {
            try {
                if (handle != 0 && !modelPath.equals(loadedPath)) {
                    nativeFree(handle);
                    handle = 0;
                    loadedPath = null;
                }
                if (handle == 0) {
                    long loaded = nativeLoadModel(modelPath, nCtx, nThreads);
                    if (loaded == 0) {
                        post(() -> listener.onError("Could not load the on-phone model"));
                        return;
                    }
                    handle = loaded;
                    loadedPath = modelPath;
                }
                nativeGenerate(handle, prompt, grammar == null ? "" : grammar,
                    maxTokens, temperature, topP, topK, new FaceclawLlamaListener() {
                        @Override public void onToken(final String piece) {
                            post(() -> listener.onToken(piece));
                        }
                        @Override public void onDone(final String stopReason) {
                            post(() -> listener.onDone(stopReason));
                        }
                        @Override public void onError(final String message) {
                            post(() -> listener.onError(message));
                        }
                    });
            } catch (Throwable t) {
                Log.e(TAG, "generation failed", t);
                final String message = String.valueOf(t);
                post(() -> listener.onError("On-phone model failed: " + message));
            }
        });
    }

    /** Interrupt the current generation (its listener gets onDone("cancelled")). */
    public void cancel() {
        long current = handle;
        if (current != 0) {
            nativeCancel(current);
        }
    }

    /** Free the model and its KV cache. Safe to call when nothing is loaded. */
    public void unload() {
        executor.execute(() -> {
            if (handle != 0) {
                nativeFree(handle);
                handle = 0;
                loadedPath = null;
            }
        });
    }

    private void post(Runnable runnable) {
        callbackHandler.post(runnable);
    }

    private static native long nativeLoadModel(String path, int nCtx, int nThreads);
    private static native void nativeGenerate(long handle, String prompt, String grammar,
        int maxTokens, float temperature, float topP, int topK, FaceclawLlamaListener listener);
    private static native void nativeCancel(long handle);
    private static native void nativeFree(long handle);
}
