package com.faceclaw.app;

import android.annotation.SuppressLint;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanRecord;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.Context;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.SparseArray;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;

/**
 * Finds Even Realities hardware over BLE and hands every advertisement up to
 * TypeScript with the raw fields the pairing screen needs: the LIVE local name
 * from the scan record (BluetoothDevice.getName() is a cache that can hold a
 * pre-reset value indefinitely), the full manufacturer-specific payload with
 * its company identifier restored so the "ER"+serial+MAC layout survives
 * intact, RSSI, advertised TX power, and connectability.
 *
 * Admission is deliberately loose — a name containing G2, the stock
 * "EVEN R1…" ring prefix, or the Even "ER" manufacturer signature — because
 * renamed custom firmware may drop the stock name. Side, serial, and pair
 * matching are decided in TypeScript (app/g2/even-advertisement.ts,
 * app/g2/pairing-candidates.ts) where they can be unit-tested; this filter
 * must stay a superset of the TS classifier's admission.
 */
@SuppressLint("MissingPermission")
public class FaceclawDeviceDiscovery {
    /** Even Realities' company identifier: the ASCII bytes "ER" read little-endian. */
    public static final int EVEN_COMPANY_ID = 0x5245;

    private final BluetoothAdapter bluetoothAdapter;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private final Object lock = new Object();
    private ScanCallback activeCallback;
    private volatile FaceclawDeviceDiscoveryListener listener;

    public FaceclawDeviceDiscovery(Context context) {
        Context appContext = context.getApplicationContext();
        BluetoothManager bluetoothManager =
                (BluetoothManager) appContext.getSystemService(Context.BLUETOOTH_SERVICE);
        if (bluetoothManager == null || bluetoothManager.getAdapter() == null) {
            throw new IllegalStateException("Bluetooth adapter unavailable");
        }
        this.bluetoothAdapter = bluetoothManager.getAdapter();
    }

    public boolean isBluetoothEnabled() {
        return bluetoothAdapter.isEnabled();
    }

    public void setListener(FaceclawDeviceDiscoveryListener newListener) {
        this.listener = newListener;
    }

    // ------------------------------------------------------------------
    // Live scan
    // ------------------------------------------------------------------

    /**
     * Start streaming advertisements to the listener. Returns false when the
     * radio is off or the scanner is unavailable; a later platform refusal
     * arrives through onScanFailed. Calling while a scan is running is a no-op.
     */
    public boolean startScan() {
        synchronized (lock) {
            if (activeCallback != null) {
                return true;
            }
            if (!bluetoothAdapter.isEnabled()) {
                emitLog("scan not started: Bluetooth is off");
                return false;
            }
            BluetoothLeScanner scanner = bluetoothAdapter.getBluetoothLeScanner();
            if (scanner == null) {
                emitLog("scan not started: no BLE scanner");
                return false;
            }
            final ScanCallback callback = new ScanCallback() {
                @Override
                public void onScanResult(int callbackType, ScanResult result) {
                    if (result != null) {
                        emitAdvertisement(result);
                    }
                }

                @Override
                public void onBatchScanResults(List<ScanResult> results) {
                    if (results == null) {
                        return;
                    }
                    for (ScanResult result : results) {
                        if (result != null) {
                            emitAdvertisement(result);
                        }
                    }
                }

                @Override
                public void onScanFailed(int errorCode) {
                    synchronized (lock) {
                        if (activeCallback == this) {
                            activeCallback = null;
                        }
                    }
                    final FaceclawDeviceDiscoveryListener l = listener;
                    if (l != null) {
                        final String message = describeScanError(errorCode);
                        mainHandler.post(() -> l.onScanFailed(errorCode, message));
                    }
                }
            };
            activeCallback = callback;
            try {
                scanner.startScan(null, buildScanSettings(), callback);
            } catch (Throwable t) {
                activeCallback = null;
                emitLog("scan not started: " + t);
                return false;
            }
            emitLog("scan started (unfiltered, low latency)");
            return true;
        }
    }

