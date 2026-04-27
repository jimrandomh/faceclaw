package com.faceclaw.app;

import android.annotation.SuppressLint;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;

import java.util.List;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

@SuppressLint("MissingPermission")
public class FaceclawBleManager {
    private static final String TAG = "FaceclawBle";
    private static final int[] WRITE_RETRY_DELAYS_MS = new int[] {4, 8, 12, 20, 35, 100, 200};

    private final Context context;
    private final BluetoothAdapter bluetoothAdapter;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private final ConcurrentHashMap<String, BluetoothGatt> gattClients = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, Object> writeLocks = new ConcurrentHashMap<>();

    private final ConcurrentHashMap<String, CountDownLatch> connectLatches = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, Boolean> connectResults = new ConcurrentHashMap<>();

    private final ConcurrentHashMap<String, CountDownLatch> servicesLatches = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, Integer> servicesStatuses = new ConcurrentHashMap<>();

    private final ConcurrentHashMap<String, CountDownLatch> mtuLatches = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, Integer> mtuStatuses = new ConcurrentHashMap<>();

    private final ConcurrentHashMap<String, CountDownLatch> descriptorLatches = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, Integer> descriptorStatuses = new ConcurrentHashMap<>();

    private final ConcurrentHashMap<String, CountDownLatch> writeLatches = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, Integer> writeStatuses = new ConcurrentHashMap<>();

    private volatile FaceclawBleListener listener;

    public FaceclawBleManager(Context context) {
        this.context = context.getApplicationContext();
        BluetoothManager bluetoothManager = (BluetoothManager) this.context.getSystemService(Context.BLUETOOTH_SERVICE);
        if (bluetoothManager == null || bluetoothManager.getAdapter() == null) {
            throw new IllegalStateException("Bluetooth adapter unavailable");
        }
        this.bluetoothAdapter = bluetoothManager.getAdapter();
    }

    public void setListener(FaceclawBleListener listener) {
        this.listener = listener;
    }

    public boolean connect(String address, int timeoutMs) {
        if (address == null || address.trim().isEmpty()) {
            throw new IllegalArgumentException("address is required");
        }
        BluetoothGatt existing = gattClients.get(address);
        if (existing != null) {
            return true;
        }

        final BluetoothDevice device = bluetoothAdapter.getRemoteDevice(address);
        if (device == null) {
            throw new IllegalArgumentException("remote device not found: " + address);
        }

        CountDownLatch latch = new CountDownLatch(1);
        connectLatches.put(address, latch);
        connectResults.remove(address);

        BluetoothGatt gatt = runOnMainSync(() -> device.connectGatt(
                context,
                false,
                gattCallback,
                BluetoothDevice.TRANSPORT_LE,
                BluetoothDevice.PHY_LE_2M|BluetoothDevice.PHY_LE_1M
        ));
        if (gatt == null) {
            connectLatches.remove(address);
            return false;
        }
        gattClients.put(address, gatt);

        if (!awaitLatch(latch, timeoutMs)) {
            connectLatches.remove(address);
            connectResults.remove(address);
            return false;
        }

        gatt.readPhy();
        Boolean connected = connectResults.remove(address);
        connectLatches.remove(address);
        return Boolean.TRUE.equals(connected);
    }

    public boolean requestConnectionPriority(String address, int priority) {
        BluetoothGatt gatt = requireGatt(address);
        return runOnMainSync(() -> gatt.requestConnectionPriority(priority));
    }

    public boolean requestMtu(String address, int mtu, int timeoutMs) {
        BluetoothGatt gatt = requireGatt(address);
        CountDownLatch latch = new CountDownLatch(1);
        mtuLatches.put(address, latch);
        mtuStatuses.remove(address);

        boolean started = runOnMainSync(() -> gatt.requestMtu(mtu));
        if (!started) {
            mtuLatches.remove(address);
            return false;
        }
        if (!awaitLatch(latch, timeoutMs)) {
            mtuLatches.remove(address);
            mtuStatuses.remove(address);
            return false;
        }
        Integer status = mtuStatuses.remove(address);
        mtuLatches.remove(address);
        return status != null && status == BluetoothGatt.GATT_SUCCESS;
    }

    public boolean discoverServices(String address, int timeoutMs) {
        BluetoothGatt gatt = requireGatt(address);
        CountDownLatch latch = new CountDownLatch(1);
        servicesLatches.put(address, latch);
        servicesStatuses.remove(address);

        boolean started = runOnMainSync(gatt::discoverServices);
        if (!started) {
            servicesLatches.remove(address);
            return false;
        }
        if (!awaitLatch(latch, timeoutMs)) {
            servicesLatches.remove(address);
            servicesStatuses.remove(address);
            return false;
        }
        Integer status = servicesStatuses.remove(address);
        servicesLatches.remove(address);
        return status != null && status == BluetoothGatt.GATT_SUCCESS;
    }

