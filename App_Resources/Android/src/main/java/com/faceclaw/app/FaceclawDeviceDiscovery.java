package com.faceclaw.app;

import android.annotation.SuppressLint;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.Context;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

@SuppressLint("MissingPermission")
public class FaceclawDeviceDiscovery {
    private static final Pattern RING_NAME = Pattern.compile("^EVEN R1_[0-9A-F]{6}$");
    private static final Pattern RIGHT_NAME = Pattern.compile("^Even G2_32_R_[0-9A-F]{6}$");
    private static final Pattern LEFT_NAME = Pattern.compile("^Even G2_32_L_[0-9A-F]{6}$");

    private final Context appContext;
    private final BluetoothAdapter bluetoothAdapter;

    public FaceclawDeviceDiscovery(Context context) {
        this.appContext = context.getApplicationContext();
        BluetoothManager bluetoothManager =
                (BluetoothManager) this.appContext.getSystemService(Context.BLUETOOTH_SERVICE);
        if (bluetoothManager == null || bluetoothManager.getAdapter() == null) {
            throw new IllegalStateException("Bluetooth adapter unavailable");
        }
        this.bluetoothAdapter = bluetoothManager.getAdapter();
    }

    public String getBondedCandidatesJson() {
        LinkedHashMap<String, CandidateDevice> matches = new LinkedHashMap<>();
        Set<BluetoothDevice> bonded = bluetoothAdapter.getBondedDevices();
        if (bonded != null) {
            for (BluetoothDevice device : bonded) {
                maybeAddCandidate(matches, device, "paired");
            }
        }
        return encodeCandidates(matches);
    }

    public String scanCandidatesJson(int timeoutMs) throws InterruptedException {
        LinkedHashMap<String, CandidateDevice> matches = new LinkedHashMap<>();
        BluetoothLeScanner scanner = bluetoothAdapter.getBluetoothLeScanner();
        if (scanner == null) {
          return encodeCandidates(matches);
        }
        final ScanCallback callback = new ScanCallback() {
            @Override
            public void onScanResult(int callbackType, ScanResult result) {
                if (result == null) {
                    return;
                }
                maybeAddCandidate(matches, result.getDevice(), "scan");
            }

            @Override
            public void onBatchScanResults(java.util.List<ScanResult> results) {
                if (results == null) {
                    return;
                }
                for (ScanResult result : results) {
                    if (result != null) {
                        maybeAddCandidate(matches, result.getDevice(), "scan");
                    }
                }
            }
        };
        scanner.startScan(
                null,
                new ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build(),
                callback
        );
        try {
            Thread.sleep(Math.max(500, timeoutMs));
        } finally {
            try {
                scanner.stopScan(callback);
            } catch (Throwable ignored) {
            }
        }
        return encodeCandidates(matches);
    }

    private void maybeAddCandidate(Map<String, CandidateDevice> matches, BluetoothDevice device, String source) {
        if (device == null) {
            return;
        }
        String name = device.getName();
        String role = classifyRole(name);
        if (role == null) {
            return;
        }
        String address = device.getAddress();
        if (address == null || address.isEmpty()) {
            return;
        }
        matches.put(address, new CandidateDevice(address, name == null ? "" : name, role, source));
    }

    private String classifyRole(String name) {
        if (name == null) {
            return null;
        }
        if (RIGHT_NAME.matcher(name).matches()) {
            return "right";
        }
        if (LEFT_NAME.matcher(name).matches()) {
            return "left";
        }
        if (RING_NAME.matcher(name).matches()) {
            return "ring";
        }
        return null;
    }

    private String encodeCandidates(Map<String, CandidateDevice> matches) {
        JSONArray array = new JSONArray();
        for (CandidateDevice candidate : matches.values()) {
            JSONObject object = new JSONObject();
            try {
                object.put("address", candidate.address);
                object.put("name", candidate.name);
                object.put("role", candidate.role);
                object.put("source", candidate.source);
                array.put(object);
            } catch (JSONException ignored) {
            }
        }
        return array.toString();
    }

    private static final class CandidateDevice {
        final String address;
        final String name;
        final String role;
        final String source;

        CandidateDevice(String address, String name, String role, String source) {
            this.address = address;
            this.name = name;
            this.role = role;
            this.source = source;
        }
    }
}
