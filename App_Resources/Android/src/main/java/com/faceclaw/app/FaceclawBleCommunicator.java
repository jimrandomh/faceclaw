package com.faceclaw.app;

import android.annotation.SuppressLint;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCharacteristic;
import android.content.Context;
import android.graphics.Bitmap;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
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
    private long lastHeartbeatSentAtMs;
    private long lastHeartbeatAckedAtMs;
    private long lastConnectionOrInputAtMs;
    private long lastBatteryRefreshAtMs;
    private long imageRetryAfterMs;
    private long lastSessionReadyAtMs;
    private long lastEvenAppConflictAtMs;
    private int consecutiveAckTimeouts;
    private int lastAudioControlAckMagic = 0;

    private ConnectionOptions connectionOptions = new ConnectionOptions();
    private final BleMagicPool magicPool = new BleMagicPool();
    private MessageBuilder messageBuilder = new MessageBuilder(magicPool);
    private int nextTransportSeq = 0x40;
    private int nextMapSessionId = 0;
    private int nextImageUpdateId = 1;
    private int lastShutdownAckMagic = 0;
    private long lastShutdownExitAtMs = 0;
    private int headsetBattery = -1;
    private int headsetCharging = -1;
    private boolean audioCaptureActive;
    private volatile FaceclawAudioPacketListener audioPacketListener;

    private String displayedFingerprint = "";
    private byte[][] displayedTileBmps = emptyTileSet();
    private final Map<Integer, BleImageOptimizer.ImageUpdateStats> imageUpdateStats = new HashMap<>();

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
            audioCaptureActive = false;
            audioPacketListener = null;
            threadToJoin = workerThread;
        }
        setStateDisplay("disconnecting", "Disconnecting...");
        interruptibleSleep.interrupt();
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
            resetSessionStateLocked();
            clearAllMessagesLocked("disconnect");
        }
        bleManager.disconnect(rightAddress);
        bleManager.disconnect(leftAddress);
        bleManager.close();
        setStateDisplay("disconnected", "Disconnected.");
    }

    public void close() {
        disconnect();
    }

    public boolean startG2AudioCapture(FaceclawAudioPacketListener listener) {
        if (listener == null) {
            throw new IllegalArgumentException("listener is required");
        }
        int magic;
        synchronized (lock) {
            if (!running || !sessionReady) {
                logLine("skip G2 mic enable; session not ready");
                return false;
            }
            audioPacketListener = listener;
            OutboundMessage message = createAudioControlMessageLocked(true);
            magic = message.magic;
            pendingMessages.addFirst(message);
            logLine("queue G2 mic enable");
        }
        interruptibleSleep.interrupt();
        return waitForAudioControlAck(magic, "enable");
    }

    public void stopG2AudioCapture() {
        int magic = 0;
        synchronized (lock) {
            audioPacketListener = null;
            audioCaptureActive = false;
            clearMessagesOfKindLocked("audio-control");
            if (running && sessionReady) {
                OutboundMessage message = createAudioControlMessageLocked(false);
                magic = message.magic;
                pendingMessages.addFirst(message);
                logLine("queue G2 mic disable");
            }
        }
        interruptibleSleep.interrupt();
        if (magic != 0) {
            waitForAudioControlAck(magic, "disable");
        }
    }

    public boolean isSessionReady() {
        synchronized (lock) {
            return running && sessionReady;
        }
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
        Log.i(TAG, "Received an updated frame ");
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

    public Bitmap createPreviewBitmap(int[] colors, int width, int height) {
        if (colors == null) {
            throw new IllegalArgumentException("colors are required");
        }
        if (width <= 0 || height <= 0 || colors.length < width * height) {
            throw new IllegalArgumentException("invalid preview bitmap dimensions");
        }
        return Bitmap.createBitmap(colors, width, height, Bitmap.Config.ARGB_8888);
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
            OutboundMessage message = messageBuilder.shutdown(exitMode);
            magic = message.magic;
            message.onAck = () -> {
                lastShutdownAckMagic = message.magic;
                fixedLayoutCreated = false;
                warmedUp = false;
                displayedFingerprint = "";
                displayedTileBmps = emptyTileSet();
            };
            message.onTimeout = () -> {
                handleTransportFailure("shutdown ack timeout");
            };
            pendingMessages.addFirst(message);
            logLine("queue shutdown");
        }
        interruptibleSleep.interrupt();

        long ackDeadline = SystemClock.elapsedRealtime() + ConnectionOptions.ACK_TIMEOUT_MS + 500;
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
                long exitDeadline = SystemClock.elapsedRealtime() + ConnectionOptions.ACK_TIMEOUT_MS + 500;
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

    private boolean waitForAudioControlAck(int magic, String operation) {
        long deadline = SystemClock.elapsedRealtime() + ConnectionOptions.ACK_TIMEOUT_MS + ConnectionOptions.WRITE_TIMEOUT_MS + 500;
        synchronized (lock) {
            while (running && sessionReady && lastAudioControlAckMagic != magic && hasPendingOrInflightMagicLocked(magic)) {
                long remaining = deadline - SystemClock.elapsedRealtime();
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
            boolean acked = lastAudioControlAckMagic == magic;
            if (!acked) {
                if ("enable".equals(operation)) {
                    audioPacketListener = null;
                    audioCaptureActive = false;
                }
                logLine("G2 mic " + operation + " ack timeout");
            }
            return acked;
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
                        interruptibleSleep.sleep(Math.min(ConnectionOptions.IDLE_SLEEP_MS, reconnectAfterMs - now));
                        continue;
                    }
                    Log.w(TAG, "Attempting to connect");
                    connectLoopOnce();
                    continue;
                }

                long sleepMs = driveSession();
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
        if (BleProtocol.RENDER_NOTIFY_UUID.equals(uuid)) {
            handleRenderNotification(address, data);
            return;
        }
        if (!BleProtocol.NOTIFY_CHAR_UUID.equals(uuid)) {
            return;
        }
        Log.d(TAG, "onNotification: address=" + address + " characteristicUuid=" + characteristicUuid + " data.length=" + data.length);
        BleProtocol.ParsedFrame frame = BleProtocol.parseFrame(data);
        G2Event event = null;
        synchronized (lock) {
            lastIncomingAtMs = SystemClock.elapsedRealtime();
            if (frame.ok && frame.msgSeq >= 0 && frame.flag != BleProtocol.FLAG_NOTIFY && frame.flag != BleProtocol.FLAG_NOTIFY_ALT) {
                lastAckAtMs = lastIncomingAtMs;
                resolveAckLocked(frame.sid, frame.msgSeq, frame.pb);
            }
            if (frame.ok && address.equalsIgnoreCase(rightAddress) && (frame.flag == BleProtocol.FLAG_NOTIFY || frame.flag == BleProtocol.FLAG_NOTIFY_ALT)) {
                event = G2Event.decode(frame);
                if (event != null) {
                    lastConnectionOrInputAtMs = lastIncomingAtMs;
                    if (event.kind == "sys-event") {
                        if (event.eventType == BleProtocol.EVENT_FOREGROUND_EXIT || event.eventType == BleProtocol.EVENT_ABNORMAL_EXIT || event.eventType == BleProtocol.EVENT_SYSTEM_EXIT) {
                            if (shutdownRequested) {
                                lastShutdownExitAtMs = SystemClock.elapsedRealtime();
                            }
                            fixedLayoutCreated = false;
                            warmedUp = false;
                            displayedFingerprint = "";
                            displayedTileBmps = emptyTileSet();
                            clearAllMessagesLocked("firmware exit event");
                        }
                    }
                }
            }
        }
        interruptibleSleep.interrupt();
        if (event != null) {
            emitRingEvent(event.kind, event.containerName, event.eventType, event.eventSource, event.systemExitReasonCode);
        }
    }

    private void handleRenderNotification(String address, byte[] data) {
        FaceclawAudioPacketListener listenerToCall;
        long arrivalMs = SystemClock.elapsedRealtime();
        synchronized (lock) {
            lastIncomingAtMs = arrivalMs;
            listenerToCall = audioCaptureActive ? audioPacketListener : null;
        }
        if (listenerToCall == null) {
            return;
        }
        String arm = address.equalsIgnoreCase(leftAddress) ? "L" : address.equalsIgnoreCase(rightAddress) ? "R" : "?";
        try {
            listenerToCall.onAudioPacket(Arrays.copyOf(data, data.length), arm, arrivalMs);
        } catch (Throwable t) {
            logLine("G2 mic packet listener failed: " + safeMessage(t));
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
                audioCaptureActive = false;
                audioPacketListener = null;
                clearAllMessagesLocked("connection lost");
                displayedFingerprint = "";
                displayedTileBmps = emptyTileSet();
                reconnectAfterMs = SystemClock.elapsedRealtime() + ConnectionOptions.RECONNECT_DELAY_MS;
            }
        }
        interruptibleSleep.interrupt();
        if (connected) {
            setStateDisplay("connected", "Connected.");
        } else {
            setStateDisplay("connecting", "Connecting to the glasses...");
        }
    }

    private void connectLoopOnce() throws InterruptedException { //{{{
        setStateDisplay("connecting", "Connecting to the glasses...");
        try {
            connectArm(rightAddress, true);
            connectArm(leftAddress, true);
            if (!sleepDuringConnectSettling(800)) {
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
                lastHeartbeatSentAtMs = 0;
                lastHeartbeatAckedAtMs = 0;
                consecutiveAckTimeouts = 0;
                lastAudioControlAckMagic = 0;
                audioCaptureActive = false;
            }
            setStateDisplay("connected", "Connected.");
            logLine("session ready");
        } catch (Throwable t) {
            logLine("connect failed: " + safeMessage(t));
            handleTransportFailure("connect failed");
        }
    } //}}}

    private boolean sleepDuringConnectSettling(long delayMs) throws InterruptedException {
        long deadline = SystemClock.elapsedRealtime() + delayMs;
        synchronized (lock) {
            while (running && !userDisconnectRequested) {
                long remaining = deadline - SystemClock.elapsedRealtime();
                if (remaining <= 0) {
                    return true;
                }
                lock.wait(Math.min(remaining, 100));
            }
            return false;
        }
    }

    private void connectArm(String address, boolean enableRenderNotify) {
        if (!bleManager.connect(address, ConnectionOptions.CONNECT_TIMEOUT_MS)) {
            throw new IllegalStateException("connect failed: " + address);
        }
        // requestConnectionPriority has no callback in this Android compile target, so there is
        // no reliable completion point to keep it in the global GATT operation pipeline. But it's
        // important enough for performance that we call it anyways.
        bleManager.requestConnectionPriority(address, BluetoothGatt.CONNECTION_PRIORITY_HIGH);

        bleManager.requestMtu(address, ConnectionOptions.DESIRED_MTU, ConnectionOptions.CONNECT_TIMEOUT_MS);

        if (!bleManager.discoverServices(address, ConnectionOptions.SERVICES_TIMEOUT_MS)) {
            throw new IllegalStateException("discoverServices failed: " + address);
        }
        if (!bleManager.enableNotifications(address, BleProtocol.NOTIFY_CHAR_UUID, true, ConnectionOptions.DESCRIPTOR_TIMEOUT_MS)) {
            throw new IllegalStateException("enableNotifications failed: " + address + " " + BleProtocol.NOTIFY_CHAR_UUID);
        }
        if (enableRenderNotify) {
            bleManager.enableNotifications(address, BleProtocol.RENDER_NOTIFY_UUID, true, ConnectionOptions.DESCRIPTOR_TIMEOUT_MS);
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
        }
        long now = SystemClock.elapsedRealtime();
        OutboundMessage prelude = messageBuilder.prelude();
        prelude.onAck = () -> {
        };
        prelude.onTimeout = () -> {
            handleTransportFailure("ack timeout");
        };
        prelude.sentAtMs = now;
        writeMessage(prelude);

        long deadline = SystemClock.elapsedRealtime() + ConnectionOptions.PRELUDE_TIMEOUT_MS;
        while (running && !userDisconnectRequested && !inFlightMessages.isEmpty()) {
            synchronized (lock) {
                if (!running || userDisconnectRequested || inFlightMessages.isEmpty()) {
                    break;
                }
            }
            long remaining = deadline - SystemClock.elapsedRealtime();
            if (remaining <= 0) {
                break;
            }
            interruptibleSleep.sleep(Math.min(remaining, 100));
        }
        synchronized (lock) {
            if (!inFlightMessages.isEmpty()) {
                clearInFlightMessagesLocked("prelude timeout");
                throw new IllegalStateException("prelude ack timeout");
            }
        }
    } //}}}

    private long driveSession() {
        //Log.d(TAG, "driveSession called (pendingMessages.size=" + pendingMessages.size() + " inFlightMessages.size=" + inFlightMessages.size() + ")");
        while (true) {
            OutboundMessage messageToWrite = null;
            long now = SystemClock.elapsedRealtime();

            synchronized (lock) {
                if (!inFlightMessages.isEmpty()) {
                    OutboundMessage oldest = inFlightMessages.peekFirst();
                    if (oldest != null && oldest.ackDeadlineAtMs <= now) {
                        Log.i(TAG, "message timed out: " + oldest.label);
                        inFlightMessages.removeFirst();
                        logLine("message timed out: " + oldest.label);
                        magicPool.release(oldest.sid, oldest.magic, oldest.label, "timeout");
                        handleAckTimeoutLocked(oldest);
                        return 0;
                    }
                }

                if (!shutdownRequested && !fixedLayoutCreated && pendingMessages.isEmpty() && inFlightMessages.isEmpty()) {
                    Log.i(TAG, "enqueueing create layout");
                    enqueueCreateLayoutLocked();
                }
                if (!shutdownRequested && fixedLayoutCreated && !warmedUp && pendingMessages.isEmpty() && inFlightMessages.isEmpty()) {
                    Log.i(TAG, "enqueueing warmup");
                    enqueueWarmupLocked();
                }

                if (handleHeartbeat()) {
                    return ConnectionOptions.IDLE_SLEEP_MS;
                }

                if (sessionReady && inFlightMessages.size() < connectionOptions.WINDOW_SIZE && !pendingMessages.isEmpty()) {
                    OutboundMessage pending = pendingMessages.peekFirst();
                    messageToWrite = pendingMessages.removeFirst();
                    Log.i(TAG, "sending pending message: " + messageToWrite.label);
                } else if (!shutdownRequested && fixedLayoutCreated && warmedUp && pendingMessages.isEmpty() && inFlightMessages.isEmpty()
                        && now >= imageRetryAfterMs
                        && !getDesiredFingerprint().equals(displayedFingerprint)) {
                    Log.i(TAG, "Enqueued image update");
                    enqueueDesiredImageLocked();
                    return 0;
                } else if (shouldPollBatteryLocked(now)) {
                    Log.i(TAG, "Writing battery query");
                    messageToWrite = createBatteryQueryMessageLocked();
                    lastBatteryRefreshAtMs = now;
                } else if (!pendingMessages.isEmpty() || !inFlightMessages.isEmpty()) {
                    return ConnectionOptions.IDLE_SLEEP_MS;
                } else {
                    return 250;
                }
            }

            if (!writeMessage(messageToWrite)) {
                synchronized (lock) {
                    if (removePreparedMessageLocked(messageToWrite) || messageToWrite.magic == 0) {
                        handleTransportFailure("write failed");
                    }
                }
                return 0;
            }
        }
    }

    private boolean handleHeartbeat() {
        long now = SystemClock.elapsedRealtime();
        boolean heartbeatEligible = !shutdownRequested && warmedUp && fixedLayoutCreated;
        boolean heartbeatPending = heartbeatEligible && hasPendingOrInflightKindLocked("heartbeat");
        long heartbeatElapsedMs = now - lastHeartbeatAckedAtMs;
        boolean heartbeatReady = heartbeatEligible && heartbeatElapsedMs >= ConnectionOptions.HEARTBEAT_READY_MS;
        boolean heartbeatUrgent = heartbeatEligible && heartbeatElapsedMs >= ConnectionOptions.HEARTBEAT_URGENT_MS;
        boolean heartbeatBlocksLeftWrites = heartbeatReady || heartbeatPending;

        if (heartbeatReady && !heartbeatPending && inFlightMessages.isEmpty()) {
            Log.i(TAG, "Writing heartbeat");
            OutboundMessage heartbeatMessage = createHeartbeatMessage();
            lastHeartbeatSentAtMs = now;
            writeMessage(heartbeatMessage);
            return true;
        } else if (heartbeatUrgent) {
            return true;
        } else if (heartbeatPending) {
            // Don't send other message types while a heartbeat is pending because that
            // can lead to inter-lens sync issues
            return true;
        }

        return false;
    }

    private OutboundMessage createHeartbeatMessage() {
        OutboundMessage message = messageBuilder.heartbeat();
        message.onAck = () -> {
            synchronized (lock) {
                lastHeartbeatAckedAtMs = SystemClock.elapsedRealtime();
            }
        };
        message.onTimeout = () -> {
            // If a heartbeat fails to ack and we're over the heartbeat deadline, assume the connection is failed and reconnect.
            // Otherwise ignore it, which will cause a retransmission attempt.
            boolean isPastDeadline;
            synchronized (lock) {
                isPastDeadline = SystemClock.elapsedRealtime() - lastHeartbeatSentAtMs >= ConnectionOptions.HEARTBEAT_FAILURE_DEADLINE_MS;
            }
            if (isPastDeadline) {
                handleTransportFailure("heartbeat ack timeout");
            }
        };
        return message;
    }


    private boolean writeMessage(OutboundMessage message) {
        long now = SystemClock.elapsedRealtime();
        message.writeStartedAtMs = now;
        message.sentAtMs = now;
        message.ackDeadlineAtMs = now + message.ackTimeoutMs + ConnectionOptions.WRITE_TIMEOUT_MS;
        if (message.magic != 0) {
            synchronized (lock) {
                inFlightMessages.addLast(message);
            }
        }
        if (message.imageUpdateId > 0 && message.imageMessageNumber == 1) {
            synchronized(lock) {
                BleImageOptimizer.ImageUpdateStats stats = imageUpdateStats.get(message.imageUpdateId);
                if (stats != null && stats.firstWriteStartedAtMs <= 0) {
                    stats.firstWriteStartedAtMs = now;
                }
            }
        }

        String writeAddress = message.isLeftArmMessage ? leftAddress : rightAddress;
        List<byte[]> frames = BleProtocol.framePb(
            message.message,
            message.sid,
            message.flag,
            nextTransportSeq++
        );
        boolean result = bleManager.writeFrames(
            writeAddress,
            BleProtocol.WRITE_CHAR_UUID,
            frames,
            ConnectionOptions.WRITE_TYPE,
            ConnectionOptions.WRITE_TIMEOUT_MS
        );

        synchronized (lock) {
            long sentAtMs = SystemClock.elapsedRealtime();
            message.sentAtMs = sentAtMs;
            message.ackDeadlineAtMs = sentAtMs + message.ackTimeoutMs;
            logImageUpdateSendLandmarkLocked(message);
        }

        return result;
    }

    private boolean removePreparedMessageLocked(OutboundMessage message) {
        if (message == null || message.magic == 0) {
            return false;
        }
        Iterator<OutboundMessage> iterator = inFlightMessages.iterator();
        while (iterator.hasNext()) {
            if (iterator.next() == message) {
                iterator.remove();
                magicPool.release(message.sid, message.magic, message.label, "write failed");
                return true;
            }
        }
        return false;
    }

    private void resolveAckLocked(int sid, int magic, byte[] pb) {
        Iterator<OutboundMessage> iterator = inFlightMessages.iterator();
        while (iterator.hasNext()) {
            OutboundMessage message = iterator.next();
            if (message.sid == sid && message.magic == magic) {
                resolveAckLocked(message, pb);
                return;
            }
        }
        recordUnexpectedAckLocked(sid, magic);
    }

    private void resolveAckLocked(OutboundMessage message, byte[] pb) {
        Log.i(TAG, "Got ACK for " + message.label + "(sid=" + message.sid + ", id=" + message.magic + ")");
        inFlightMessages.remove(message);
        message.ackPayload = pb == null ? new byte[0] : Arrays.copyOf(pb, pb.length);
        magicPool.release(message.sid, message.magic, message.label, "ack");
        if (message.onAck != null) {
            message.onAck.run();
        }
        consecutiveAckTimeouts = 0;
    }

    private void logImageUpdateSendLandmarkLocked(OutboundMessage message) {
        if (message.imageUpdateId <= 0) {
            return;
        }
        if (message.imageMessageNumber == 1) {
            BleImageOptimizer.ImageUpdateStats stats = imageUpdateStats.get(message.imageUpdateId);
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
        BleImageOptimizer.ImageUpdateStats stats = imageUpdateStats.remove(message.imageUpdateId);
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
        OutboundMessage message = messageBuilder.createLayout(DASHBOARD_TILES);
        message.onAck = () -> {
            startupProbePending = false;
            clearMessagesOfKindLocked("startup-text-probe");
            fixedLayoutCreated = true;
            displayedFingerprint = "";
            displayedTileBmps = emptyTileSet();
        };
        message.onTimeout = () -> {
            if (startupProbePending) {
                logLine("create layout timed out while startup text probe is pending");
                if (hasPendingOrInflightKindLocked("startup-text-probe")) {
                    return;
                }
                startupProbePending = false;
            }
            handleTransportFailure("ack timeout");
        };
        pendingMessages.addLast(message);
        logLine("queue create layout");
    }

    private void enqueueStartupProbeLocked() {
        enqueueCreateLayoutLocked();

        OutboundMessage message = messageBuilder.startupTextProbe();
        message.onAck = () -> {
            startupProbePending = false;
            clearMessagesOfKindLocked("create-layout");
            fixedLayoutCreated = true;
            warmedUp = false;
            displayedFingerprint = "";
            displayedTileBmps = emptyTileSet();
            logLine("existing dashboard layout accepted text probe; image warmup still required");
        };
        message.onTimeout = () -> {
            startupProbePending = false;
            if (hasPendingOrInflightKindLocked("create-layout")) {
                return;
            }
            handleTransportFailure("ack timeout");
        };
        pendingMessages.addLast(message);
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
        bmp = BmpUtil.buildBlankWarmupBmp(bmp);
        BleProtocol.ImageTileOptions tile = DASHBOARD_TILES[0];
        int sessionId = nextMapSessionId();
        List<BleProtocol.ImageFragment> fragments = BleImageOptimizer.planImageFragments(bmp, ConnectionOptions.IMAGE_FRAGMENT_SIZE);
        for (BleProtocol.ImageFragment fragment : fragments) {
            OutboundMessage message = messageBuilder.imageWarmupFragment(tile, sessionId, fragment, bmp, connectionOptions.sendImagesToLeft);
            pendingMessages.addLast(message);
            message.onAck = () -> {
                // The first tile warmup primes the image path but does not reliably
                // guarantee that the tile is now visible on-screen, so it must not
                // update the displayed-tile cache used by image dedupe.
                warmedUp = true;
            };
            message.onTimeout = () -> {
                warmedUp = false;
                clearMessagesOfKindLocked("warmup");
                displayedFingerprint = "";
                displayedTileBmps = emptyTileSet();
            };
        }
        logLine("queue blank warmup");
    }

    private void enqueueDesiredImageLocked() {
        String fingerprint = getDesiredFingerprint();
        List<BleImageOptimizer.TileImagePlan> changedTiles = new ArrayList<>();
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
            changedTiles.add(new BleImageOptimizer.TileImagePlan(i, tile, bmp, nextMapSessionId()));
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
        for (BleImageOptimizer.TileImagePlan plan : changedTiles) {
            plan.fragments = BleImageOptimizer.planImageFragments(plan.bmp, ConnectionOptions.IMAGE_FRAGMENT_SIZE, reserveLastByte);
        }

        int updateId = nextImageUpdateId++;
        imageUpdateStats.put(updateId, new BleImageOptimizer.ImageUpdateStats(paintMs, changedTiles.size()));
        int messageCount = 0;
        for (BleImageOptimizer.TileImagePlan plan : changedTiles) {
            messageCount += plan.fragments.size();
        }
        int messageNumber = 1;
        if (!synchronizedCommits) {
            for (BleImageOptimizer.TileImagePlan plan : changedTiles) {
                for (int i = 0; i < plan.fragments.size(); i++) {
                    BleProtocol.ImageFragment fragment = plan.fragments.get(i);
                    boolean requestAck = true;
                    boolean isLast = i == plan.fragments.size() - 1;
                    enqueueImageFragmentLocked(plan, fragment, fingerprint, updateId, messageNumber++, messageCount, requestAck, isLast);
                }
            }
        } else {
            for (BleImageOptimizer.TileImagePlan plan : changedTiles) {
                for (int i = 0; i < plan.fragments.size() - 1; i++) {
                    boolean requestAck = true;
                    boolean isLast = false;
                    enqueueImageFragmentLocked(plan, plan.fragments.get(i), fingerprint, updateId, messageNumber++, messageCount, requestAck, isLast);
                }
            }
            for (BleImageOptimizer.TileImagePlan plan : changedTiles) {
                boolean isLast = true;
                enqueueImageFragmentLocked(plan, plan.fragments.get(plan.fragments.size() - 1), fingerprint, updateId, messageNumber++, messageCount, true, isLast);
            }
        }

        logLine("queue image update#" + updateId + " fingerprint=" + fingerprint
                + " changedTiles=" + changedTiles.size() + " messages=" + messageCount
                + " synchronizedCommits=" + synchronizedCommits);
    }

    private void enqueueImageFragmentLocked(
        BleImageOptimizer.TileImagePlan plan,
        BleProtocol.ImageFragment fragment,
        String fingerprint,
        int updateId,
        int messageNumber,
        int messageCount,
        boolean requestAck,
        boolean isLast
    ) {
        OutboundMessage message = messageBuilder.imageFragment(fragment, plan, requestAck, connectionOptions.sendImagesToLeft);
        message.setImageUpdatePosition(updateId, messageNumber, messageCount);
        message.onAck = () -> {
            imageRetryAfterMs = 0;
            logImageUpdateAckLandmarkLocked(message);
            if (message.tileIndex >= 0 && !hasPendingOrInflightTileLocked(message.tileIndex)) {
                displayedTileBmps[message.tileIndex] = BmpUtil.copyTileBmp(plan.bmp);
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
                    displayedFingerprint = fingerprint;
                }
            }
        };
        message.onTimeout = () -> {
            imageUpdateStats.remove(message.imageUpdateId);
            clearMessagesOfKindLocked("image");
            displayedFingerprint = "";
            displayedTileBmps = emptyTileSet();
            imageRetryAfterMs = SystemClock.elapsedRealtime() + ConnectionOptions.IMAGE_RETRY_DELAY_MS;
        };
        pendingMessages.addLast(message);
    }

    private OutboundMessage createAudioControlMessageLocked(boolean enable) {
        OutboundMessage message = messageBuilder.enableOrDisableMic(enable);
        message.onAck = () -> {
            lastAudioControlAckMagic = message.magic;
            audioCaptureActive = message.label != null && message.label.contains("enable");
            logLine(audioCaptureActive ? "G2 mic enabled" : "G2 mic disabled");
        };
        message.onTimeout = () -> {
            handleTransportFailure("audio control ack timeout");
        };
        return message;
    }

    private boolean shouldPollBatteryLocked(long now) {
        return !shutdownRequested
                && sessionReady
                && pendingMessages.isEmpty()
                && inFlightMessages.isEmpty()
                && now - lastConnectionOrInputAtMs >= ConnectionOptions.BATTERY_INPUT_QUIET_MS
                && (lastBatteryRefreshAtMs == 0 || now - lastBatteryRefreshAtMs >= ConnectionOptions.BATTERY_REFRESH_INTERVAL_MS);
    }

    private OutboundMessage createBatteryQueryMessageLocked() {
        OutboundMessage message = messageBuilder.batteryQuery();
        message.onAck = () -> {
            BleProtocol.BatterySnapshot snapshot = BleProtocol.parseSettingsBattery(message.ackPayload);
            if (snapshot != null) {
                headsetBattery = snapshot.battery;
                headsetCharging = snapshot.charging;
                emitBatteryState(headsetBattery, headsetCharging);
            }
        };
        message.onTimeout = () -> {
            logLine("Battery query timed out");
        };
        return message;
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

        if (message.onTimeout != null) {
            message.onTimeout.run();
        }

        if (consecutiveAckTimeouts > ConnectionOptions.MAX_CONSECUTIVE_ACK_TIMEOUTS) {
            handleTransportFailure("too many ack timeouts");
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
                magicPool.release(message.sid, message.magic, message.label, "cleared pending " + kind);
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
                magicPool.release(message.sid, message.magic, message.label, "cleared inflight " + kind);
            }
        }
    }

    private void clearAllMessagesLocked(String reason) {
        clearPendingMessagesLocked(reason);
        clearInFlightMessagesLocked(reason);
    }

    private void clearPendingMessagesLocked(String reason) {
        while (!pendingMessages.isEmpty()) {
            var message = pendingMessages.removeFirst();
            magicPool.release(message.sid, message.magic, message.label, "cleared pending: " + reason);
        }
    }

    private void clearInFlightMessagesLocked(String reason) {
        while (!inFlightMessages.isEmpty()) {
            var message = inFlightMessages.removeFirst();
            magicPool.release(message.sid, message.magic, message.label, "cleared inflight: " + reason);
        }
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
        Log.e(TAG, "Transport failure: "+reason);
        synchronized (lock) {
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
            reconnectAfterMs = SystemClock.elapsedRealtime() + ConnectionOptions.RECONNECT_DELAY_MS;
            bleManager.disconnect(rightAddress);
            bleManager.disconnect(leftAddress);
        }
        if (!userDisconnectRequested) {
            setStateDisplay("retrying", reason == null || reason.isEmpty() ? "Reconnecting..." : "Reconnecting after " + reason);
        }
        interruptibleSleep.interrupt();
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
        lastHeartbeatSentAtMs = 0;
        lastSessionReadyAtMs = 0;
        consecutiveAckTimeouts = 0;
        lastAudioControlAckMagic = 0;
        audioCaptureActive = false;
        audioPacketListener = null;
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
        if (lastSessionReadyAtMs <= 0 || now - lastSessionReadyAtMs > ConnectionOptions.EVEN_APP_WRITE_FAILURE_WINDOW_MS) {
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

    private void setStateDisplay(String nextPhase, String nextStatus) {
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

    private int nextMapSessionId() {
        int id = nextMapSessionId;
        int increment = connectionOptions.skipSessionIds ? 2 : 1;
        nextMapSessionId = (nextMapSessionId + increment) & 0xff;
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
        if (t == null) {
            return "unknown";
        }
        StringWriter writer = new StringWriter();
        t.printStackTrace(new PrintWriter(writer));
        String trace = writer.toString();
        if (!trace.trim().isEmpty()) {
            return trace;
        }
        String message = t.getMessage();
        return message == null || message.trim().isEmpty() ? String.valueOf(t) : message;
    }
    
    private String getDesiredFingerprint() {
        synchronized (desiredTilesLock) {
            return desiredFingerprint;
        }
    }
}
