package com.faceclaw.app;

import android.bluetooth.BluetoothGatt;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import java.util.List;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * A minimal, stock-firmware-compatible BLE communicator used only to show the
 * pre-flash confirmation prompt on the glasses and read back the user's Yes/No
 * choice. It is deliberately separate from FaceclawBleCommunicator: the main
 * app assumes the custom firmware (image containers, compositor, etc.), whereas
 * this must work on unmodified glasses, so it speaks only the stock subset —
 * session prelude, a text container, a list container, and heartbeats. No
 * images.
 *
 * It reuses the low-level GATT wrapper (FaceclawBleManager) and the framing /
 * protobuf helpers (BleProtocol), but owns its own GATT connection and runs its
 * whole lifecycle on a single worker thread. It expects the main app to be
 * disconnected while it runs (onboarding, before flashing).
 *
 * Only the right arm is used: the lenses relay messages to each other, so
 * anything sent to the right arm reaches both, and acks/events only ever come
 * from the right arm anyway.
 */
public class FaceclawFlashPromptCommunicator implements FaceclawBleListener {
    private static final String TAG = "FaceclawFlashPrompt";

    private static final String TEXT_NAME = "flashwarn";
    private static final String LIST_NAME = "flashmenu";
    private static final int TEXT_CONTAINER_ID = 1;
    private static final int LIST_CONTAINER_ID = 2;
    // Index 0 = decline, index 1 = approve. Kept short for the ~50-col grid.
    private static final String[] ITEMS = new String[] {"No, cancel", "Yes, flash"};

    private static final int HEARTBEAT_INTERVAL_MS = 4_000;
    private static final int SELECTION_TIMEOUT_MS = 120_000;
    private static final int CREATE_ACK_TIMEOUT_MS = 3_000;

    private final Context context;
    private final String rightAddress;
    private final String warningText;
    private final FaceclawBleManager bleManager;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private final Object lock = new Object();
    private final ConcurrentHashMap<String, CountDownLatch> pendingAcks = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, byte[]> ackPayloads = new ConcurrentHashMap<>();
    private final CountDownLatch selectionLatch = new CountDownLatch(1);

    private volatile FaceclawFlashPromptListener listener;
    private volatile Thread worker;
    private volatile boolean cancelled = false;
    private volatile boolean finished = false;
    private volatile boolean rightConnected = false;
    private volatile boolean rightLost = false;
    private volatile Boolean approved = null;
    private volatile ScheduledExecutorService heartbeatExecutor;

    private int nextMagic = 100;
    private int nextSeq = 0x40;

    public FaceclawFlashPromptCommunicator(Context context, String rightAddress, String warningText) {
        this.context = context.getApplicationContext();
        this.rightAddress = rightAddress == null ? "" : rightAddress;
        this.warningText = warningText == null ? "" : warningText;
        this.bleManager = new FaceclawBleManager(this.context);
        this.bleManager.setListener(this);
    }

    public void setListener(FaceclawFlashPromptListener listener) {
        this.listener = listener;
    }

    public void start() {
        synchronized (lock) {
            if (worker != null) {
                return;
            }
            worker = new Thread(this::run, "faceclaw-flash-prompt");
            worker.start();
        }
    }

    /** Abort the prompt (e.g. the user backed out on the phone). */
    public void cancel() {
        cancelled = true;
        selectionLatch.countDown();
        Thread w = worker;
        if (w != null) {
            w.interrupt();
        }
    }

    public void close() {
        cancel();
        stopHeartbeat();
        try {
            bleManager.close();
        } catch (Exception ignored) {
        }
    }

    private void run() {
        try {
            if (rightAddress.trim().isEmpty()) {
                emitState("error", "No right-arm address configured.");
                return;
            }

            emitState("connecting", "");
            connectArm(rightAddress);
            rightConnected = true;
            if (cancelled) {
                teardown();
                return;
            }

            emitState("connected", "");
            bringUpArm(rightAddress);

            startHeartbeat();
            emitState("prompting", "");

            boolean signalled = selectionLatch.await(SELECTION_TIMEOUT_MS, TimeUnit.MILLISECONDS);
            stopHeartbeat();

            if (cancelled) {
                emitState("cancelled", "");
                teardown();
                return;
            }
            if (approved != null) {
                boolean result = Boolean.TRUE.equals(approved);
                try {
                    sendShutdown();
                } catch (Exception ignored) {
                }
                emitResult(result);
                emitState("result", result ? "approved" : "declined");
                teardown();
                return;
            }
            if (rightLost) {
                emitState("disconnected", "Lost connection to the glasses.");
            } else {
                emitState("timeout", "No response from the glasses.");
            }
            teardown();
        } catch (Exception e) {
            stopHeartbeat();
            if (!cancelled) {
                String message = e.getMessage() == null ? e.toString() : e.getMessage();
                emitState("error", message);
            }
            teardown();
        }
    }

