package com.faceclaw.app;

import android.app.Activity;
import android.content.Context;
import android.util.Log;

import com.google.android.gms.common.ConnectionResult;
import com.google.android.gms.common.GoogleApiAvailability;
import com.google.android.gms.tasks.OnCanceledListener;
import com.google.android.gms.tasks.OnFailureListener;
import com.google.android.gms.tasks.OnSuccessListener;
import com.google.mlkit.vision.barcode.common.Barcode;
import com.google.mlkit.vision.codescanner.GmsBarcodeScanner;
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions;
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning;

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
public final class FaceclawQrScanner {
    private static final String TAG = "FaceclawQrScanner";

    private FaceclawQrScanner() {}

    /** Whether Play Services is present and current enough to scan. */
    public static boolean isAvailable(Context context) {
        try {
            int status = GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(context);
            return status == ConnectionResult.SUCCESS;
        } catch (Throwable error) {
            Log.w(TAG, "Play Services availability check failed", error);
            return false;
        }
    }

    /** Open the scanner UI; the listener gets the decoded text, or a cancel/error. */
    public static void scan(Activity activity, final FaceclawQrScannerListener listener) {
        GmsBarcodeScannerOptions options = new GmsBarcodeScannerOptions.Builder()
                .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
                .enableAutoZoom()
                .build();
        GmsBarcodeScanner scanner = GmsBarcodeScanning.getClient(activity, options);
        scanner.startScan()
                .addOnSuccessListener(new OnSuccessListener<Barcode>() {
                    @Override
                    public void onSuccess(Barcode barcode) {
                        String value = barcode == null ? null : barcode.getRawValue();
                        if (value == null) {
                            listener.onError("The code held no text.");
                        } else {
                            listener.onResult(value);
                        }
                    }
                })
                .addOnCanceledListener(new OnCanceledListener() {
                    @Override
                    public void onCanceled() {
                        listener.onCancelled();
                    }
                })
                .addOnFailureListener(new OnFailureListener() {
                    @Override
                    public void onFailure(Exception error) {
                        Log.w(TAG, "scan failed", error);
                        String message = error.getMessage();
                        listener.onError(message == null ? error.toString() : message);
                    }
                });
    }
}
