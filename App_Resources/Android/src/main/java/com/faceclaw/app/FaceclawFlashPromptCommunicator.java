package com.faceclaw.app;

import android.bluetooth.BluetoothGatt;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
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
 * Both arms are connected and security-authenticated up front, even though the
 * prompt itself only needs the right arm (the lenses relay messages to each
 * other, and acks/events only ever come from the right arm): on an unbonded
 * phone the auth exchange is what raises the OS pairing prompt, and doing both
 * here means both prompts appear at the start rather than one popping up half
 * way through flashing the second lens. While connected, each arm's battery
 * level is read (they are independent batteries) so the caller can refuse to
 * flash on a low charge.
 *
 * With `skipPrompt` the on-glasses confirmation is not shown: the flow is just
 * connect + auth + battery read + result(approved). Used to re-check the
 * battery after the user has already confirmed once.
 */
public class FaceclawFlashPromptCommunicator implements FaceclawBleListener {
    private static final String TAG = "FaceclawFlashPrompt";

    private static final String TEXT_NAME = "flashwarn";
    private static final String LIST_NAME = "flashmenu";
    private static final int TEXT_CONTAINER_ID = 1;
    private static final int LIST_CONTAINER_ID = 2;
    // Index 0 = decline, index 1 = approve. Kept short for the ~50-col grid.
    private static final String[] ITEMS = new String[] {"No, cancel", "Yes, flash"};

    /**
     * Shown instead of a bare "prompt page not acked" timeout. Silent mode is
     * entered and left by the same gesture on the glasses and nothing here can
     * clear it, so the instruction has to travel with the error.
     */
    private static final String SILENT_MODE_MESSAGE =
            "Your glasses are in silent mode, so they cannot show the confirmation prompt. "
                    + "Long-press both touchpads on the glasses to leave silent mode, then try again.";

    private static final int HEARTBEAT_INTERVAL_MS = 4_000;
    private static final int SELECTION_TIMEOUT_MS = 120_000;
    private static final int CREATE_ACK_TIMEOUT_MS = 3_000;
    private static final int BATTERY_ACK_TIMEOUT_MS = 3_000;
    /**
     * A single connect attempt is not enough. The lens is routinely unavailable for a
     * moment right after a previous link to it closed, which is exactly the situation
     * this class is in whenever the user retries. FaceclawFirmwareFlasher already
     * retries within a window for the same reason; this matches it rather than
     * failing on the first refusal.
     */
    private static final int ARM_CONNECT_WINDOW_MS = 30_000;
    private static final int ARM_RETRY_DELAY_MS = 2_500;

    private final Context context;
    private final String rightAddress;
    private final String leftAddress;
    private final String warningText;
    private final boolean skipPrompt;
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
    private volatile boolean leftConnected = false;
    private volatile boolean rightLost = false;
    /**
     * True while the arms are still being brought up. connectArmResilient disconnects
     * between retries, which fires onConnectionStateChange, and that callback latches
     * rightLost AND finished -- so without this guard a deliberate retry-disconnect
     * ends the whole run, even when the very next attempt connects. Only a drop AFTER
     * both arms are up is a lost connection.
     */
    private volatile boolean establishing = true;
    private volatile Boolean approved = null;
    private volatile ScheduledExecutorService heartbeatExecutor;

    private int nextMagic = 100;
    private int nextSeq = 0x40;