    private void connectArm(String address) {
        if (!bleManager.connect(address, ConnectionOptions.CONNECT_TIMEOUT_MS)) {
            throw new IllegalStateException("connect failed: " + address);
        }
        bleManager.requestConnectionPriority(address, BluetoothGatt.CONNECTION_PRIORITY_HIGH);
        bleManager.requestMtu(address, ConnectionOptions.DESIRED_MTU, ConnectionOptions.CONNECT_TIMEOUT_MS);
        if (!bleManager.discoverServices(address, ConnectionOptions.SERVICES_TIMEOUT_MS)) {
            throw new IllegalStateException("discoverServices failed: " + address);
        }
        if (!bleManager.enableNotifications(address, BleProtocol.NOTIFY_CHAR_UUID, true, ConnectionOptions.DESCRIPTOR_TIMEOUT_MS)) {
            throw new IllegalStateException("enableNotifications failed: " + address);
        }
        emitLog("connected right arm");
    }

    private void bringUpArm(String address) throws InterruptedException {
        // 1. Security-auth exchange on sid=0x80: firmware 2.2.9 will not run a
        //    session (and closes the link after ~30 s) without it, and on an
        //    unbonded phone this is what triggers SMP pairing, so it may sit
        //    waiting on an OS pairing prompt.
        int authMagic = allocMagic();
        byte[] authAck = writeAndAwaitAck(
            address,
            BleProtocol.SID_SECURITY_AUTH,
            BleProtocol.FLAG_SECURITY_AUTH,
            authMagic,
            BleProtocol.buildAuthenticationRequest(authMagic),
            ConnectionOptions.SECURITY_AUTH_TIMEOUT_MS);
        if (authAck == null || !BleProtocol.isAuthenticationSuccess(authAck, authMagic)) {
            throw new IllegalStateException(
                "could not authenticate with the glasses (" + address
                    + ") — if Android shows a Bluetooth pairing request, accept it and try again");
        }
        // 2. Mandatory session prelude on sid=0x01 (app-launch).
        if (writeAndAwaitAck(
                address,
                BleProtocol.PRELUDE_ACK_SID,
                BleProtocol.FLAG_REQUEST,
                BleProtocol.PRELUDE_ACK_MAGIC,
                BleProtocol.PRELUDE_F5872_PAYLOAD,
                ConnectionOptions.PRELUDE_TIMEOUT_MS) == null) {
            throw new IllegalStateException("session prelude not acked: " + address);
        }
        // 3. Create the prompt page (warning text + No/Yes list) on sid=0xe0 Cmd=0.
        //    Two attempts: on 2.2.9 the first request sent right after the
        //    prelude can be dropped while the lens emits its own sid-0x80
        //    notifications (observed with the device-info settings read).
        byte[] pageAck = null;
        for (int attempt = 0; attempt < 2 && pageAck == null && !cancelled; attempt++) {
            int magic = allocMagic();
            byte[] page = BleProtocol.buildCreatePromptPage(
                magic, TEXT_NAME, TEXT_CONTAINER_ID, warningText, LIST_NAME, LIST_CONTAINER_ID, ITEMS);
            pageAck = writeAndAwaitAck(address, BleProtocol.SID_EVENHUB, BleProtocol.FLAG_REQUEST, magic, page, CREATE_ACK_TIMEOUT_MS);
            if (pageAck == null) {
                emitLog("prompt page attempt " + (attempt + 1) + " unacked: " + address);
            }
        }
        if (pageAck == null) {
            throw new IllegalStateException("prompt page not acked: " + address);
        }
        emitLog("prompt page shown on " + address);
    }

    /** Write and wait for the matching ack; returns the ack's protobuf (may be empty), or null on timeout/write failure. */
    private byte[] writeAndAwaitAck(String address, int sid, int flag, int magic, byte[] payload, int timeoutMs)
            throws InterruptedException {
        CountDownLatch latch = new CountDownLatch(1);
        String key = ackKey(sid, magic);
        pendingAcks.put(key, latch);
        try {
            if (!writeFrame(address, sid, flag, payload)) {
                return null;
            }
            if (!latch.await(timeoutMs, TimeUnit.MILLISECONDS)) {
                return null;
            }
            byte[] pb = ackPayloads.get(key);
            return pb == null ? new byte[0] : pb;
        } finally {
            pendingAcks.remove(key, latch);
            ackPayloads.remove(key);
        }
    }

    private boolean writeFrame(String address, int sid, int flag, byte[] payload) {
        int seq;
        synchronized (lock) {
            seq = nextSeq++ & 0xff;
        }
        List<byte[]> frames = BleProtocol.framePb(payload, sid, flag, seq);
        return bleManager.writeFrames(
            address,
            BleProtocol.WRITE_CHAR_UUID,
            frames,
            ConnectionOptions.WRITE_TYPE,
            ConnectionOptions.WRITE_TIMEOUT_MS);
    }

