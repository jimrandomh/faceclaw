package com.faceclaw.app

import android.app.Activity
import android.content.Context
import android.util.Log

import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import com.google.android.gms.tasks.OnCanceledListener
import com.google.android.gms.tasks.OnFailureListener
import com.google.android.gms.tasks.OnSuccessListener
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScanner
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning

/**
 * QR scanning through Play Services' ML Kit code scanner. The scanner UI and
 * the camera both live inside Play Services, so Faceclaw needs no camera
 * permission of its own and no third-party scanner app — which is what the
 * earlier ZXing SCAN intent needed, and no app on a stock Pixel registers for
 * it.
 *
 * The scanner module is downloaded on demand the first time it is used (the
 * manifest's com.google.mlkit.vision.DEPENDENCIES meta-data asks Play Services
 * to fetch it at install time instead); a scan attempted before that finishes
 * fails with a module-unavailable error rather than blocking.
 *
 * Callbacks fire on the main thread.
 */
class FaceclawQrScanner private constructor() {
    companion object {
        private const val TAG = "FaceclawQrScanner"

        /** Whether Play Services is present and current enough to scan. */
        @JvmStatic
        fun isAvailable(context: Context): Boolean {
            try {
                val status = GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(context)
                return status == ConnectionResult.SUCCESS
            } catch (error: Throwable) {
                Log.w(TAG, "Play Services availability check failed", error)
                return false
            }
        }

        /** Open the scanner UI; the listener gets the decoded text, or a cancel/error. */
        @JvmStatic
        fun scan(activity: Activity, listener: FaceclawQrScannerListener) {
            val options = GmsBarcodeScannerOptions.Builder()
                    .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
                    .enableAutoZoom()
                    .build()
            val scanner: GmsBarcodeScanner = GmsBarcodeScanning.getClient(activity, options)
            scanner.startScan()
                    .addOnSuccessListener(OnSuccessListener<Barcode> { barcode ->
                        val value = barcode?.rawValue
                        if (value == null) {
                            listener.onError("The code held no text.")
                        } else {
                            listener.onResult(value)
                        }
                    })
                    .addOnCanceledListener(OnCanceledListener {
                        listener.onCancelled()
                    })
                    .addOnFailureListener(OnFailureListener { error ->
                        Log.w(TAG, "scan failed", error)
                        val message = error.message
                        listener.onError(message ?: error.toString())
                    })
        }
    }
}