    public boolean enableNotifications(String address, String characteristicUuid, boolean enable, int timeoutMs) {
        BluetoothGatt gatt = requireGatt(address);
        BluetoothGattCharacteristic characteristic = requireCharacteristic(gatt, characteristicUuid);

        boolean notificationSet = runOnMainSync(() -> gatt.setCharacteristicNotification(characteristic, enable));
        if (!notificationSet) {
            return false;
        }

        BluetoothGattDescriptor descriptor = characteristic.getDescriptor(BleProtocol.CCCD_UUID);
        if (descriptor == null) {
            return true;
        }

        CountDownLatch latch = new CountDownLatch(1);
        descriptorLatches.put(address, latch);
        descriptorStatuses.remove(address);

        descriptor.setValue(enable
                ? BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                : BluetoothGattDescriptor.DISABLE_NOTIFICATION_VALUE);
        boolean started = runOnMainSync(() -> gatt.writeDescriptor(descriptor));
        if (!started) {
            descriptorLatches.remove(address);
            return false;
        }
        if (!awaitLatch(latch, timeoutMs)) {
            descriptorLatches.remove(address);
            descriptorStatuses.remove(address);
            return false;
        }
        Integer status = descriptorStatuses.remove(address);
        descriptorLatches.remove(address);
        return status != null && status == BluetoothGatt.GATT_SUCCESS;
    }

    public boolean writeFrames(
        String address,
        String characteristicUuid,
        List<byte[]> frames,
        int writeType,
        int timeoutMs
    ) {
        if (frames == null || frames.isEmpty()) {
            return true;
        }
        Log.i(TAG, "Called writeFrames with writeType=" + writeType + ", " + frames.size() + " frames totaling " + frames.stream().mapToInt(frame -> frame != null ? frame.length : 0).sum() + " bytes");

        BluetoothGatt gatt = requireGatt(address);
        BluetoothGattCharacteristic characteristic = requireCharacteristic(gatt, characteristicUuid);

        for (int i = 0; i < frames.size(); i++) {
            Log.i(TAG, "writeFrames starting frame " + i);
            byte[] frame = frames.get(i);
            if (!startWrite(gatt, characteristic, address, frame, writeType, timeoutMs)) {
                return false;
            }
        }
        return true;
    }

    private boolean startWrite(
            BluetoothGatt gatt,
            BluetoothGattCharacteristic characteristic,
            String address,
            byte[] data,
            int writeType,
            int timeoutMs
    ) {
        boolean retry = false;
        int retryCount = 0;
        while (true) {
            long currentTime = System.currentTimeMillis();
            int result = gatt.writeCharacteristic(characteristic, data, writeType);
            long timeAsleep = System.currentTimeMillis() - currentTime;
            //Log.i(TAG, "writeCharacteristic: spent " + timeAsleep + "ms");

            if (result == android.bluetooth.BluetoothStatusCodes.ERROR_GATT_WRITE_REQUEST_BUSY) {
                if (++retryCount < 25) {
                    try {
                        long currentTime2 = System.currentTimeMillis();
                        Thread.sleep(1);
                        long timeAsleep2 = System.currentTimeMillis() - currentTime2;
                        //Log.i(TAG, "writeCharacteristic: slept for " + timeAsleep2 + "ms");
                    } catch (InterruptedException e) {}
                } else {
                    return false;
                }
            } else {
                //Log.i(TAG, "writeCharacteristic with writeType=" + writeType + " result=" + result + " retryCount=" + retryCount);
                return result == android.bluetooth.BluetoothStatusCodes.SUCCESS;
            }
        }
    }

    public void disconnect(String address) {
        BluetoothGatt gatt = gattClients.remove(address);
        if (gatt == null) {
            return;
        }
        runOnMainAsync(() -> {
            gatt.disconnect();
            gatt.close();
        });
    }

    public void close() {
        for (String address : gattClients.keySet()) {
            disconnect(address);
        }
    }

    private BluetoothGatt requireGatt(String address) {
        BluetoothGatt gatt = gattClients.get(address);
        if (gatt == null) {
            throw new IllegalStateException("Not connected: " + address);
        }
        return gatt;
    }