    private void startHeartbeat() {
        stopHeartbeat();
        ScheduledExecutorService executor = Executors.newSingleThreadScheduledExecutor(runnable -> {
            Thread t = new Thread(runnable, "faceclaw-flash-hb");
            t.setDaemon(true);
            return t;
        });
        heartbeatExecutor = executor;
        executor.scheduleWithFixedDelay(
            this::sendHeartbeat, HEARTBEAT_INTERVAL_MS, HEARTBEAT_INTERVAL_MS, TimeUnit.MILLISECONDS);
    }

    private void sendHeartbeat() {
        if (finished || cancelled) {
            return;
        }
        try {
            byte[] heartbeat = BleProtocol.buildHeartbeat(allocMagic());
            if (rightConnected) {
                writeFrame(rightAddress, BleProtocol.SID_EVENHUB, BleProtocol.FLAG_REQUEST, heartbeat);
            }
        } catch (Exception e) {
            Log.w(TAG, "heartbeat failed: " + e.getMessage());
        }
    }

    private void stopHeartbeat() {
        ScheduledExecutorService executor = heartbeatExecutor;
        heartbeatExecutor = null;
        if (executor != null) {
            executor.shutdownNow();
        }
    }

    private void sendShutdown() {
        byte[] shutdown = BleProtocol.buildShutdown(allocMagic(), 0);
        if (rightConnected) {
            writeFrame(rightAddress, BleProtocol.SID_EVENHUB, BleProtocol.FLAG_REQUEST, shutdown);
        }
    }

    private void teardown() {
        finished = true;
        stopHeartbeat();
        try {
            bleManager.close();
        } catch (Exception ignored) {
        }
        rightConnected = false;
    }

    @Override
    public void onNotification(String address, String characteristicUuid, byte[] data) {
        if (!BleProtocol.NOTIFY_CHAR_UUID.equalsIgnoreCase(characteristicUuid)) {
            return;
        }
        // A value can carry several envelope frames back to back.
        for (byte[] buf : BleProtocol.splitFrames(data)) {
            handleFrame(address, buf);
        }
    }

    private void handleFrame(String address, byte[] buf) {
        BleProtocol.ParsedFrame frame = BleProtocol.parseFrame(buf);
        if (!frame.ok) {
            return;
        }
        if (frame.flag == BleProtocol.FLAG_NOTIFY || frame.flag == BleProtocol.FLAG_NOTIFY_ALT) {
            handleEvent(frame);
            return;
        }
        if (frame.msgSeq >= 0) {
            String key = ackKey(frame.sid, frame.msgSeq);
            CountDownLatch latch = pendingAcks.get(key);
            if (latch != null) {
                ackPayloads.put(key, frame.pb);
                latch.countDown();
            }
        }
    }

    private void handleEvent(BleProtocol.ParsedFrame frame) {
        BleProtocol.ListSelection selection = BleProtocol.parseListSelection(frame);
        if (selection == null || !LIST_NAME.equals(selection.containerName)) {
            return;
        }
        // Only a confirmed click is a decision; scroll/highlight changes are ignored.
        if (selection.eventType != BleProtocol.EVENT_CLICK) {
            return;
        }
        boolean yes = selection.itemIndex == 1
            || (selection.itemName != null && selection.itemName.toLowerCase().startsWith("yes"));
        synchronized (lock) {
            if (finished) {
                return;
            }
            finished = true;
            approved = yes;
        }
        emitLog("selection: " + (yes ? "flash" : "cancel") + " (index " + selection.itemIndex + ")");
        selectionLatch.countDown();
    }

    @Override
    public void onConnectionStateChange(String address, boolean connected) {
        if (connected) {
            return;
        }
        if (address.equalsIgnoreCase(rightAddress)) {
            rightConnected = false;
            synchronized (lock) {
                if (!finished && !cancelled) {
                    rightLost = true;
                    finished = true;
                    selectionLatch.countDown();
                }
            }
        }
    }

    private int allocMagic() {
        synchronized (lock) {
            int magic = nextMagic;
            nextMagic = nextMagic >= 255 ? 100 : nextMagic + 1;
            return magic;
        }
    }

    private static String ackKey(int sid, int magic) {
        return sid + ":" + magic;
    }

    private void emitLog(String line) {
        Log.i(TAG, line);
        mainHandler.post(() -> {
            FaceclawFlashPromptListener current = listener;
            if (current != null) {
                current.onLog(line);
            }
        });
    }

    private void emitState(String state, String detail) {
        final String safeDetail = detail == null ? "" : detail;
        mainHandler.post(() -> {
            FaceclawFlashPromptListener current = listener;
            if (current != null) {
                current.onState(state, safeDetail);
            }
        });
    }

    private void emitResult(boolean approvedResult) {
        mainHandler.post(() -> {
            FaceclawFlashPromptListener current = listener;
            if (current != null) {
                current.onResult(approvedResult);
            }
        });
    }
}
