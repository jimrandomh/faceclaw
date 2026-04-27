package com.faceclaw.app;

import android.annotation.SuppressLint;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCharacteristic;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;

@SuppressLint("MissingPermission")
public class FaceclawBleCommunicator implements FaceclawBleListener, Runnable {
    private static final String TAG = "FaceclawComm";

    private static final int WRITE_TYPE = BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE;
    private static final int IMAGE_WRITE_TYPE = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT;
    private static final int DESIRED_MTU = 247;
    private static final int CONNECTION_PRIORITY_HIGH = BluetoothGatt.CONNECTION_PRIORITY_HIGH;

    private static final int CONNECT_TIMEOUT_MS = 5_000;
    private static final int SERVICES_TIMEOUT_MS = 5_000;
    private static final int DESCRIPTOR_TIMEOUT_MS = 5_000;
    private static final int WRITE_TIMEOUT_MS = 2_000;
    private static final int PRELUDE_TIMEOUT_MS = 2_000;
    private static final int ACK_TIMEOUT_MS = 3_500;
    private static final int HEARTBEAT_INTERVAL_MS = 5_000;
    private static final int BATTERY_REFRESH_INTERVAL_MS = 5 * 60_000;
    private static final int BATTERY_INPUT_QUIET_MS = 5_000;
    private static final int WINDOW_SIZE = 3;
    private static final int IMAGE_FRAGMENT_SIZE = 1000;
    private static final int IMAGE_RETRY_DELAY_MS = 10_000;
    private static final boolean IMAGE_FRAGMENT_NO_ACK = false;
    private static final int WARMUP_FRAGMENT_TIMEOUT_MS = 3_000;
    private static final int MAX_CONSECUTIVE_ACK_TIMEOUTS = 8;
    private static final int EVEN_APP_WRITE_FAILURE_WINDOW_MS = 15_000;
    private static final int IDLE_SLEEP_MS = 100;
    private static final int RECONNECT_DELAY_MS = 5_000;

    private static final BleProtocol.ImageTileOptions[] DASHBOARD_TILES = new BleProtocol.ImageTileOptions[] {
        new BleProtocol.ImageTileOptions("img00", 10, 0, 0, 288, 144),
        new BleProtocol.ImageTileOptions("img10", 11, 288, 0, 288, 144),
        new BleProtocol.ImageTileOptions("img01", 12, 0, 144, 288, 144),
        new BleProtocol.ImageTileOptions("img11", 13, 288, 144, 288, 144)
    };

    private final Context appContext;
    private final FaceclawBleManager bleManager;
    private final InterruptibleSleep interruptibleSleep = new InterruptibleSleep();
    private final Object lock = new Object();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final String rightAddress;
    private final String leftAddress;
    private final String ringAddress;

    private volatile FaceclawBleCommunicatorListener listener;
    private volatile Thread workerThread;
    private volatile boolean running;
    private volatile boolean userDisconnectRequested;

    private String phase = "disconnected";
    private String status = "Disconnected.";

    private boolean rightConnected;
    private boolean leftConnected;
    private boolean sessionReady;
    private boolean fixedLayoutCreated;
    private boolean warmedUp;
    private boolean shutdownRequested;
    private boolean startupProbePending;

    private long reconnectAfterMs;
    private long lastAckAtMs;
    private long lastIncomingAtMs;
    private long lastHeartbeatQueuedAtMs;
    private long lastConnectionOrInputAtMs;
    private long lastBatteryRefreshAtMs;
    private long imageRetryAfterMs;
    private long lastSessionReadyAtMs;
    private long lastEvenAppConflictAtMs;
    private int consecutiveAckTimeouts;

    private final BleMagicPool magicPool = new BleMagicPool();
    private int nextTransportSeq = 0x40;
    private int nextMapSessionId = 0;
    private int nextImageUpdateId = 1;
    private int lastShutdownAckMagic = 0;
    private long lastShutdownExitAtMs = 0;
    private int headsetBattery = -1;
    private int headsetCharging = -1;

    private String displayedFingerprint = "";
    private byte[][] displayedTileBmps = emptyTileSet();
    private final Map<Integer, ImageUpdateStats> imageUpdateStats = new HashMap<>();

    private final Object desiredTilesLock = new Object();
    private String desiredFingerprint = "";
    private byte[][] desiredTileBmps = emptyTileSet();
    private boolean desiredForceTiledCommit;
    private int desiredPaintMs;

    private final ArrayDeque<OutboundMessage> pendingMessages = new ArrayDeque<>();
    private final ArrayDeque<OutboundMessage> inFlightMessages = new ArrayDeque<>();

    public FaceclawBleCommunicator(Context context, String rightAddress, String leftAddress, String ringAddress) {
        this.appContext = context.getApplicationContext();
        this.bleManager = new FaceclawBleManager(appContext);
        this.bleManager.setListener(this);
        this.rightAddress = requireAddress("rightAddress", rightAddress);
        this.leftAddress = requireAddress("leftAddress", leftAddress);
        this.ringAddress = ringAddress == null ? "" : ringAddress.trim();
    }


    public void setListener(FaceclawBleCommunicatorListener listener) {
        this.listener = listener;
        emitState();
    }

    public void start() {
        synchronized (lock) {
            if (running) {
                return;
            }
            running = true;
            userDisconnectRequested = false;
            shutdownRequested = false;
            workerThread = new Thread(this, "FaceclawBleCommunicator");
            workerThread.start();
        }
    }