    public FaceclawFlashPromptCommunicator(
            Context context, String rightAddress, String leftAddress, String warningText, boolean skipPrompt) {
        this.context = context.getApplicationContext();
        this.rightAddress = rightAddress == null ? "" : rightAddress;
        this.leftAddress = leftAddress == null ? "" : leftAddress;
        this.warningText = warningText == null ? "" : warningText;
        this.skipPrompt = skipPrompt;
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
        } catch (Exception e) {
            Log.w(TAG, "close: ble manager close failed", e);
        }
    }

    private void run() {
        try {
            if (rightAddress.trim().isEmpty()) {
                emitState("error", "No right-arm address configured.");
                return;
            }

            emitState("connecting", "");
            connectArm(rightAddress, "right");
            rightConnected = true;
            if (cancelled) {
                teardown();
                return;
            }
            if (!leftAddress.trim().isEmpty()) {
                connectArm(leftAddress, "left");
                leftConnected = true;
                if (cancelled) {
                    teardown();
                    return;
                }
            }

            // Both arms are up: from here a disconnect really is a lost connection.
            establishing = false;
            emitState("connected", "");
            // Auth both arms now (pairing prompts, if any, happen here) before
            // anything else, so both bonds exist by the time flashing starts.
            authenticateArm(rightAddress, "right");
            if (leftConnected) {
                authenticateArm(leftAddress, "left");
            }
            if (cancelled) {
                teardown();
                return;
            }
            sendPrelude(rightAddress);

            if (!skipPrompt) {
                // Ask before writing a page that cannot be answered: silent mode
                // blanks the display and stops the firmware dispatching input while
                // BLE stays up, so the create-prompt write is still accepted and the
                // flash would spend four attempts timing out on an error that says
                // nothing about the reason.
                requireNotSilent(rightAddress);
                showPrompt(rightAddress);
                startHeartbeat();
                emitState("prompting", "");

                selectionLatch.await(SELECTION_TIMEOUT_MS, TimeUnit.MILLISECONDS);
                stopHeartbeat();

                if (cancelled) {
                    emitState("cancelled", "");
                    teardown();
                    return;
                }
                if (approved == null) {
                    if (rightLost) {
                        emitState("disconnected", "Lost connection to the glasses.");
                    } else {
                        emitState("timeout", "No response from the glasses.");
                    }
                    teardown();
                    return;
                }
                try {
                    sendShutdown();
                } catch (Exception e) {
                    // The lens is about to be torn down either way, but a shutdown that
                    // never lands is why it can come back up in an odd state.
                    Log.w(TAG, "sendShutdown failed", e);
                }
                if (!Boolean.TRUE.equals(approved)) {
                    emitResult(false);
                    emitState("result", "declined");
                    teardown();
                    return;
                }
            }

            // Approved (or prompt skipped): read each arm's battery while the
            // links are still up, then report the result.
            emitState("battery", "");
            readBatteries();
            if (cancelled) {
                emitState("cancelled", "");
                teardown();
                return;
            }
            if (rightLost) {
                emitState("disconnected", "Lost connection to the glasses.");
                teardown();
                return;
            }
            finished = true;
            emitResult(true);
            emitState("result", "approved");
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

    private void connectArm(String address, String arm) {
        connectArmResilient(address, arm);
        bleManager.requestConnectionPriority(address, BluetoothGatt.CONNECTION_PRIORITY_HIGH);
        bleManager.requestMtu(address, ConnectionOptions.DESIRED_MTU, ConnectionOptions.CONNECT_TIMEOUT_MS);
        if (!bleManager.discoverServices(address, ConnectionOptions.SERVICES_TIMEOUT_MS)) {
            throw new IllegalStateException("discoverServices failed: " + arm + " arm (" + address + ")");
        }
        if (!bleManager.enableNotifications(address, BleProtocol.NOTIFY_CHAR_UUID, true, ConnectionOptions.DESCRIPTOR_TIMEOUT_MS)) {
            throw new IllegalStateException("enableNotifications failed: " + arm + " arm (" + address + ")");
        }
        emitLog("connected " + arm + " arm");
    }

    private void sleepInterruptibly(int ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    /**
     * Keep trying to open the link until the window closes, reporting each attempt.
     * Mirrors FaceclawFirmwareFlasher.connectLensResilient.
     */
    private void connectArmResilient(String address, String arm) {
        long deadline = SystemClock.elapsedRealtime() + ARM_CONNECT_WINDOW_MS;
        String lastError = "unknown";
        int attempt = 0;
        while (SystemClock.elapsedRealtime() < deadline && !cancelled) {
            attempt++;
            try {
                if (bleManager.connect(address, ConnectionOptions.CONNECT_TIMEOUT_MS)) {
                    if (attempt > 1) {
                        emitLog("connected " + arm + " arm (attempt " + attempt + ")");
                    }
                    return;
                }
                lastError = "connect refused";
            } catch (Exception e) {
                lastError = e.getMessage() == null ? e.toString() : e.getMessage();
            }
            emitLog(arm + " arm connect attempt " + attempt + " failed (" + lastError + "); retrying...");
            try {
                bleManager.disconnect(address);
            } catch (Exception e) {
                // Expected between retries: the link is usually already gone.
                Log.d(TAG, "disconnect before retry failed: address=" + address, e);
            }
            sleepInterruptibly(ARM_RETRY_DELAY_MS);
        }
        if (cancelled) {
            throw new IllegalStateException("Cancelled.");
        }
        throw new IllegalStateException(
                "could not connect to the " + arm + " arm after " + attempt + " attempts: " + lastError);
    }

    /**
     * Security-auth exchange on sid=0x80: firmware 2.2.9 will not run a
     * session (and closes the link after ~30 s) without it, and on an
     * unbonded phone this is what triggers SMP pairing, so it may sit
     * waiting on an OS pairing prompt.
     */
    private void authenticateArm(String address, String arm) throws InterruptedException {
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
                "could not authenticate with the " + arm + " arm (" + address
                    + ") — if Android shows a Bluetooth pairing request, accept it and try again");
        }
        emitLog("security auth complete: " + arm + " arm");
    }

    /** Mandatory session prelude on sid=0x01 (app-launch). Right arm only; it relays. */
    private void sendPrelude(String address) throws InterruptedException {
        if (writeAndAwaitAck(
                address,
                BleProtocol.PRELUDE_ACK_SID,
                BleProtocol.FLAG_REQUEST,
                BleProtocol.PRELUDE_ACK_MAGIC,
                BleProtocol.PRELUDE_F5872_PAYLOAD,
                ConnectionOptions.PRELUDE_TIMEOUT_MS) == null) {
            throw new IllegalStateException("session prelude not acked: " + address);
        }
    }

    private void showPrompt(String address) throws InterruptedException {
        // Create the prompt page (warning text + No/Yes list) on sid=0xe0 Cmd=0.
        // Two attempts: on 2.2.9 the first request sent right after the
        // prelude can be dropped while the lens emits its own sid-0x80
        // notifications (observed with the device-info settings read).
        byte[] pageAck = null;
        for (int attempt = 0; attempt < 2 && pageAck == null && !cancelled; attempt++) {
            int magic = allocMagic();
            byte[] page = BleProtocol.buildCreatePromptPage(
                magic, TEXT_NAME, TEXT_CONTAINER_ID, warningText, LIST_NAME, LIST_CONTAINER_ID, ITEMS);
            emitLog("prompt page attempt " + (attempt + 1) + " writing " + page.length + " bytes to " + address);
            pageAck = writeAndAwaitAck(address, BleProtocol.SID_EVENHUB, BleProtocol.FLAG_REQUEST, magic, page, CREATE_ACK_TIMEOUT_MS);
            if (pageAck == null) {
                emitLog("prompt page attempt " + (attempt + 1) + " unacked: " + address);
            } else {
                // An ack is not a render. The lens can accept the page and show
                // nothing, so the payload it answers with is the only thing that
                // can say why; log it rather than only null-checking it.
                emitLog("prompt page ack payload (" + pageAck.length + " bytes): " + toHex(pageAck));
            }
        }
        if (pageAck == null) {
            throw new IllegalStateException("prompt page not acked: " + address);
        }
        emitLog("prompt page shown on " + address);
    }

    /**
     * Read each arm's battery via a sid-0x09 settings read on that arm's own
     * link (the arms have independent batteries and each answers with its
     * own). An arm that does not answer reports -1; the caller decides what
     * to do with a partial reading.
     */
    private void readBatteries() throws InterruptedException {
        int right = rightConnected ? readBattery(rightAddress, "right") : -1;
        int left = leftConnected ? readBattery(leftAddress, "left") : -1;
        emitLog("battery R=" + (right < 0 ? "?" : right + "%") + " L=" + (left < 0 ? "?" : left + "%"));
        emitBattery(right, left);
    }

    private int readBattery(String address, String arm) throws InterruptedException {
        BleProtocol.BatterySnapshot snapshot = readSettings(address, arm);
        return snapshot == null ? -1 : snapshot.battery;
    }

    /**
     * The sid-0x09 settings read behind both the battery gate and the
     * silent-mode check. One ack carries both fields, so neither caller needs
     * a query of its own. Returns null when the arm does not answer or the ack
     * carries no settings payload.
     */
    private BleProtocol.BatterySnapshot readSettings(String address, String arm)
            throws InterruptedException {
        for (int attempt = 0; attempt < 2 && !cancelled; attempt++) {
            int magic = allocMagic();
            byte[] ack = writeAndAwaitAck(
                address,
                BleProtocol.SID_UI_SETTING,
                BleProtocol.FLAG_REQUEST,
                magic,
                BleProtocol.buildSettingsQuery(magic),
                BATTERY_ACK_TIMEOUT_MS);
            if (ack == null) {
                emitLog("settings read attempt " + (attempt + 1) + " unacked: " + arm + " arm");
                continue;
            }
            BleProtocol.BatterySnapshot snapshot = BleProtocol.parseSettingsBattery(ack);
            if (snapshot != null) {
                return snapshot;
            }
            emitLog("settings read ack had no settings payload: " + arm + " arm");
        }
        return null;
    }

    /**
     * Refuse the prompt only when the arm POSITIVELY reports silent mode. An
     * arm that does not answer, and firmware whose ack omits the field
     * (silentMode -1), both fall through to the prompt, so behavior on older
     * firmware is unchanged and a missing answer never blocks a flash.
     */
    private void requireNotSilent(String address) throws InterruptedException {
        BleProtocol.BatterySnapshot snapshot = readSettings(address, "right");
        String state;
        if (snapshot == null) {
            state = "unknown (arm did not answer)";
        } else if (snapshot.silentMode < 0) {
            state = "unknown (ack omits the field)";
        } else {
            state = snapshot.silentMode > 0 ? "on" : "off";
        }
        emitLog("silent mode before prompt: " + state);
        if (snapshot != null && snapshot.silentMode > 0) {
            throw new IllegalStateException(SILENT_MODE_MESSAGE);
        }
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
            AndroidProtocolPlatform.writeType(ConnectionOptions.WRITE_MODE),
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
        } catch (Exception e) {
            Log.w(TAG, "teardown: ble manager close failed", e);
        }
        rightConnected = false;
        leftConnected = false;
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
        if (address.equalsIgnoreCase(leftAddress)) {
            // The prompt itself only needs the right arm; a dropped left link
            // just means no left battery reading.
            leftConnected = false;
            emitLog("left arm disconnected");
            return;
        }
        if (address.equalsIgnoreCase(rightAddress)) {
            rightConnected = false;
            synchronized (lock) {
                if (!establishing && !finished && !cancelled) {
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

    /** Ack payloads are short; hex is the only honest way to log an opaque reply. */
    private static String toHex(byte[] bytes) {
        StringBuilder out = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) {
            out.append(String.format(java.util.Locale.ROOT, "%02x", b & 255));
        }
        return out.toString();
    }

    private void emitState(String state, String detail) {
        final String safeDetail = detail == null ? "" : detail;
        // Listener-only until now, so a prompt that never appeared left no trace in a log.
        Log.i(TAG, "state=" + state + (safeDetail.isEmpty() ? "" : " -- " + safeDetail));
        mainHandler.post(() -> {
            FaceclawFlashPromptListener current = listener;
            if (current != null) {
                current.onState(state, safeDetail);
            }
        });
    }

    private void emitBattery(int rightPercent, int leftPercent) {
        mainHandler.post(() -> {
            FaceclawFlashPromptListener current = listener;
            if (current != null) {
                current.onBattery(rightPercent, leftPercent);
            }
        });
    }

    private void emitResult(boolean approvedResult) {
        Log.i(TAG, "result=" + (approvedResult ? "approved" : "declined"));
        mainHandler.post(() -> {
            FaceclawFlashPromptListener current = listener;
            if (current != null) {
                current.onResult(approvedResult);
            }
        });
    }
}