    public void stopScan() {
        ScanCallback callback;
        synchronized (lock) {
            callback = activeCallback;
            activeCallback = null;
        }
        if (callback == null) {
            return;
        }
        BluetoothLeScanner scanner = bluetoothAdapter.getBluetoothLeScanner();
        if (scanner != null) {
            try {
                scanner.stopScan(callback);
            } catch (Throwable ignored) {
            }
        }
        emitLog("scan stopped");
    }

    public boolean isScanning() {
        synchronized (lock) {
            return activeCallback != null;
        }
    }

    /**
     * Replay bonded Even devices to the listener. A bonded listing has no
     * signal sample and no manufacturer data, so its serial stays unknown until
     * the device is also heard advertising.
     */
    public void emitBondedDevices() {
        final FaceclawDeviceDiscoveryListener l = listener;
        if (l == null) {
            return;
        }
        for (String json : bondedCandidateJsonList()) {
            l.onAdvertisement(json);
        }
    }

    /** Bonded Even devices as one JSON array, for callers without a listener. */
    public String getBondedCandidatesJson() {
        JSONArray array = new JSONArray();
        for (String json : bondedCandidateJsonList()) {
            try {
                array.put(new JSONObject(json));
            } catch (JSONException ignored) {
            }
        }
        return array.toString();
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    private static ScanSettings buildScanSettings() {
        ScanSettings.Builder builder = new ScanSettings.Builder()
                .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
                .setReportDelay(0);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            builder.setCallbackType(ScanSettings.CALLBACK_TYPE_ALL_MATCHES);
            builder.setMatchMode(ScanSettings.MATCH_MODE_AGGRESSIVE);
            builder.setNumOfMatches(ScanSettings.MATCH_NUM_MAX_ADVERTISEMENT);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            // Accept extended advertising too; setLegacy(true) would hide it.
            builder.setLegacy(false);
        }
        return builder.build();
    }

    private void emitAdvertisement(ScanResult result) {
        final JSONObject object = toJson(result);
        if (object == null) {
            return;
        }
        final FaceclawDeviceDiscoveryListener l = listener;
        if (l == null) {
            return;
        }
        final String json = object.toString();
        if (Looper.myLooper() == Looper.getMainLooper()) {
            l.onAdvertisement(json);
        } else {
            mainHandler.post(() -> {
                FaceclawDeviceDiscoveryListener current = listener;
                if (current != null) {
                    current.onAdvertisement(json);
                }
            });
        }
    }

    private List<String> bondedCandidateJsonList() {
        List<String> out = new ArrayList<>();
        Set<BluetoothDevice> bonded = bluetoothAdapter.getBondedDevices();
        if (bonded == null) {
            return out;
        }
        long now = System.currentTimeMillis();
        for (BluetoothDevice device : bonded) {
            if (device == null) {
                continue;
            }
            String name = device.getName();
            if (!isAdmissible(name, null)) {
                continue;
            }
            JSONObject object = buildJson(
                    device.getAddress(), name, "", null, null, null, true, "paired", now);
            if (object != null) {
                out.add(object.toString());
            }
        }
        return out;
    }