    private BluetoothGattCharacteristic requireCharacteristic(BluetoothGatt gatt, String characteristicUuid) {
        UUID target = UUID.fromString(characteristicUuid);
        for (BluetoothGattService service : gatt.getServices()) {
            BluetoothGattCharacteristic characteristic = service.getCharacteristic(target);
            if (characteristic != null) {
                return characteristic;
            }
        }
        throw new IllegalStateException("Characteristic not found: " + characteristicUuid);
    }

    private boolean awaitLatch(CountDownLatch latch, int timeoutMs) {
        try {
            return latch.await(timeoutMs, TimeUnit.MILLISECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return false;
        }
    }

    private void runOnMainAsync(Runnable runnable) {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            runnable.run();
        } else {
            mainHandler.post(runnable);
        }
    }

    private <T> T runOnMainSync(Callable<T> callable) {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            try {
                return callable.call();
            } catch (Exception e) {
                throw new RuntimeException(e);
            }
        }

        CountDownLatch latch = new CountDownLatch(1);
        AtomicReference<T> result = new AtomicReference<>();
        AtomicReference<RuntimeException> error = new AtomicReference<>();

        mainHandler.post(() -> {
            try {
                result.set(callable.call());
            } catch (Exception e) {
                error.set(new RuntimeException(e));
            } finally {
                latch.countDown();
            }
        });

        awaitLatch(latch, 10_000);
        if (error.get() != null) {
            throw error.get();
        }
        return result.get();
    }

    private final BluetoothGattCallback gattCallback = new BluetoothGattCallback() {
        @Override
        public void onConnectionStateChange(BluetoothGatt gatt, int status, int newState) {
            String address = gatt.getDevice().getAddress();

            if (newState == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS) {
                connectResults.put(address, true);
                CountDownLatch latch = connectLatches.remove(address);
                if (latch != null) {
                    latch.countDown();
                }
                dispatchConnectionState(address, true);
                return;
            }

            if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                connectResults.put(address, false);
                CountDownLatch latch = connectLatches.remove(address);
                if (latch != null) {
                    latch.countDown();
                }
                gattClients.remove(address);
                writeLocks.remove(address);
                runOnMainAsync(gatt::close);
                dispatchConnectionState(address, false);
            }
        }

        @Override
        public void onServicesDiscovered(BluetoothGatt gatt, int status) {
            String address = gatt.getDevice().getAddress();
            servicesStatuses.put(address, status);
            CountDownLatch latch = servicesLatches.remove(address);
            if (latch != null) {
                latch.countDown();
            }
        }

        @Override
        public void onMtuChanged(BluetoothGatt gatt, int mtu, int status) {
            String address = gatt.getDevice().getAddress();
            mtuStatuses.put(address, status);
            CountDownLatch latch = mtuLatches.remove(address);
            if (latch != null) {
                latch.countDown();
            }
        }

        @Override
        public void onPhyRead(BluetoothGatt gatt, int txPhy, int rxPhy, int status) {
            Log.i(TAG, "onPhyRead: txPhy=" + txPhy + " rxPhy=" + rxPhy + " status=" + status);
        }

        @Override
        public void onDescriptorWrite(BluetoothGatt gatt, BluetoothGattDescriptor descriptor, int status) {
            String address = gatt.getDevice().getAddress();
            descriptorStatuses.put(address, status);
            CountDownLatch latch = descriptorLatches.remove(address);
            if (latch != null) {
                latch.countDown();
            }
        }

        @Override
        public void onCharacteristicWrite(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic, int status) {
            String address = gatt.getDevice().getAddress();
            writeStatuses.put(address, status);
            CountDownLatch latch = writeLatches.remove(address);
            if (latch != null) {
                latch.countDown();
            }
        }

        @Override
        public void onCharacteristicChanged(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic, byte[] value) {
            Log.i(TAG, "onCharacteristicChanged");
            dispatchNotification(gatt.getDevice().getAddress(), characteristic.getUuid().toString(), value);
        }

        @Deprecated
        @Override
        public void onCharacteristicChanged(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic) {
            dispatchNotification(gatt.getDevice().getAddress(), characteristic.getUuid().toString(), characteristic.getValue());
        }
    };

    private void dispatchConnectionState(String address, boolean connected) {
        FaceclawBleListener current = listener;
        if (current == null) {
            return;
        }
        runOnMainAsync(() -> current.onConnectionStateChange(address, connected));
    }

    private void dispatchNotification(String address, String characteristicUuid, byte[] data) {
        Log.i(TAG, "dispatchNotification");
        FaceclawBleListener current = listener;
        if (current == null) {
            return;
        }
        byte[] copy = data != null ? data.clone() : new byte[0];
        runOnMainAsync(() -> current.onNotification(address, characteristicUuid, copy));
    }
}