    public void disconnect() {
        Thread threadToJoin;
        synchronized (lock) {
            userDisconnectRequested = true;
            running = false;
            phase = "disconnecting";
            status = "Disconnecting...";
            lock.notifyAll();
            threadToJoin = workerThread;
        }
        interruptibleSleep.interrupt();
        emitState();
        if (threadToJoin != null) {
            threadToJoin.interrupt();
            try {
                threadToJoin.join(5_000);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
        synchronized (lock) {
            workerThread = null;
            phase = "disconnected";
            status = "Disconnected.";
            resetSessionStateLocked();
            clearAllMessagesLocked("disconnect");
        }
        bleManager.disconnect(rightAddress);
        bleManager.disconnect(leftAddress);
        bleManager.close();
        emitState();
    }

    public void close() {
        disconnect();
    }


    public void submitDashboardImage(List<byte[]> tileBmps, String fingerprint) {
        submitDashboardImage(tileBmps, fingerprint, false, -1);
    }

    public void submitDashboardImage(List<byte[]> tileBmps, String fingerprint, boolean forceTiledCommit) {
        submitDashboardImage(tileBmps, fingerprint, forceTiledCommit, -1);
    }

    public void submitDashboardImage(List<byte[]> tileBmps, String fingerprint, boolean forceTiledCommit, int paintMs) {
        if (tileBmps == null || tileBmps.size() != DASHBOARD_TILES.length) {
            throw new IllegalArgumentException("exactly 4 tile bitmaps are required");
        }
        synchronized (desiredTilesLock) {
            desiredTileBmps = emptyTileSet();
            for (int i = 0; i < DASHBOARD_TILES.length; i++) {
                byte[] bmp = tileBmps.get(i);
                desiredTileBmps[i] = bmp == null ? new byte[0] : Arrays.copyOf(bmp, bmp.length);
            }
            desiredFingerprint = fingerprint == null ? "" : fingerprint;
            desiredForceTiledCommit = forceTiledCommit;
            desiredPaintMs = paintMs;
        }
        interruptibleSleep.interrupt();
    }

    public void submitDashboardImage4(
            byte[] tile0Bmp,
            byte[] tile1Bmp,
            byte[] tile2Bmp,
            byte[] tile3Bmp,
            String fingerprint
    ) {
        submitDashboardImage4(tile0Bmp, tile1Bmp, tile2Bmp, tile3Bmp, fingerprint, false, -1);
    }

    public void submitDashboardImage4(
            byte[] tile0Bmp,
            byte[] tile1Bmp,
            byte[] tile2Bmp,
            byte[] tile3Bmp,
            String fingerprint,
            boolean forceTiledCommit
    ) {
        submitDashboardImage4(tile0Bmp, tile1Bmp, tile2Bmp, tile3Bmp, fingerprint, forceTiledCommit, -1);
    }

    public void submitDashboardImage4(
            byte[] tile0Bmp,
            byte[] tile1Bmp,
            byte[] tile2Bmp,
            byte[] tile3Bmp,
            String fingerprint,
            boolean forceTiledCommit,
            int paintMs
    ) {
        synchronized (desiredTilesLock) {
            desiredTileBmps = emptyTileSet();
            desiredTileBmps[0] = tile0Bmp == null ? new byte[0] : Arrays.copyOf(tile0Bmp, tile0Bmp.length);
            desiredTileBmps[1] = tile1Bmp == null ? new byte[0] : Arrays.copyOf(tile1Bmp, tile1Bmp.length);
            desiredTileBmps[2] = tile2Bmp == null ? new byte[0] : Arrays.copyOf(tile2Bmp, tile2Bmp.length);
            desiredTileBmps[3] = tile3Bmp == null ? new byte[0] : Arrays.copyOf(tile3Bmp, tile3Bmp.length);
            desiredFingerprint = fingerprint == null ? "" : fingerprint;
            desiredForceTiledCommit = forceTiledCommit;
            desiredPaintMs = paintMs;
        }
        interruptibleSleep.interrupt();
    }

    public boolean sendShutdown(int exitMode) {
        int magic;
        long startedAtMs = SystemClock.elapsedRealtime();
        synchronized (lock) {
            if (!running || !sessionReady) {
                logLine("skip shutdown; session not ready");
                return false;
            }
            shutdownRequested = true;
            clearPendingMessagesLocked("shutdown requested");
            magic = nextMagic();
            pendingMessages.addFirst(new OutboundMessage(
                "shutdown",
                "shutdown mode=" + exitMode,
                BleProtocol.SID_EVENHUB,
                magic,
                BleProtocol.framePb(
                    BleProtocol.buildShutdown(magic, exitMode),
                    BleProtocol.SID_EVENHUB,
                    BleProtocol.FLAG_REQUEST,
                    nextTransportSeq++
                ),
                ACK_TIMEOUT_MS,
                displayedFingerprint,
                -1,
                null
            ));
            logLine("queue shutdown");
            lock.notifyAll();
        }
        interruptibleSleep.interrupt();

        long ackDeadline = SystemClock.elapsedRealtime() + ACK_TIMEOUT_MS + 500;
        synchronized (lock) {
            while (running
                    && sessionReady
                    && lastShutdownAckMagic != magic
                    && lastShutdownExitAtMs < startedAtMs
                    && hasPendingOrInflightMagicLocked(magic)) {
                long remaining = ackDeadline - SystemClock.elapsedRealtime();
                if (remaining <= 0) {
                    break;
                }
                try {
                    lock.wait(Math.min(remaining, 100));
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    break;
                }
            }
            boolean acked = lastShutdownAckMagic == magic;
            if (acked) {
                long exitDeadline = SystemClock.elapsedRealtime() + ACK_TIMEOUT_MS + 500;
                while (running && sessionReady && lastShutdownExitAtMs < startedAtMs) {
                    long remaining = exitDeadline - SystemClock.elapsedRealtime();
                    if (remaining <= 0) {
                        break;
                    }
                    try {
                        lock.wait(Math.min(remaining, 100));
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                        break;
                    }
                }
            }
            return acked || lastShutdownExitAtMs >= startedAtMs;
        }
    }


    @Override
    public void run() {
        logLine(String.format(Locale.US, "communicator start R=%s L=%s ring=%s", rightAddress, leftAddress, ringAddress));
        while (true) {
            try {
                if (!running) {
                    Log.w(TAG, "Exiting event looop");
                    break;
                }
                if (!sessionReady) {
                    long now = SystemClock.elapsedRealtime();
                    if (now < reconnectAfterMs) {
                        interruptibleSleep.sleep(Math.min(IDLE_SLEEP_MS, reconnectAfterMs - now));
                        continue;
                    }
                    Log.w(TAG, "Attempting to connect");
                    connectLoopOnce();
                    continue;
                }

                long sleepMs = driveSession();
                Log.i(TAG, "driveSession returned " + sleepMs + "ms");
                if (sleepMs > 0) {
                    interruptibleSleep.sleep(sleepMs);
                }
            } catch (Throwable t) {
                logLine("communicator loop error: " + safeMessage(t));
                handleTransportFailure("loop error");
            }
        }
        logLine("communicator stop");
    }

    @Override
    public void onNotification(String address, String characteristicUuid, byte[] data) {
        if (address == null || characteristicUuid == null || data == null) {
            return;
        }
        String uuid = characteristicUuid.toLowerCase(Locale.US);
        if (!BleProtocol.NOTIFY_CHAR_UUID.equals(uuid)) {
            return;
        }
        Log.i(TAG, "onNotification: address=" + address + " characteristicUuid=" + characteristicUuid + " data.length=" + data.length);
        BleProtocol.ParsedFrame frame = BleProtocol.parseFrame(data);
        AsyncEvent event = null;
        synchronized (lock) {
            lastIncomingAtMs = SystemClock.elapsedRealtime();
            if (frame.ok && frame.msgSeq >= 0 && frame.flag != BleProtocol.FLAG_NOTIFY && frame.flag != BleProtocol.FLAG_NOTIFY_ALT) {
                lastAckAtMs = lastIncomingAtMs;
                resolveAckLocked(frame.sid, frame.msgSeq, frame.pb);
            }
            if (frame.ok && address.equalsIgnoreCase(rightAddress) && (frame.flag == BleProtocol.FLAG_NOTIFY || frame.flag == BleProtocol.FLAG_NOTIFY_ALT)) {
                event = decodeAsyncEventLocked(frame);
                if (event != null) {
                    lastConnectionOrInputAtMs = lastIncomingAtMs;
                }
            }
            lock.notifyAll();
        }
        interruptibleSleep.interrupt();
        if (event != null) {
            emitRingEvent(event.kind, event.containerName, event.eventType, event.eventSource, event.systemExitReasonCode);
        }
    }

    @Override
    public void onConnectionStateChange(String address, boolean connected) {
        synchronized (lock) {
            if (address == null) {
                return;
            }
            if (address.equalsIgnoreCase(rightAddress)) {
                rightConnected = connected;
            } else if (address.equalsIgnoreCase(leftAddress)) {
                leftConnected = connected;
            }
            if (!connected) {
                sessionReady = false;
                fixedLayoutCreated = false;
                warmedUp = false;
                startupProbePending = false;
                clearAllMessagesLocked("connection lost");
                displayedFingerprint = "";
                displayedTileBmps = emptyTileSet();
                reconnectAfterMs = SystemClock.elapsedRealtime() + RECONNECT_DELAY_MS;
                phase = userDisconnectRequested ? "disconnecting" : "connecting";
                status = userDisconnectRequested
                        ? "Disconnecting..."
                        : "Connection lost. Reconnecting...";
            }
            lock.notifyAll();
        }
        interruptibleSleep.interrupt();
        emitState();
    }

    private void connectLoopOnce() throws InterruptedException { //{{{
        setState("connecting", "Connecting to the glasses...");
        try {
            connectArm(rightAddress, true);
            connectArm(leftAddress, false);
            if (!interruptibleSleep.sleep(800)) {
                return;
            }
            sendPrelude();

            synchronized (lock) {
                sessionReady = true;
                fixedLayoutCreated = false;
                warmedUp = false;
                clearAllMessagesLocked("session ready");
                displayedFingerprint = "";
                displayedTileBmps = emptyTileSet();
                lastAckAtMs = SystemClock.elapsedRealtime();
                lastIncomingAtMs = lastAckAtMs;
                lastConnectionOrInputAtMs = lastAckAtMs;
                lastSessionReadyAtMs = lastAckAtMs;
                lastBatteryRefreshAtMs = 0;
                imageRetryAfterMs = 0;
                lastHeartbeatQueuedAtMs = 0;
                consecutiveAckTimeouts = 0;
            }
            setState("connected", "Connected.");
            logLine("session ready");
        } catch (Throwable t) {
            logLine("connect failed: " + safeMessage(t));
            handleTransportFailure("connect failed");
        }
    } //}}}

    private void connectArm(String address, boolean enableRenderNotify) {
        if (!bleManager.connect(address, CONNECT_TIMEOUT_MS)) {
            throw new IllegalStateException("connect failed: " + address);
        }
        bleManager.requestConnectionPriority(address, CONNECTION_PRIORITY_HIGH);
        bleManager.requestMtu(address, DESIRED_MTU, CONNECT_TIMEOUT_MS);
        if (!bleManager.discoverServices(address, SERVICES_TIMEOUT_MS)) {
            throw new IllegalStateException("discoverServices failed: " + address);
        }
        if (!bleManager.enableNotifications(address, BleProtocol.NOTIFY_CHAR_UUID, true, DESCRIPTOR_TIMEOUT_MS)) {
            throw new IllegalStateException("enableNotifications failed: " + address + " " + BleProtocol.NOTIFY_CHAR_UUID);
        }
        if (enableRenderNotify) {
            bleManager.enableNotifications(address, BleProtocol.RENDER_NOTIFY_UUID, true, DESCRIPTOR_TIMEOUT_MS);
        }
        synchronized (lock) {
            if (address.equalsIgnoreCase(rightAddress)) {
                rightConnected = true;
            } else if (address.equalsIgnoreCase(leftAddress)) {
                leftConnected = true;
            }
        }
    }

    private void sendPrelude() throws InterruptedException { //{{{
        synchronized (lock) {
            clearAllMessagesLocked("prelude");
            long now = SystemClock.elapsedRealtime();
            OutboundMessage prelude = new OutboundMessage(
                "prelude",
                BleProtocol.PRELUDE_ACK_SID,
                BleProtocol.PRELUDE_ACK_MAGIC,
                CollectionUtils.singletonList(Arrays.copyOf(BleProtocol.PRELUDE_F5872, BleProtocol.PRELUDE_F5872.length)),
                WRITE_TIMEOUT_MS,
                0,
                now + PRELUDE_TIMEOUT_MS
            );
            prelude.sentAtMs = now;
            inFlightMessages.add(prelude);
        }
        if (!bleManager.writeFrames(
            rightAddress,
            BleProtocol.WRITE_CHAR_UUID,
            CollectionUtils.singletonList(Arrays.copyOf(BleProtocol.PRELUDE_F5872, BleProtocol.PRELUDE_F5872.length)),
            WRITE_TYPE,
            WRITE_TIMEOUT_MS
        )) {
            throw new IllegalStateException("prelude queue failed");
        }

        long deadline = SystemClock.elapsedRealtime() + PRELUDE_TIMEOUT_MS;
        synchronized (lock) {
            while (running && !userDisconnectRequested && !inFlightMessages.isEmpty()) {
                long remaining = deadline - SystemClock.elapsedRealtime();
                if (remaining <= 0) {
                    break;
                }
                lock.wait(Math.min(remaining, 100));
            }
            if (!inFlightMessages.isEmpty()) {
                clearInFlightMessagesLocked("prelude timeout");
                throw new IllegalStateException("prelude ack timeout");
            }
        }
    } //}}}

    private long driveSession() {
        Log.i(TAG, "driveSession called (pendingMessages.size=" + pendingMessages.size() + " inFlightMessages.size=" + inFlightMessages.size() + ")");
        synchronized (lock) {
            Log.i(TAG, "driveSession took lock");
            long now = SystemClock.elapsedRealtime();

            if (!inFlightMessages.isEmpty()) {
                OutboundMessage oldest = inFlightMessages.peekFirst();
                if (oldest != null && oldest.ackDeadlineAtMs <= now) {
                    Log.i(TAG, "message timed out: " + oldest.label);
                    inFlightMessages.removeFirst();
                    logLine("message timed out: " + oldest.label);
                    releaseMagicLocked(oldest, "timeout");
                    handleAckTimeoutLocked(oldest);
                    return 0;
                }
            }

            if (!shutdownRequested && !fixedLayoutCreated && pendingMessages.isEmpty() && inFlightMessages.isEmpty()) {
                Log.i(TAG, "enqueueing create layout");
                enqueueStartupProbeLocked();
            }
            if (!shutdownRequested && fixedLayoutCreated && !warmedUp && pendingMessages.isEmpty() && inFlightMessages.isEmpty()) {
                Log.i(TAG, "enqueueing warmup");
                enqueueWarmupLocked();
            }

            // We always write a heartbeat if it's due, even if this goes in between image fragments
            if (!shutdownRequested && !hasPendingOrInflightKindLocked("heartbeat") && now - lastHeartbeatQueuedAtMs >= HEARTBEAT_INTERVAL_MS && warmedUp && fixedLayoutCreated) {
                Log.i(TAG, "Writing heartbeat");
                writeHeartbeatLocked();
                return 0;
            }
            
            while (sessionReady && inFlightMessages.size() < WINDOW_SIZE && !pendingMessages.isEmpty()) {
                OutboundMessage message = pendingMessages.removeFirst();
                Log.i(TAG, "sending pending message: " + message.label);
                if (!writeMessageLocked(message)) {
                    pendingMessages.addFirst(message);
                    handleTransportFailureLocked("write failed");
                    return 0;
                }
            }
            if (!shutdownRequested && fixedLayoutCreated && warmedUp && pendingMessages.isEmpty() && inFlightMessages.isEmpty()
                    && now >= imageRetryAfterMs
                    && !getDesiredFingerprint().equals(displayedFingerprint)) {
                Log.i(TAG, "Enqueued image update");
                enqueueDesiredImageLocked();
                return 0;
            }

            if (shouldPollBatteryLocked(now)) {
                Log.i(TAG, "Writing battery query");
                writeBatteryQueryLocked(now);
                return 0;
            }

            if (!pendingMessages.isEmpty() || !inFlightMessages.isEmpty()) {
                return IDLE_SLEEP_MS;
            }
            return 250;
        }
    }

    private boolean writeMessageLocked(OutboundMessage message) {
        long writeStartedAtMs = SystemClock.elapsedRealtime();
        if (!bleManager.writeFrames(
            rightAddress,
            BleProtocol.WRITE_CHAR_UUID,
            message.frames,
            WRITE_TYPE,
            WRITE_TIMEOUT_MS
        )) {
            return false;
        }
        message.writeStartedAtMs = writeStartedAtMs;
        message.sentAtMs = SystemClock.elapsedRealtime();
        message.ackDeadlineAtMs = message.sentAtMs + message.ackTimeoutMs;
        if (message.magic != 0) {
            inFlightMessages.addLast(message);
        }
        logImageUpdateSendLandmarkLocked(message);
        return true;
    }

    private void resolveAckLocked(int sid, int magic, byte[] pb) {
        Log.i(TAG, "Received ack for sid=" + sid + " magic=" + magic);
        Iterator<OutboundMessage> iterator = inFlightMessages.iterator();
        while (iterator.hasNext()) {
            OutboundMessage message = iterator.next();
            if (message.sid == sid && message.magic == magic) {
                iterator.remove();
                message.ackPayload = pb == null ? new byte[0] : Arrays.copyOf(pb, pb.length);
                releaseMagicLocked(message, "ack");
                onMessageAckLocked(message);
                return;
            }
        }
        recordUnexpectedAckLocked(sid, magic);
    }

    private void onMessageAckLocked(OutboundMessage message) {
        consecutiveAckTimeouts = 0;
        if ("create-layout".equals(message.kind)) {
            startupProbePending = false;
            clearMessagesOfKindLocked("startup-text-probe");
            fixedLayoutCreated = true;
            displayedFingerprint = "";
            displayedTileBmps = emptyTileSet();
            return;
        }
        if ("startup-text-probe".equals(message.kind)) {
            startupProbePending = false;
            clearMessagesOfKindLocked("create-layout");
            fixedLayoutCreated = true;
            warmedUp = true;
            displayedFingerprint = "";
            displayedTileBmps = emptyTileSet();
            logLine("existing dashboard layout accepted text probe");
            return;
        }
        if ("warmup".equals(message.kind)) {
            // The first tile warmup primes the image path but does not reliably
            // guarantee that the tile is now visible on-screen, so it must not
            // update the displayed-tile cache used by image dedupe.
            warmedUp = true;
            return;
        }
        if ("image".equals(message.kind)) {
            imageRetryAfterMs = 0;
            logImageUpdateAckLandmarkLocked(message);
            if (message.tileIndex >= 0 && !hasPendingOrInflightTileLocked(message.tileIndex)) {
                displayedTileBmps[message.tileIndex] = copyTileBmp(message.tileBmp);
            }
            boolean imageStillInFlight = false;
            for (OutboundMessage inFlight : inFlightMessages) {
                if ("image".equals(inFlight.kind)) {
                    imageStillInFlight = true;
                    break;
                }
            }
            if (!imageStillInFlight) {
                boolean imageStillQueued = false;
                for (OutboundMessage queued : pendingMessages) {
                    if ("image".equals(queued.kind)) {
                        imageStillQueued = true;
                        break;
                    }
                }
                if (!imageStillQueued) {
                    displayedFingerprint = message.fingerprint;
                }
            }
            return;
        }
        if ("heartbeat".equals(message.kind)) {
            return;
        }
        if ("battery".equals(message.kind)) {
            BleProtocol.BatterySnapshot snapshot = BleProtocol.parseSettingsBattery(message.ackPayload);
            if (snapshot != null) {
                headsetBattery = snapshot.battery;
                headsetCharging = snapshot.charging;
                emitBatteryState(headsetBattery, headsetCharging);
            }
            return;
        }
        if ("shutdown".equals(message.kind)) {
            lastShutdownAckMagic = message.magic;
            fixedLayoutCreated = false;
            warmedUp = false;
            displayedFingerprint = "";
            displayedTileBmps = emptyTileSet();
            return;
        }
    }

    private void logImageUpdateSendLandmarkLocked(OutboundMessage message) {
        if (message.imageUpdateId <= 0) {
            return;
        }
        if (message.imageMessageNumber == 1) {
            ImageUpdateStats stats = imageUpdateStats.get(message.imageUpdateId);
            if (stats != null && stats.firstWriteStartedAtMs <= 0) {
                stats.firstWriteStartedAtMs = message.writeStartedAtMs > 0 ? message.writeStartedAtMs : message.sentAtMs;
            }
            logImageUpdateLandmarkLocked("first bluetooth message sent", message, message.sentAtMs);
        }
        if (message.imageMessageNumber == message.imageMessageCount) {
            logImageUpdateLandmarkLocked("last bluetooth message sent", message, message.sentAtMs);
        }
    }

    private void logImageUpdateAckLandmarkLocked(OutboundMessage message) {
        if (message.imageUpdateId <= 0 || message.imageMessageNumber != message.imageMessageCount) {
            return;
        }
        long ackedAtMs = SystemClock.elapsedRealtime();
        ImageUpdateStats stats = imageUpdateStats.remove(message.imageUpdateId);
        if (stats != null && stats.firstWriteStartedAtMs > 0) {
            emitFrameMetrics(stats.paintMs, (int) Math.max(0, ackedAtMs - stats.firstWriteStartedAtMs), stats.tileCount);
        }
        logImageUpdateLandmarkLocked("last bluetooth message acked", message, ackedAtMs);
    }

    private void logImageUpdateLandmarkLocked(String event, OutboundMessage message, long elapsedMs) {
        logLine("image update#" + message.imageUpdateId + " " + event
                + " at " + timestamp(elapsedMs)
                + " message=" + message.imageMessageNumber + "/" + message.imageMessageCount
                + " label=" + message.label);
    }

    private void enqueueCreateLayoutLocked() {
        int magic = nextMagic();
        pendingMessages.addLast(new OutboundMessage(
            "create-layout",
            "create-layout",
            BleProtocol.SID_EVENHUB,
            magic,
            BleProtocol.framePb(
                BleProtocol.buildCreateMixedImagePage(magic, DASHBOARD_TILES),
                BleProtocol.SID_EVENHUB,
                BleProtocol.FLAG_REQUEST,
                nextTransportSeq++
            ),
            ACK_TIMEOUT_MS,
            getDesiredFingerprint(),
            -1,
            null
        ));
        logLine("queue create layout");
    }

    private void enqueueStartupProbeLocked() {
        enqueueCreateLayoutLocked();

        int magic = nextMagic();
        pendingMessages.addLast(new OutboundMessage(
            "startup-text-probe",
            "startup text probe",
            BleProtocol.SID_EVENHUB,
            magic,
            BleProtocol.framePb(
                BleProtocol.buildDashboardTextUpgrade(magic),
                BleProtocol.SID_EVENHUB,
                BleProtocol.FLAG_REQUEST,
                nextTransportSeq++
            ),
            ACK_TIMEOUT_MS,
            getDesiredFingerprint(),
            -1,
            null
        ));
        startupProbePending = true;
        logLine("queue startup text probe");
    }

    private void enqueueWarmupLocked() {
        byte[] bmp;
        synchronized (desiredTilesLock) {
            bmp = desiredTileBmps[0];
        }
        if (bmp == null || bmp.length == 0) {
            bmp = new byte[] {0};
	    }
	    BleProtocol.ImageTileOptions tile = DASHBOARD_TILES[0];
        int sessionId = nextMapSessionId();
        List<BleProtocol.ImageFragment> fragments = BleImageOptimizer.planImageFragments(bmp, IMAGE_FRAGMENT_SIZE);
        for (BleProtocol.ImageFragment fragment : fragments) {
            int magic = nextMagic();
            pendingMessages.addLast(new OutboundMessage(
                "warmup",
                "warmup " + tile.name + "#" + fragment.index,
                BleProtocol.SID_EVENHUB,
                magic,
                BleProtocol.framePb(
                    BleProtocol.buildImageRawData(tile, sessionId, bmp.length, fragment, magic),
                    BleProtocol.SID_EVENHUB, BleProtocol.FLAG_REQUEST,
                    nextTransportSeq++
                ),
                WARMUP_FRAGMENT_TIMEOUT_MS,
                getDesiredFingerprint(),
                0,
                bmp
            ));
        }
        logLine("queue warmup");
    }

    private void enqueueDesiredImageLocked() {
        String fingerprint = getDesiredFingerprint();
        List<TileImagePlan> changedTiles = new ArrayList<>();
        byte[][] tileBmps;
        boolean forceTiledCommit;
        int paintMs;
        synchronized (desiredTilesLock) {
            tileBmps = desiredTileBmps;
            forceTiledCommit = desiredForceTiledCommit;
            desiredForceTiledCommit = false;
            paintMs = desiredPaintMs;
        }
        for (int i = 0; i < DASHBOARD_TILES.length; i++) {
            BleProtocol.ImageTileOptions tile = DASHBOARD_TILES[i];
            byte[] bmp = tileBmps[i];
            if (bmp == null) {
                bmp = new byte[0];
            }
            byte[] displayedBmp = displayedTileBmps[i];
            if (Arrays.equals(bmp, displayedBmp)) {
                continue;
            }
            changedTiles.add(new TileImagePlan(i, tile, bmp, nextMapSessionId()));
        }
        if (changedTiles.isEmpty()) {
            displayedFingerprint = fingerprint;
            return;
        }

        boolean synchronizedCommits = changedTiles.size() > 1;
        if (forceTiledCommit) {
            synchronizedCommits = false;
        }
        boolean reserveLastByte = false;
        for (TileImagePlan plan : changedTiles) {
            plan.fragments = BleImageOptimizer.planImageFragments(plan.bmp, IMAGE_FRAGMENT_SIZE, reserveLastByte);
        }

        int updateId = nextImageUpdateId++;
        imageUpdateStats.put(updateId, new ImageUpdateStats(paintMs, changedTiles.size()));
        int messageCount = 0;
        for (TileImagePlan plan : changedTiles) {
            messageCount += plan.fragments.size();
        }
        int messageNumber = 1;
        if (!synchronizedCommits) {
            for (TileImagePlan plan : changedTiles) {
                for (BleProtocol.ImageFragment fragment : plan.fragments) {
                    enqueueImageFragmentLocked(plan, fragment, fingerprint, updateId, messageNumber++, messageCount, nextTransportSeq++, true, true);
                }
            }
        } else {
            for (TileImagePlan plan : changedTiles) {
                for (int i = 0; i < plan.fragments.size() - 1; i++) {
                    enqueueImageFragmentLocked(plan, plan.fragments.get(i), fingerprint, updateId, messageNumber++, messageCount, nextTransportSeq++, true, false);
                }
            }
            for (TileImagePlan plan : changedTiles) {
                enqueueImageFragmentLocked(plan, plan.fragments.get(plan.fragments.size() - 1), fingerprint, updateId, messageNumber++, messageCount, nextTransportSeq++, true, true);
            }
        }

        logLine("queue image update#" + updateId + " fingerprint=" + fingerprint
                + " changedTiles=" + changedTiles.size() + " messages=" + messageCount
                + " synchronizedCommits=" + synchronizedCommits);
    }

    private void enqueueImageFragmentLocked(
        TileImagePlan plan,
        BleProtocol.ImageFragment fragment,
        String fingerprint,
        int updateId,
        int messageNumber,
        int messageCount,
        int transportSeq,
        boolean requestAck,
        boolean isLast
    ) {
        int magic = IMAGE_FRAGMENT_NO_ACK ? 0 : nextMagic();
        OutboundMessage message = new OutboundMessage(
            "image",
            "image " + plan.tile.name + "#" + fragment.index,
            BleProtocol.SID_EVENHUB,
            magic,
            BleProtocol.framePb(
                BleProtocol.buildImageRawData(plan.tile, plan.sessionId, plan.bmp.length, fragment, magic),
                BleProtocol.SID_EVENHUB,
                BleProtocol.FLAG_REQUEST, //isLast ? 0 : BleProtocol.FLAG_REQUEST,
                transportSeq
            ),
            ACK_TIMEOUT_MS,
            fingerprint,
            plan.tileIndex,
            plan.bmp
        );
        message.setImageUpdatePosition(updateId, messageNumber, messageCount);
        pendingMessages.addLast(message);
    }

    private void writeHeartbeatLocked() {
        int magic = nextMagic();
        OutboundMessage heartbeatMessage = new OutboundMessage(
            "heartbeat",
            "heartbeat",
            BleProtocol.SID_EVENHUB,
            magic,
            BleProtocol.framePb(BleProtocol.buildHeartbeat(magic), BleProtocol.SID_EVENHUB, BleProtocol.FLAG_REQUEST, nextTransportSeq++),
            ACK_TIMEOUT_MS,
            displayedFingerprint,
            -1,
            null
        );
        writeMessageLocked(heartbeatMessage);
        lastHeartbeatQueuedAtMs = SystemClock.elapsedRealtime();
    }

    private boolean shouldPollBatteryLocked(long now) {
        return !shutdownRequested
                && sessionReady
                && pendingMessages.isEmpty()
                && inFlightMessages.isEmpty()
                && now - lastConnectionOrInputAtMs >= BATTERY_INPUT_QUIET_MS
                && (lastBatteryRefreshAtMs == 0 || now - lastBatteryRefreshAtMs >= BATTERY_REFRESH_INTERVAL_MS);
    }

    private void writeBatteryQueryLocked(long now) {
        int magic = nextMagic();
        OutboundMessage batteryMessage = new OutboundMessage(
            "battery",
            "battery",
            BleProtocol.SID_UI_SETTING,
            magic,
            BleProtocol.framePb(
                BleProtocol.buildSettingsQuery(magic),
                BleProtocol.SID_UI_SETTING,
                BleProtocol.FLAG_REQUEST,
                nextTransportSeq++
            ),
            ACK_TIMEOUT_MS,
            displayedFingerprint,
            -1,
            null
        );
        if (writeMessageLocked(batteryMessage)) {
            lastBatteryRefreshAtMs = now;
        }
    }

    private boolean hasPendingOrInflightKindLocked(String kind) {
        for (OutboundMessage queued : pendingMessages) {
            if (kind.equals(queued.kind)) {
                return true;
            }
        }
        for (OutboundMessage inFlight : inFlightMessages) {
            if (kind.equals(inFlight.kind)) {
                return true;
            }
        }
        return false;
    }

    private boolean hasPendingOrInflightMagicLocked(int magic) {
        for (OutboundMessage queued : pendingMessages) {
            if (queued.magic == magic) {
                return true;
            }
        }
        for (OutboundMessage inFlight : inFlightMessages) {
            if (inFlight.magic == magic) {
                return true;
            }
        }
        return false;
    }

    private boolean hasPendingMagicLocked(int sid, int magic) {
        for (OutboundMessage queued : pendingMessages) {
            if (queued.sid == sid && queued.magic == magic) {
                return true;
            }
        }
        return false;
    }

    private void handleAckTimeoutLocked(OutboundMessage message) {
        consecutiveAckTimeouts += 1;
        if ("create-layout".equals(message.kind) && startupProbePending) {
            logLine("create layout timed out while startup text probe is pending");
            if (hasPendingOrInflightKindLocked("startup-text-probe")) {
                return;
            }
            startupProbePending = false;
        }
        if ("create-layout".equals(message.kind) || "prelude".equals(message.kind)) {
            handleTransportFailureLocked("ack timeout");
            return;
        }

        if ("startup-text-probe".equals(message.kind)) {
            startupProbePending = false;
            if (hasPendingOrInflightKindLocked("create-layout")) {
                return;
            }
            handleTransportFailureLocked("ack timeout");
            return;
        }

        if ("warmup".equals(message.kind)) {
            warmedUp = false;
            clearMessagesOfKindLocked("warmup");
            displayedFingerprint = "";
            displayedTileBmps = emptyTileSet();
        } else if ("image".equals(message.kind)) {
            imageUpdateStats.remove(message.imageUpdateId);
            clearMessagesOfKindLocked("image");
            displayedFingerprint = "";
            displayedTileBmps = emptyTileSet();
            imageRetryAfterMs = SystemClock.elapsedRealtime() + IMAGE_RETRY_DELAY_MS;
        }

        if (consecutiveAckTimeouts > MAX_CONSECUTIVE_ACK_TIMEOUTS) {
            handleTransportFailureLocked("too many ack timeouts");
        }
    }

    private void clearMessagesOfKindLocked(String kind) {
        Iterator<OutboundMessage> pendingIterator = pendingMessages.iterator();
        while (pendingIterator.hasNext()) {
            OutboundMessage message = pendingIterator.next();
            if (kind.equals(message.kind)) {
                pendingIterator.remove();
                if ("image".equals(kind)) {
                    imageUpdateStats.remove(message.imageUpdateId);
                }
                releaseMagicLocked(message, "cleared pending " + kind);
            }
        }
        Iterator<OutboundMessage> inFlightIterator = inFlightMessages.iterator();
        while (inFlightIterator.hasNext()) {
            OutboundMessage message = inFlightIterator.next();
            if (kind.equals(message.kind)) {
                inFlightIterator.remove();
                if ("image".equals(kind)) {
                    imageUpdateStats.remove(message.imageUpdateId);
                }
                releaseMagicLocked(message, "cleared inflight " + kind);
            }
        }
    }

    private void clearAllMessagesLocked(String reason) {
        clearPendingMessagesLocked(reason);
        clearInFlightMessagesLocked(reason);
    }

    private void clearPendingMessagesLocked(String reason) {
        while (!pendingMessages.isEmpty()) {
            releaseMagicLocked(pendingMessages.removeFirst(), "cleared pending: " + reason);
        }
    }

    private void clearInFlightMessagesLocked(String reason) {
        while (!inFlightMessages.isEmpty()) {
            releaseMagicLocked(inFlightMessages.removeFirst(), "cleared inflight: " + reason);
        }
    }

    private void releaseMagicLocked(OutboundMessage message, String reason) {
        if (message == null || message.magic < BleMagicPool.MIN_MAGIC || message.magic > BleMagicPool.MAX_MAGIC) {
            return;
        }
        magicPool.release(message.sid, message.magic, message.label, reason);
    }

    private void recordUnexpectedAckLocked(int sid, int magic) {
        if (magic < BleMagicPool.MIN_MAGIC || magic > BleMagicPool.MAX_MAGIC) {
            return;
        }
        BleMagicPool.ReleaseRecord previous = magicPool.getReleaseRecord(sid, magic);
        if (previous == null) {
            String pendingNote = hasPendingMagicLocked(sid, magic) ? " while that magic is only pending locally" : "";
            logLine("unexpected ACK sid=" + sid + " magic=" + magic + pendingNote
                    + "; possible Even app BLE contention");
            return;
        }
        if ("timeout".equals(previous.reason)) {
            logLine("late ACK after timeout sid=" + sid + " magic=" + magic
                    + " label=" + previous.label
                    + "; ACK timeout may be too short");
            return;
        }
        if ("ack".equals(previous.reason)) {
            logLine("duplicate ACK for already-acked message sid=" + sid + " magic=" + magic
                    + " label=" + previous.label
                    + "; possible Even app BLE contention");
            return;
        }
        logLine("late ACK for released message sid=" + sid + " magic=" + magic
                + " label=" + previous.label
                + " release=" + previous.reason);
    }

    private void handleTransportFailure(String reason) {
        Log.i(TAG, "handleTransportFailure called");
        synchronized (lock) {
            handleTransportFailureLocked(reason);
        }
    }

    private void handleTransportFailureLocked(String reason) {
        Log.e(TAG, "Transport failure: "+reason);
        maybeEmitEvenAppConflictLocked(reason);
        sessionReady = false;
        fixedLayoutCreated = false;
        warmedUp = false;
        startupProbePending = false;
        shutdownRequested = false;
        imageRetryAfterMs = 0;
        displayedFingerprint = "";
        displayedTileBmps = emptyTileSet();
        clearAllMessagesLocked("transport failure: " + reason);
        reconnectAfterMs = SystemClock.elapsedRealtime() + RECONNECT_DELAY_MS;
        if (!userDisconnectRequested) {
            phase = "retrying";
            status = reason == null || reason.isEmpty() ? "Reconnecting..." : "Reconnecting after " + reason;
        }
        lock.notifyAll();
        interruptibleSleep.interrupt();
        bleManager.disconnect(rightAddress);
        bleManager.disconnect(leftAddress);
        emitState();
    }

    private void resetSessionStateLocked() {
        sessionReady = false;
        fixedLayoutCreated = false;
        warmedUp = false;
        rightConnected = false;
        leftConnected = false;
        reconnectAfterMs = 0;
        lastAckAtMs = 0;
        lastIncomingAtMs = 0;
        lastHeartbeatQueuedAtMs = 0;
        lastSessionReadyAtMs = 0;
        consecutiveAckTimeouts = 0;
        displayedFingerprint = "";
        displayedTileBmps = emptyTileSet();
    }

    private boolean hasPendingOrInflightTileLocked(int tileIndex) {
        for (OutboundMessage queued : pendingMessages) {
            if (queued.tileIndex == tileIndex && ("image".equals(queued.kind) || "warmup".equals(queued.kind))) {
                return true;
            }
        }
        for (OutboundMessage inFlight : inFlightMessages) {
            if (inFlight.tileIndex == tileIndex && ("image".equals(inFlight.kind) || "warmup".equals(inFlight.kind))) {
                return true;
            }
        }
        return false;
    }

    private AsyncEvent decodeAsyncEventLocked(BleProtocol.ParsedFrame frame) {
        byte[] pb = BleProtocol.stripTrailingCrc(frame.pb);
        byte[] deviceEvent = BleProtocol.readFieldBytes(pb, 13);
        if (deviceEvent == null) {
            return null;
        }

        byte[] listEvent = BleProtocol.readFieldBytes(deviceEvent, 1);
        if (listEvent != null) {
            return new AsyncEvent(
                "list-click",
                BleProtocol.readStringFieldValue(listEvent, 2),
                BleProtocol.readVarintFieldValue(listEvent, 5, BleProtocol.EVENT_CLICK),
                0,
                0
            );
        }

        byte[] textEvent = BleProtocol.readFieldBytes(deviceEvent, 2);
        if (textEvent != null) {
            return new AsyncEvent(
                "text-click",
                BleProtocol.readStringFieldValue(textEvent, 2),
                BleProtocol.readVarintFieldValue(textEvent, 3, BleProtocol.EVENT_CLICK),
                0,
                0
            );
        }

        byte[] sysEvent = BleProtocol.readFieldBytes(deviceEvent, 3);
        if (sysEvent != null) {
            int eventType = BleProtocol.readVarintFieldValue(sysEvent, 1, BleProtocol.EVENT_CLICK);
            int eventSource = BleProtocol.readVarintFieldValue(sysEvent, 2, 0);
            int exitReason = BleProtocol.readVarintFieldValue(sysEvent, 4, 0);
            if (eventType == BleProtocol.EVENT_FOREGROUND_EXIT || eventType == BleProtocol.EVENT_ABNORMAL_EXIT || eventType == BleProtocol.EVENT_SYSTEM_EXIT) {
                if (shutdownRequested) {
                    lastShutdownExitAtMs = SystemClock.elapsedRealtime();
                }
                fixedLayoutCreated = false;
                warmedUp = false;
                displayedFingerprint = "";
                displayedTileBmps = emptyTileSet();
                clearAllMessagesLocked("firmware exit event");
            }
            return new AsyncEvent("sys-event", "", eventType, eventSource, exitReason);
        }
        return null;
    }

    private void emitRingEvent(String kind, String containerName, int eventType, int eventSource, int systemExitReasonCode) {
        final FaceclawBleCommunicatorListener current = listener;
        if (current == null) {
            return;
        }
        final String containerNameSnapshot = containerName == null ? "" : containerName;
        mainHandler.post(() -> {
            try {
                current.onRingEvent(kind, containerNameSnapshot, eventType, eventSource, systemExitReasonCode);
            } catch (Throwable t) {
                Log.w(TAG, "listener onRingEvent failed", t);
            }
        });
    }

    private void emitBatteryState(int headsetBattery, int headsetCharging) {
        final FaceclawBleCommunicatorListener current = listener;
        if (current == null) {
            return;
        }
        mainHandler.post(() -> {
            try {
                current.onBatteryState(headsetBattery, headsetCharging);
            } catch (Throwable t) {
                Log.w(TAG, "listener onBatteryState failed", t);
            }
        });
    }

    private void emitFrameMetrics(int paintMs, int transmitMs, int tileCount) {
        final FaceclawBleCommunicatorListener current = listener;
        if (current == null) {
            return;
        }
        mainHandler.post(() -> {
            try {
                current.onFrameMetrics(paintMs, transmitMs, tileCount);
            } catch (Throwable t) {
                Log.w(TAG, "listener onFrameMetrics failed", t);
            }
        });
    }

    private void maybeEmitEvenAppConflictLocked(String reason) {
        if (!"write failed".equals(reason)) {
            return;
        }
        long now = SystemClock.elapsedRealtime();
        if (lastSessionReadyAtMs <= 0 || now - lastSessionReadyAtMs > EVEN_APP_WRITE_FAILURE_WINDOW_MS) {
            return;
        }
        if (lastEvenAppConflictAtMs > 0 && now - lastEvenAppConflictAtMs < 60_000) {
            return;
        }
        if (!FaceclawEvenAppDetector.isEvenNotificationActive(appContext)) {
            return;
        }
        lastEvenAppConflictAtMs = now;
        emitEvenAppConflict("The Even Realities app still appears to be running. It can hold the glasses BLE link and cause Faceclaw write failures. Open its app settings and force stop it, then reconnect Faceclaw.");
    }

    private void emitEvenAppConflict(String message) {
        final FaceclawBleCommunicatorListener current = listener;
        if (current == null) {
            return;
        }
        final String messageSnapshot = message == null ? "" : message;
        mainHandler.post(() -> {
            try {
                current.onEvenAppConflict(messageSnapshot);
            } catch (Throwable t) {
                Log.w(TAG, "listener onEvenAppConflict failed", t);
            }
        });
    }

    private void setState(String nextPhase, String nextStatus) {
        synchronized (lock) {
            phase = nextPhase;
            status = nextStatus;
        }
        emitState();
    }

    private void emitState() {
        final FaceclawBleCommunicatorListener current = listener;
        if (current == null) {
            return;
        }
        final String phaseSnapshot;
        final String statusSnapshot;
        synchronized (lock) {
            phaseSnapshot = phase;
            statusSnapshot = status;
        }
        mainHandler.post(() -> {
            try {
                current.onStateChange(phaseSnapshot, statusSnapshot);
            } catch (Throwable t) {
                Log.w(TAG, "listener onStateChange failed", t);
            }
        });
    }

    private void logLine(String line) {
        Log.i(TAG, line);
        final FaceclawBleCommunicatorListener current = listener;
        if (current == null) {
            return;
        }
        mainHandler.post(() -> {
            try {
                current.onLog(line);
            } catch (Throwable t) {
                Log.w(TAG, "listener onLog failed", t);
            }
        });
    }

    private static String timestamp(long elapsedMs) {
        long wallMs = System.currentTimeMillis();
        return String.format(Locale.US, "%tF %tT.%tL elapsed=%dms", wallMs, wallMs, wallMs, elapsedMs);
    }

    private int nextMagic() {
        return magicPool.allocate();
    }

    private int nextMapSessionId() {
        int id = nextMapSessionId;
        nextMapSessionId = (nextMapSessionId + 1) & 0xff;
        return id;
    }

    private static String requireAddress(String name, String address) {
        if (address == null || address.trim().isEmpty()) {
            throw new IllegalArgumentException(name + " is required");
        }
        return address.trim();
    }

    private static byte[][] emptyTileSet() {
        return new byte[][] {new byte[0], new byte[0], new byte[0], new byte[0]};
    }

    private static String safeMessage(Throwable t) {
        String message = t == null ? "unknown" : t.getMessage();
        return message == null || message.trim().isEmpty() ? String.valueOf(t) : message;
    }
    
    private String getDesiredFingerprint() {
        synchronized (desiredTilesLock) {
            return desiredFingerprint;
        }
    }

    private static final class BleMagicPool {
        static final int MIN_MAGIC = 100;
        static final int MAX_MAGIC = 255;

        private final ArrayDeque<Integer> available = new ArrayDeque<>();
        private final boolean[] allocated = new boolean[256];
        private final Map<String, ReleaseRecord> releaseRecords = new HashMap<>();

        BleMagicPool() {
            for (int magic = MIN_MAGIC; magic <= MAX_MAGIC; magic++) {
                available.addLast(magic);
            }
        }

        int allocate() {
            Integer magic = available.pollFirst();
            if (magic == null) {
                throw new IllegalStateException("no BLE magic values available");
            }
            allocated[magic] = true;
            return magic;
        }

        void release(int sid, int magic, String label, String reason) {
            if (magic < MIN_MAGIC || magic > MAX_MAGIC) {
                return;
            }
            releaseRecords.put(key(sid, magic), new ReleaseRecord(label, reason, SystemClock.elapsedRealtime()));
            if (!allocated[magic]) {
                return;
            }
            allocated[magic] = false;
            available.addLast(magic);
        }

        ReleaseRecord getReleaseRecord(int sid, int magic) {
            return releaseRecords.get(key(sid, magic));
        }

        private static String key(int sid, int magic) {
            return sid + ":" + magic;
        }

        private static final class ReleaseRecord {
            final String label;
            final String reason;
            final long releasedAtMs;

            ReleaseRecord(String label, String reason, long releasedAtMs) {
                this.label = label == null ? "" : label;
                this.reason = reason == null ? "" : reason;
                this.releasedAtMs = releasedAtMs;
            }
        }
    }

    private static final class AsyncEvent {
        final String kind;
        final String containerName;
        final int eventType;
        final int eventSource;
        final int systemExitReasonCode;

        AsyncEvent(String kind, String containerName, int eventType, int eventSource, int systemExitReasonCode) {
            this.kind = kind;
            this.containerName = containerName;
            this.eventType = eventType;
            this.eventSource = eventSource;
            this.systemExitReasonCode = systemExitReasonCode;
        }
    }

    private static final class TileImagePlan {
        final int tileIndex;
        final BleProtocol.ImageTileOptions tile;
        final byte[] bmp;
        final int sessionId;
        List<BleProtocol.ImageFragment> fragments = Collections.emptyList();

        TileImagePlan(int tileIndex, BleProtocol.ImageTileOptions tile, byte[] bmp, int sessionId) {
            this.tileIndex = tileIndex;
            this.tile = tile;
            this.bmp = copyTileBmp(bmp);
            this.sessionId = sessionId;
        }
    }

    private static final class ImageUpdateStats {
        final int paintMs;
        final int tileCount;
        long firstWriteStartedAtMs;

        ImageUpdateStats(int paintMs, int tileCount) {
            this.paintMs = Math.max(0, paintMs);
            this.tileCount = tileCount;
        }
    }

    private static final class OutboundMessage {
        final String kind;
        final String label;
        final int sid;
        final int magic;
        final List<byte[]> frames;
        final int ackTimeoutMs;
        final String fingerprint;
        final int tileIndex;
        final byte[] tileBmp;

        int imageUpdateId;
        int imageMessageNumber;
        int imageMessageCount;
        long sentAtMs;
        long writeStartedAtMs;
        long ackDeadlineAtMs;
        byte[] ackPayload = new byte[0];

        OutboundMessage(String kind, String label, int sid, int magic, List<byte[]> frames, int ackTimeoutMs, String fingerprint, int tileIndex, byte[] tileBmp) {
            this.kind = kind;
            this.label = label;
            this.sid = sid;
            this.magic = magic;
            this.frames = frames;
            this.ackTimeoutMs = ackTimeoutMs;
            this.fingerprint = fingerprint == null ? "" : fingerprint;
            this.tileIndex = tileIndex;
            this.tileBmp = copyTileBmp(tileBmp);
        }

        OutboundMessage(String label, int sid, int magic, List<byte[]> frames, int writeTimeoutMs, int ignored, long ackDeadlineAtMs) {
            this.kind = "prelude";
            this.label = label;
            this.sid = sid;
            this.magic = magic;
            this.frames = frames;
            this.ackTimeoutMs = writeTimeoutMs;
            this.fingerprint = "";
            this.tileIndex = -1;
            this.tileBmp = new byte[0];
            this.ackDeadlineAtMs = ackDeadlineAtMs;
        }

        void setImageUpdatePosition(int updateId, int messageNumber, int messageCount) {
            this.imageUpdateId = updateId;
            this.imageMessageNumber = messageNumber;
            this.imageMessageCount = messageCount;
        }
    }

    private static byte[] copyTileBmp(byte[] bmp) {
        if (bmp == null || bmp.length == 0) {
            return new byte[0];
        }
        return Arrays.copyOf(bmp, bmp.length);
    }
}