    /** Null when the result is not something we pair with. */
    private static JSONObject toJson(ScanResult result) {
        BluetoothDevice device = result.getDevice();
        if (device == null) {
            return null;
        }
        ScanRecord record = result.getScanRecord();
        String liveName = record == null ? null : record.getDeviceName();
        String name = liveName != null && !liveName.isEmpty() ? liveName : device.getName();
        byte[] manufacturerData = extractEvenManufacturerData(record);
        if (!isAdmissible(name, manufacturerData)) {
            return null;
        }
        Integer txPower = null;
        if (record != null && record.getTxPowerLevel() != Integer.MIN_VALUE) {
            txPower = record.getTxPowerLevel();
        }
        if (txPower == null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && result.getTxPower() != ScanResult.TX_POWER_NOT_PRESENT) {
            txPower = result.getTxPower();
        }
        Boolean connectable = null;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            connectable = result.isConnectable();
        }
        int rssi = result.getRssi();
        // 127 is the "unavailable" sentinel; 0 dBm never happens for a real sample.
        Integer rssiValue = (rssi == 127 || rssi == 0) ? null : rssi;
        boolean bonded = device.getBondState() == BluetoothDevice.BOND_BONDED;
        return buildJson(
                device.getAddress(), name, FaceclawFirmwareUtil.bytesToHex(manufacturerData), rssiValue, txPower,
                connectable, bonded, "scan", System.currentTimeMillis());
    }

    /**
     * Android strips the 2-byte company identifier from each manufacturer
     * record and keys the SparseArray by it. Put the bytes back (little-endian)
     * so TypeScript sees the same "ER"+… layout the HCI captures
     * document. Prefers Even's own id; otherwise returns the first record so an
     * unexpected company id still reaches the diagnostics log.
     */
    private static byte[] extractEvenManufacturerData(ScanRecord record) {
        if (record == null) {
            return new byte[0];
        }
        SparseArray<byte[]> all = record.getManufacturerSpecificData();
        if (all == null || all.size() == 0) {
            return new byte[0];
        }
        byte[] payload = all.get(EVEN_COMPANY_ID);
        int companyId = EVEN_COMPANY_ID;
        if (payload == null) {
            companyId = all.keyAt(0);
            payload = all.valueAt(0);
        }
        if (payload == null) {
            return new byte[0];
        }
        byte[] out = new byte[payload.length + 2];
        out[0] = (byte) (companyId & 0xff);
        out[1] = (byte) ((companyId >> 8) & 0xff);
        System.arraycopy(payload, 0, out, 2, payload.length);
        return out;
    }

    private static boolean isAdmissible(String name, byte[] manufacturerData) {
        if (manufacturerData != null && manufacturerData.length >= 2
                && manufacturerData[0] == 0x45 && manufacturerData[1] == 0x52) {
            return true;
        }
        if (name == null) {
            return false;
        }
        String upper = name.toUpperCase();
        // A bare "R1" substring also matches unrelated hardware ("Oppo Enco
        // R1"), and TS only classifies rings from the stock name prefix.
        return upper.contains("G2") || upper.startsWith("EVEN R1");
    }

    private static JSONObject buildJson(
            String address, String name, String manufacturerHex, Integer rssi, Integer txPower,
            Boolean connectable, boolean bonded, String source, long seenAtMs) {
        if (address == null || address.isEmpty()) {
            return null;
        }
        try {
            JSONObject object = new JSONObject();
            object.put("address", address);
            object.put("name", name == null ? "" : name);
            object.put("manufacturerData", manufacturerHex == null ? "" : manufacturerHex);
            object.put("rssi", rssi == null ? JSONObject.NULL : rssi);
            object.put("txPower", txPower == null ? JSONObject.NULL : txPower);
            object.put("connectable", connectable == null ? JSONObject.NULL : connectable);
            object.put("bonded", bonded);
            object.put("source", source);
            object.put("seenAtMs", seenAtMs);
            return object;
        } catch (JSONException e) {
            return null;
        }
    }

    private static String describeScanError(int errorCode) {
        switch (errorCode) {
            case ScanCallback.SCAN_FAILED_ALREADY_STARTED:
                return "a scan is already running";
            case ScanCallback.SCAN_FAILED_APPLICATION_REGISTRATION_FAILED:
                return "the Bluetooth stack refused to register the scan (try toggling Bluetooth)";
            case ScanCallback.SCAN_FAILED_FEATURE_UNSUPPORTED:
                return "BLE scanning is not supported on this device";
            case ScanCallback.SCAN_FAILED_INTERNAL_ERROR:
                return "internal Bluetooth error";
            case 5: // SCAN_FAILED_OUT_OF_HARDWARE_RESOURCES (API 31)
                return "out of Bluetooth hardware resources";
            case 6: // SCAN_FAILED_SCANNING_TOO_FREQUENTLY (API 31)
                return "scanning too frequently; wait a moment and try again";
            default:
                return "scan failed (code " + errorCode + ")";
        }
    }

    private void emitLog(String line) {
        FaceclawDeviceDiscoveryListener l = listener;
        if (l != null) {
            l.onLog(line);
        }
    }
}
