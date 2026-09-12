package com.faceclaw.app;

import android.annotation.SuppressLint;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCharacteristic;
import android.app.KeyguardManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
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
import java.util.TimeZone;

@SuppressLint("MissingPermission")
public class FaceclawBleCommunicator implements FaceclawBleListener, Runnable {
    private static final String TAG = "FaceclawComm";

    // The EvenHub image container is a memory carrier only. Its 576x288 geometry
    // gives the firmware separate 165888-byte display and reconstruction
    // allocations: CFW reuses the former for its 640x480 packed-4bpp shadow and
    // leaves the latter wholly available for compressed incoming messages.
    private static final BleProtocol.ImageTileOptions DASHBOARD_TILE =
        new BleProtocol.ImageTileOptions("img00", 10, 0, 0, 576, 288);

    private static final String G2_SCREEN_WAKE_LOCK_TAG = "Faceclaw:G2Screen";
    private static final long FACECLAW_WAKE_LEASE_RENEW_MS = 45_000;
    private static final long FACECLAW_WAKE_CONTROL_WAIT_MS = 1_500;
    private static final long CFW_CLEANUP_WAIT_MS = 4_000;
    private static final int COMPASS_REPORT_INTERVAL_MS = 100;
    private static final int COMPASS_MIN_CHANGE_DEGREES = 0;

    /**
     * Cap on decoded ring health pages held in memory. A full backlog sync is
     * ~40 pages, so this holds several syncs; oldest is dropped first. This is a
     * holding area for a later health feature, not storage.
     */
    private static final int RING_HEALTH_MAX_RECORDS = 256;

    private final Context appContext;
    private final PowerManager powerManager;
    private final KeyguardManager keyguardManager;
    private final FaceclawBleManager bleManager;
    private final InterruptibleSleep interruptibleSleep = new InterruptibleSleep();
    private final Object lock = new Object();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final String rightAddress;
    private final String leftAddress;
    private final String ringAddress;

    private volatile FaceclawBleCommunicatorListener listener;
    private final java.util.List<FaceclawImuListener> imuListeners =
        new java.util.concurrent.CopyOnWriteArrayList<>();
    /** A compass subscriber plus the Looper it registered from (see addCompassListener). */
    private static final class CompassSubscription {
        final FaceclawCompassListener listener;
        final Handler handler;

        CompassSubscription(FaceclawCompassListener listener, Handler handler) {
            this.listener = listener;
            this.handler = handler;
        }
    }

    private final java.util.List<CompassSubscription> compassSubscriptions =
        new java.util.concurrent.CopyOnWriteArrayList<>();
    private final java.util.List<FaceclawAmbientLightListener> ambientLightListeners =
        new java.util.concurrent.CopyOnWriteArrayList<>();
    private final java.util.List<FaceclawMicStatusListener> micStatusListeners =
        new java.util.concurrent.CopyOnWriteArrayList<>();
    private volatile Thread workerThread;
    private volatile boolean running;
    private volatile boolean userDisconnectRequested;
    // Set when a connect attempt failed while an arm's Android bond is gone:
    // retrying is pointless until the user re-pairs, so the worker loop parks
    // instead of redialing. Cleared by start() (a fresh explicit connect).
    private volatile boolean reconnectHalted;

    private String phase = "disconnected";
    private String status = "Disconnected.";

    private boolean rightConnected;
    private boolean leftConnected;
    private boolean ringConnected;
    private boolean ringNotificationsReady;
    // R1 health-data protocol (RingProtocol). The reassembler and the outbound
    // queue are both guarded by `lock`. Page ACKs are queued rather than written
    // inline because notifications arrive on the GATT callback thread and
    // bleManager.writeFrames() blocks waiting for onCharacteristicWrite, which
    // that same thread has to deliver — writing there would deadlock until the
    // write timeout. The worker loop drains the queue instead.
    private final RingProtocol.Reassembler ringReassembler = new RingProtocol.Reassembler();
    private final ArrayDeque<byte[]> ringOutbound = new ArrayDeque<>();
    private final List<RingProtocol.HealthRecord> ringHealthRecords = new ArrayList<>();
    /**
     * Total records ever appended to {@link #ringHealthRecords}, including every
     * one already consumed or evicted. Never reset.
     *
     * <p>This is the identity behind the ingest watermark. Record N is the Nth
     * ever decoded this session, so a consumer that has durably stored
     * everything below some N can ask for exactly that much to be dropped
     * without racing the pages still arriving above it - see
     * {@link #takeRingHealthBatch()} and
     * {@link #clearRingHealthRecordsBelow(long)}. A plain "clear the list"
     * could not do that: a page landing between the read and the clear would be
     * thrown away having never been ingested. Guarded by {@code lock}.
     */
    private long ringHealthTotalAdded;
    /**
     * The phone-side sequence counter. One counter shared by BOTH ring channels
     * (measured: 78 phone-to-ring writes in the reference capture step by
     * exactly +1 regardless of channel, restarting at 1 on a new connection).
     */
    private int ringSeq;
    private int ringNonce;
    /**
     * Response-driven health-pull state (2026-09-11). Set from
     * {@link #handleRingHealthNotification} (GATT callback thread), waited on
     * from {@link #requestRingHealth} (worker thread), both guarded by
     * {@code lock}. Replaces a blind fixed-sleep loop - see that method's
     * own doc for why: a real successful Even sync (extracted from
     * {@code /tmp/btsnoop_fresh.log} on bazzite-desktop, 2026-09-11) is
     * response-paced, not sleep-paced, and ACKs each DATA page immediately
     * rather than after the whole run.
     */
    private boolean ringHealthRspSeen;
    /** Bumped once per decoded health DATA page (any type) so a waiter can
     * detect "a page just arrived" without polling ringHealthRecords. */
    private int ringHealthPageCounter;
    /**
     * elapsedRealtime() of the last time {@link #requestRingHealth()} was
     * attempted, or 0 if never. Health data updates hourly at the source
     * (heart rate/HRV/SpO2) or slower, but a ring reconnect can happen far
     * more often than that (BLE drops, Doze, app restarts - this evening's
     * own live testing saw reconnects every few seconds under load). Pulling
     * on every reconnect would be pure waste even ignoring the risk below;
     * given the race condition documented on requestRingHealth() - a request
     * that loses its race may silently discard real backlog rather than just
     * delay it - it is actively worse than waste, so this is throttled.
     */
    private long ringHealthLastRequestedAtMs;
    /**
     * Set by {@link #requestRingHealthNow()} from whatever thread the UI is on;
     * cleared by the worker loop, which is the only thread allowed to run the
     * pull. Guarded by {@code lock}.
     */
    private boolean ringHealthPullRequested;
    /**
     * Aborted-pull retries spent since the last pull that COMPLETED its
     * sequence. Guarded by {@code lock}. See
     * {@link #RING_HEALTH_ABORTED_RETRY_LIMIT}.
     */
    private int ringHealthAbortedRetries;
    private boolean sessionReady;
    private boolean fixedLayoutCreated;
    private boolean shutdownRequested;
    // CFW firmware-debug-flags overlay (mode 7). Desired value pushed from TS; the
    // sub-op last sent this session (-1 = not yet), reset on (re)connect so the
    // overlay state is re-asserted on every reconnect and whenever the value changes.
    private volatile boolean firmwareDebugFlagsEnabled;
    private int firmwareDebugFlagsLastSent = -1;
    // Desired CFW mode-10 compass state. It survives reconnects; lastSent is
    // reset with each session so an open Compass window is re-asserted.
    /**
     * Who currently wants the stock compass running (the Compass window, the
     * Navigate worker, ...). The magnetometer is one shared resource, so it
     * stays on while any owner holds it and is released when the last lets go;
     * this keeps one app's release from silently switching off another's feed.
     */
    private final java.util.Set<String> compassOwners = new java.util.HashSet<>();
    private int compassControlLastSent = -1;
    // Whether the glasses-side compass may still be running: set when an enable
    // is enqueued, cleared only when a disable is acked. Drives the forced
    // disable sent ahead of an EvenHub shutdown/suspend, since a pending
    // disable can be wiped by the shutdown's queue flush and the retry loop
    // does not run while shutdownRequested (magnetometer left on = battery drain).
    private boolean compassMaybeOn;
    private boolean startupProbePending;
    // Desired ownership of CFW's fail-open stock-wake lease (dashboard launch
    // and Even AI foreground takeover). This survives a transport reconnect;
    // the lease itself is volatile firmware state and is re-acquired once both
    // arms are ready.
    private boolean faceclawWakeLeaseEnabled;
    private long lastFaceclawWakeLeaseQueuedAtMs;
    private int faceclawWakeControlGeneration;
    private int faceclawWakeControlSentCount;
    private long lastFaceclawFramebufferLeaseQueuedAtMs;
    private int faceclawFramebufferControlGeneration;
    private int faceclawFramebufferControlSentCount;
    private int faceclawWakePendingNonce = -1;
    /**
     * The last firmware-info read said the glasses run Faceclaw's custom
     * firmware. Gates the private modes (cleanup, texture cache, ...) so stock
     * or third-party firmware never sees them; the TS side checks the actual
     * revision and disconnects on a mismatch, so no per-feature gating is
     * needed here.
     */
    private boolean customFirmwareDetected;
    private boolean cfwCleanupDelivered;
    private int lastCfwCleanupAckMagic;

    private long reconnectAfterMs;
    private long ringReconnectAfterMs;
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
    // Wire frame id for mode-3 deltas (CFW reorder/skip/dup diagnostic). uint16,
    // advanced by 1 per emitted delta; kept in [1, 0xfffe] to avoid the CFW's
    // 0xffff "empty" sentinel.
    private int nextImageFrameId = 1;
    private int lastShutdownAckMagic = 0;
    private long lastShutdownExitAtMs = 0;
    private int headsetBattery = -1;
    private int headsetCharging = -1;
    private int ringBattery = -1;
    private int ringCharging = -1;
    // Silent mode: 1 = on, 0 = off, -1 = not yet known. See updateSilentModeLocked.
    private int silentMode = -1;
    private int wearState = -1;
    private int phoneLockState = -1;
    private long lastPhoneLockCheckAtMs;
    private boolean phoneLockReceiverRegistered;
    private boolean audioCaptureActive;
    private boolean firmwareInfoQueried;
    // Glasses are in the charging case: nobody is wearing them, so display
    // communication pauses and only battery polls flow (see driveSession).
    private boolean chargingMode;
    private volatile FaceclawAudioPacketListener audioPacketListener;
    private PowerManager.WakeLock g2ScreenWakeLock;

    // BLE bandwidth benchmark (Developer app). Streams no-op image payloads
    // (CFW mode 7 with an unused sub-op: parsed, acked, and discarded — stock
    // firmware likewise ignores unknown image modes) for a fixed duration with
    // a selectable message size and pipeline window, then reports throughput.
    // While active, desired-frame sends are held back and heartbeats are
    // satisfied by the benchmark's own acks, so the stream is the only image
    // traffic. All state below is guarded by `lock`; results are read with
    // getBandwidthBenchmarkStatus() and survive until the next run starts.
    private boolean benchmarkActive;
    private boolean benchmarkAborted;
    private byte[] benchmarkPayload = new byte[0];
    private int benchmarkMessageSize;
    private int benchmarkWindowSize;
    private int benchmarkDurationMs;
    private int benchmarkLinkMode;
    private boolean benchmarkLinkPending;
    private long benchmarkReadyAtMs;
    private long benchmarkStartAtMs;     // first benchmark write; 0 until then
    private long benchmarkDeadlineAtMs;  // start + duration; MAX_VALUE until first write
    private long benchmarkLastAckAtMs;
    private long benchmarkEndAtMs;       // 0 while running; set when the run drains
    private int benchmarkMessagesSent;
    private int benchmarkMessagesAcked;
    private int benchmarkTimeouts;
    private long benchmarkPayloadBytesAcked;
    private long benchmarkWireBytesAcked;
    // A timed-out benchmark message aborts the run, but its already-in-flight
    // peers still time out one by one; keep the window comfortably below
    // MAX_CONSECUTIVE_ACK_TIMEOUTS so a dead run can't escalate into a
    // transport-failure reconnect all by itself.
    private static final int BENCHMARK_MAX_WINDOW = 6;

    private final BroadcastReceiver phoneLockReceiver = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) {
            emitPhoneLockStateIfChanged(true);
            interruptibleSleep.interrupt();
        }
    };

    private String displayedFingerprint = "";
    // The frame the firmware shadow will hold once the current image pipeline
    // drains: the most recently ENQUEUED image (headerless packed 4bpp, see
    // BmpUtil.pack4bppFromGray8), which is the correct base for the next delta
    // when frames are pipelined. Set at enqueue; cleared whenever the image
    // pipeline is cleared (clearAllMessagesLocked / clearMessagesOfKindLocked
    // "image"), so it is only ever read while it holds a valid current-session base.
    private byte[] lastEnqueuedPacked = new byte[0];
    private int lastEnqueuedWidth;
    private int lastEnqueuedHeight;
    private String lastEnqueuedFingerprint = "";
    private final Map<Integer, BleImageOptimizer.ImageUpdateStats> imageUpdateStats = new HashMap<>();

    private final Object desiredTilesLock = new Object();
    private String desiredFingerprint = "";
    // Headerless packed 4bpp frame (see BmpUtil.pack4bppFromGray8) plus its
    // pixel dimensions.
    private byte[] desiredPacked = new byte[0];
    private int desiredWidth;
    private int desiredHeight;
    private int desiredPaintMs;
    private int desiredFrameId;
    // Screen-space deferred draws (glyphs + images) whose pixels are baked
    // into desiredPacked; the texture-cache planner may replay them as
    // on-glasses cached draws.
    private SurfaceCompositor.ScreenDraw[] desiredDraws = new SurfaceCompositor.ScreenDraw[0];
    // (frame, reason) of the last "waiting to send" line, so a frame that
    // stalls for seconds records one line per state change (see
    // noteImageStallLocked). Send-loop thread only.
    private int stallFrameId;
    private String stallReason = "";
    // Highest compositor sequence stored as the desired frame; composites that
    // lost a store race to a newer one are discarded (their content is already
    // included in the newer composite).
    private long lastStoredCompositeSeq;

    private final SurfaceCompositor compositor = new SurfaceCompositor();

    // Phone-side model of the CFW's 64 KiB texture cache (modes 12/13/14).
    // Reset whenever the image pipeline / EvenHub session is torn down: the
    // firmware frees the cache with the fb lease, and after any resync the
    // cheap safe assumption is an empty cache (glyphs re-upload lazily).
    private final TextureCacheState textureCache = new TextureCacheState();

    private final ArrayDeque<OutboundMessage> pendingMessages = new ArrayDeque<>();
    private final ArrayDeque<OutboundMessage> inFlightMessages = new ArrayDeque<>();
    private OutboundMessage prewrittenMessage;
    private List<byte[]> prewrittenFrames = Collections.emptyList();

    public FaceclawBleCommunicator(Context context, String rightAddress, String leftAddress, String ringAddress) {
        this.appContext = context.getApplicationContext();
        FrameTimings.getInstance().init(appContext);
        this.powerManager = (PowerManager) appContext.getSystemService(Context.POWER_SERVICE);
        this.keyguardManager = (KeyguardManager) appContext.getSystemService(Context.KEYGUARD_SERVICE);
        this.bleManager = new FaceclawBleManager(appContext);
        this.bleManager.setListener(this);
        this.rightAddress = requireAddress("rightAddress", rightAddress);
        this.leftAddress = requireAddress("leftAddress", leftAddress);
        this.ringAddress = ringAddress == null ? "" : ringAddress.trim();
        IntentFilter phoneLockFilter = new IntentFilter();
        phoneLockFilter.addAction(Intent.ACTION_SCREEN_ON);
        phoneLockFilter.addAction(Intent.ACTION_SCREEN_OFF);
        phoneLockFilter.addAction(Intent.ACTION_USER_PRESENT);
        appContext.registerReceiver(phoneLockReceiver, phoneLockFilter);
        phoneLockReceiverRegistered = true;
    }


    public void setListener(FaceclawBleCommunicatorListener listener) {
        this.listener = listener;
        emitState();
        emitPhoneLockStateIfChanged(true);
    }

    public void start() {
        synchronized (lock) {
            if (running) {
                return;
            }
            running = true;
            userDisconnectRequested = false;
            reconnectHalted = false;
            shutdownRequested = false;
            activeInstance = this;
            workerThread = new Thread(this, "FaceclawBleCommunicator");
            workerThread.start();
        }
    }

    public void disconnect() {
        /* On the normal path DashboardController already sent mode 11 after
         * quiescing its producers. Also cover direct/early close callers here;
         * a successful cleanup must remain the final BLE message. Older CFWs
         * fall back to the standalone framebuffer-lease release. */
        if (!cfwCleanupDelivered && !sendCfwCleanup()) {
            releaseFaceclawFramebufferLease();
        }
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
            // Unknown until the next connection's first push or settings poll.
            silentMode = -1;
        }
        bleManager.disconnect(rightAddress);
        bleManager.disconnect(leftAddress);
        if (hasRingAddress()) {
            bleManager.disconnect(ringAddress);
        }
        bleManager.close();
        releaseG2ScreenWakeLock();
        setStateDisplay("disconnected", "Disconnected.");
    }

    public void close() {
        if (activeInstance == this) {
            activeInstance = null;
        }
        disconnect();
        if (phoneLockReceiverRegistered) {
            phoneLockReceiverRegistered = false;
            appContext.unregisterReceiver(phoneLockReceiver);
        }
    }

    public void setG2ScreenOn(boolean screenOn) {
        mainHandler.post(() -> updateG2ScreenWakeLock(screenOn));
    }

    public void setFirmwareDebugFlags(boolean enabled) {
        // Just record it; the drive loop emits the mode-7 control message when the
        // display path is ready and idle, and re-emits when this value changes.
        firmwareDebugFlagsEnabled = enabled;
    }

    public boolean startG2AudioCapture(FaceclawAudioPacketListener listener) {
        if (listener == null) {
            throw new IllegalArgumentException("listener is required");
        }
        int magic;
        synchronized (lock) {
            if (!running || !sessionReady || shutdownRequested || !fixedLayoutCreated) {
                logLine("skip G2 mic enable; EvenHub display path not ready");
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

    /**
     * Whether the glasses mic is enabled right now. The enable lives in the
     * current EvenHub session, so it dies with a transport drop, the charging
     * case, or a suspend — silently, from the phone's point of view. Callers
     * that track a capture across those events must check this rather than
     * assume their earlier enable still holds.
     */
    public boolean isAudioCaptureActive() {
        synchronized (lock) {
            return running && sessionReady && !shutdownRequested && audioCaptureActive;
        }
    }

    /**
     * Acquire/renew or release CFW's volatile wake-takeover lease on both
     * arms. Delivery (not a protocol ACK) is awaited so a caller can ensure
     * the fail-open firmware policy is installed before relying on wakeword
     * interception or suspending EvenHub.
     */
    public boolean setFaceclawWakeLeaseEnabled(boolean enabled) {
        int generation;
        synchronized (lock) {
            faceclawWakeLeaseEnabled = enabled;
            if (!running || !sessionReady) {
                return !enabled;
            }
            generation = enqueueFaceclawWakeControlLocked(
                enabled ? BleProtocol.FACECLAW_WAKE_OP_ACQUIRE : BleProtocol.FACECLAW_WAKE_OP_RELEASE,
                0,
                true
            );
            if (!enabled) {
                faceclawWakePendingNonce = -1;
            }
        }
        interruptibleSleep.interrupt();
        return waitForFaceclawWakeControlDelivery(generation, FACECLAW_WAKE_CONTROL_WAIT_MS);
    }

    /**
     * Wait until the recreated layout and retained compositor frame have both
     * landed. If this wake came from CFW's deferred double tap, READY
     * is then sent to both arms to cancel their stock-dashboard fallback.
     */
    public boolean awaitEvenHubSessionReady(int timeoutMs) {
        long deadline = SystemClock.elapsedRealtime() + Math.max(0, timeoutMs);
        int readyGeneration = 0;
        synchronized (lock) {
            while (running && sessionReady) {
                boolean frameReady = false;
                synchronized (desiredTilesLock) {
                    frameReady = !desiredFingerprint.isEmpty()
                        && desiredFingerprint.equals(displayedFingerprint);
                }
                if (!shutdownRequested && fixedLayoutCreated && frameReady) {
                    if (faceclawWakePendingNonce >= 0) {
                        readyGeneration = enqueueFaceclawWakeControlLocked(
                            BleProtocol.FACECLAW_WAKE_OP_READY,
                            faceclawWakePendingNonce,
                            true
                        );
                        faceclawWakePendingNonce = -1;
                    }
                    break;
                }
                long remaining = deadline - SystemClock.elapsedRealtime();
                if (remaining <= 0) {
                    return false;
                }
                try {
                    lock.wait(Math.min(remaining, 100));
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    return false;
                }
            }
            if (!running || !sessionReady) {
                return false;
            }
        }
        if (readyGeneration != 0) {
            interruptibleSleep.interrupt();
            if (!waitForFaceclawWakeControlDelivery(readyGeneration, FACECLAW_WAKE_CONTROL_WAIT_MS)) {
                logLine("wake READY delivery not confirmed before fallback deadline");
            }
        }
        return true;
    }

    /**
     * Enable or disable the IMU (accelerometer) report stream. Fire-and-forget:
     * the control message is queued ahead of other traffic; readings arrive via
     * registered FaceclawImuListeners. reportFrq is the requested sample rate
     * (ignored on disable).
     */
    public void setImuReportEnabled(boolean enable, int reportFrq) {
        synchronized (lock) {
            if (!running || !sessionReady) {
                logLine("skip IMU " + (enable ? "enable" : "disable") + "; session not ready");
                return;
            }
            clearMessagesOfKindLocked("imu-control");
            OutboundMessage message = messageBuilder.enableOrDisableImu(enable, reportFrq);
            message.onTimeout = () -> logLine("IMU control ack timeout");
            pendingMessages.addFirst(message);
            logLine("queue IMU " + (enable ? "enable freq=" + reportFrq : "disable"));
        }
        interruptibleSleep.interrupt();
    }

    /**
     * Enable/disable the stock compass through CFW image-handler mode 10. The
     * desired state is retained across reconnects; headings arrive through
     * stock sid-0x08 navigation notifications and FaceclawCompassListeners.
     */
    public void setCompassEnabled(boolean enable) {
        setCompassEnabled("compass", enable);
    }

    /**
     * As above, on behalf of a named owner. The compass runs while at least
     * one owner has enabled it; an owner disabling it only takes effect once
     * no other owner still wants it.
     */
    public void setCompassEnabled(String owner, boolean enable) {
        synchronized (lock) {
            boolean before = !compassOwners.isEmpty();
            if (enable) {
                compassOwners.add(owner);
            } else {
                compassOwners.remove(owner);
            }
            boolean wanted = !compassOwners.isEmpty();
            if (wanted == before && compassControlLastSent == (wanted ? 1 : 0)) {
                logLine("compass " + (enable ? "enable" : "disable") + " by " + owner
                    + "; state unchanged (owners=" + compassOwners + ")");
                return;
            }
            compassControlLastSent = -1;
            clearMessagesOfKindLocked("compass-control");
            if (running && sessionReady && !shutdownRequested && fixedLayoutCreated) {
                enqueueCompassControlLocked(true, wanted);
            } else {
                logLine("defer compass " + (enable ? "enable" : "disable") + "; display path not ready");
            }
        }
        interruptibleSleep.interrupt();
    }

    /**
     * Set the lens brightness. Fire-and-forget, like the IMU control: the
     * message is queued ahead of other traffic and any not-yet-sent brightness
     * message is superseded. When autoAdjust is true the ambient-light sensor
     * drives brightness and brightnessLevel is ignored; otherwise
     * brightnessLevel (0-100) is applied directly.
     */
    public void setBrightness(boolean autoAdjust, int brightnessLevel) {
        synchronized (lock) {
            if (!running || !sessionReady) {
                logLine("skip brightness set; session not ready");
                return;
            }
            clearMessagesOfKindLocked("brightness-control");
            OutboundMessage message = messageBuilder.setBrightness(autoAdjust, brightnessLevel);
            message.onTimeout = () -> logLine("brightness control ack timeout");
            pendingMessages.addFirst(message);
            logLine("queue brightness " + (autoAdjust ? "auto" : "level=" + brightnessLevel));
        }
        interruptibleSleep.interrupt();
    }

    /**
     * Enable the stock wear detector, then ask CFW to emit its current cached
     * state. The queue order matters: the query must run after the setting is
     * applied, including on a fresh install where wear detection was disabled.
     */
    public void enableWearDetectionAndRequestState() {
        synchronized (lock) {
            if (!running || !sessionReady) {
                logLine("skip wear detector setup; session not ready");
                return;
            }
            clearMessagesOfKindLocked("wear-detection-control");
            clearMessagesOfKindLocked("wear-query-control");
            OutboundMessage queryLeft = messageBuilder.faceclawWearQuery(true);
            OutboundMessage queryRight = messageBuilder.faceclawWearQuery(false);
            OutboundMessage enable = messageBuilder.setWearDetection(true);
            enable.onTimeout = () -> logLine("wear detection enable ack timeout");
            pendingMessages.addFirst(queryLeft);
            pendingMessages.addFirst(queryRight);
            pendingMessages.addFirst(enable);
            logLine("queue wear detection enable + current-state query");
        }
        interruptibleSleep.interrupt();
    }

    /**
     * Start the BLE bandwidth benchmark: stream messageSize-byte no-op image
     * payloads for durationMs, keeping up to windowSize messages awaiting ack
     * at once, then leave the results for getBandwidthBenchmarkStatus().
     * Returns false when a run is already active or the image path is not
     * ready. The duration clock starts at the first benchmark write, so
     * traffic already queued ahead of the run doesn't count against it.
     */
    public boolean startBandwidthBenchmark(int messageSize, int windowSize, int durationMs) {
        return startBandwidthBenchmarkWithLinkMode(messageSize, windowSize, durationMs, 0);
    }

    // 0: current link; 1: re-request HIGH; 2: request 2M; 3: both.
    public boolean startBandwidthBenchmarkWithLinkMode(int messageSize, int windowSize,
                                                       int durationMs, int linkMode) {
        synchronized (lock) {
            if (benchmarkActive || !running || !sessionReady || !fixedLayoutCreated
                    || shutdownRequested || chargingMode) {
                logLine("skip bandwidth benchmark; already running or image path not ready");
                return false;
            }
            byte[] payload = new byte[Math.max(2, Math.min(messageSize, ConnectionOptions.IMAGE_FRAGMENT_SIZE))];
            payload[0] = 7;             // CFW diagnostic-control mode...
            payload[1] = (byte) 0x7f;   // ...with an unused sub-op: acked, no effect
            benchmarkPayload = payload;
            benchmarkMessageSize = payload.length;
            benchmarkWindowSize = Math.max(1, Math.min(windowSize, BENCHMARK_MAX_WINDOW));
            benchmarkDurationMs = Math.max(1_000, durationMs);
            benchmarkLinkMode = linkMode & 3;
            benchmarkLinkPending = true;
            benchmarkReadyAtMs = Long.MAX_VALUE;
            benchmarkStartAtMs = 0;
            benchmarkDeadlineAtMs = Long.MAX_VALUE;
            benchmarkLastAckAtMs = 0;
            benchmarkEndAtMs = 0;
            benchmarkMessagesSent = 0;
            benchmarkMessagesAcked = 0;
            benchmarkTimeouts = 0;
            benchmarkPayloadBytesAcked = 0;
            benchmarkWireBytesAcked = 0;
            benchmarkAborted = false;
            benchmarkActive = true;
            logLine("bandwidth benchmark start: size=" + benchmarkMessageSize
                + "B window=" + benchmarkWindowSize + " duration=" + benchmarkDurationMs
                + "ms linkMode=" + benchmarkLinkMode);
        }
        interruptibleSleep.interrupt();
        return true;
    }

    /**
     * Cancel an in-progress benchmark (benchmark page closed). Queued no-op
     * messages are dropped; in-flight ones drain through their normal acks.
     */
    public void cancelBandwidthBenchmark() {
        synchronized (lock) {
            if (!benchmarkActive) {
                return;
            }
            clearMessagesOfKindLocked("bandwidth");
            finishBenchmarkLocked(true, "cancelled");
        }
        interruptibleSleep.interrupt();
    }

    /** Status/results of the current or most recent benchmark run, as JSON. */
    public String getBandwidthBenchmarkStatus() {
        synchronized (lock) {
            String state = benchmarkActive
                ? (benchmarkStartAtMs == 0 ? "starting" : "running")
                : (benchmarkEndAtMs != 0 ? "done" : "idle");
            long end = benchmarkActive ? SystemClock.elapsedRealtime() : benchmarkEndAtMs;
            long elapsed = benchmarkStartAtMs == 0 ? 0 : Math.max(0, end - benchmarkStartAtMs);
            try {
                org.json.JSONObject status = new org.json.JSONObject();
                status.put("state", state);
                status.put("messageSize", benchmarkMessageSize);
                status.put("windowSize", benchmarkWindowSize);
                status.put("linkMode", benchmarkLinkMode);
                status.put("elapsedMs", elapsed);
                status.put("messagesSent", benchmarkMessagesSent);
                status.put("messagesAcked", benchmarkMessagesAcked);
                status.put("timeouts", benchmarkTimeouts);
                status.put("payloadBytesAcked", benchmarkPayloadBytesAcked);
                status.put("wireBytesAcked", benchmarkWireBytesAcked);
                status.put("aborted", benchmarkAborted);
                return status.toString();
            } catch (org.json.JSONException e) {
                return "{\"state\":\"idle\"}";
            }
        }
    }

    /** Pending + in-flight benchmark no-op messages. */
    private int benchmarkOutstandingLocked() {
        int count = 0;
        for (OutboundMessage message : pendingMessages) {
            if ("bandwidth".equals(message.kind)) count++;
        }
        for (OutboundMessage message : inFlightMessages) {
            if ("bandwidth".equals(message.kind)) count++;
        }
        return count;
    }

    /**
     * Keep the benchmark stream fed: top the pending queue up so the send
     * window never starves, stop enqueueing once the run expires (or a message
     * times out), and finish the run when the last outstanding message drains.
     */
    private void maintainBenchmarkLocked(long now) {
        if (!sessionReady || !fixedLayoutCreated || shutdownRequested) {
            finishBenchmarkLocked(true, "session no longer ready");
            return;
        }
        if (benchmarkLinkPending || now < benchmarkReadyAtMs) {
            return;
        }
        if (benchmarkAborted || now >= benchmarkDeadlineAtMs) {
            // The run is over: drop queued-but-unsent no-ops (sending them
            // would stretch the run past its deadline) and finish once the
            // in-flight tail has acked or timed out.
            Iterator<OutboundMessage> pendingIterator = pendingMessages.iterator();
            while (pendingIterator.hasNext()) {
                OutboundMessage queued = pendingIterator.next();
                if ("bandwidth".equals(queued.kind)) {
                    pendingIterator.remove();
                    magicPool.release(queued.sid, queued.magic, queued.label, "benchmark over");
                }
            }
            if (benchmarkOutstandingLocked() == 0) {
                finishBenchmarkLocked(false, "complete");
            }
            return;
        }
        // One more than the window so a fresh message is always ready to write
        // the moment an ack frees a slot.
        for (int outstanding = benchmarkOutstandingLocked(); outstanding <= benchmarkWindowSize; outstanding++) {
            enqueueBenchmarkMessageLocked();
        }
    }

    private void finishBenchmarkLocked(boolean aborted, String reason) {
        if (!benchmarkActive) {
            return;
        }
        benchmarkActive = false;
        benchmarkAborted |= aborted;
        // Prefer the last ack as the end time so drain lag after the deadline
        // doesn't dilute the throughput figure.
        benchmarkEndAtMs = benchmarkLastAckAtMs != 0 ? benchmarkLastAckAtMs : SystemClock.elapsedRealtime();
        logLine("bandwidth benchmark " + (benchmarkAborted ? "aborted" : "finished") + " (" + reason + "): "
            + benchmarkMessagesAcked + "/" + benchmarkMessagesSent + " acked, "
            + benchmarkPayloadBytesAcked + "B payload, " + benchmarkTimeouts + " timeouts");
    }

    private void enqueueBenchmarkMessageLocked() {
        OutboundMessage message = messageBuilder.imagePayload(
            "bandwidth",
            DASHBOARD_TILE,
            nextMapSessionId(),
            benchmarkPayload,
            "bandwidth no-op " + benchmarkPayload.length + "B",
            connectionOptions.sendImagesToLeft);
        final int payloadBytes = benchmarkPayload.length;
        // Protobuf-wrapped message bytes; the `aa 21` envelope adds a few more
        // per MTU-sized BLE frame, which this figure does not include.
        final int wireBytes = message.message.length;
        message.onSent = () -> {
            benchmarkMessagesSent++;
            if (benchmarkStartAtMs == 0) {
                benchmarkStartAtMs = SystemClock.elapsedRealtime();
                benchmarkDeadlineAtMs = benchmarkStartAtMs + benchmarkDurationMs;
            }
        };
        message.onAck = () -> {
            long ackedAtMs = SystemClock.elapsedRealtime();
            benchmarkMessagesAcked++;
            benchmarkPayloadBytesAcked += payloadBytes;
            benchmarkWireBytesAcked += wireBytes;
            benchmarkLastAckAtMs = ackedAtMs;
            // No-op payloads ride the image path, so the firmware resets its
            // heartbeat timer on them just like real image messages.
            lastHeartbeatAckedAtMs = ackedAtMs;
        };
        message.onTimeout = () -> {
            benchmarkTimeouts++;
            benchmarkAborted = true;
            logLine("bandwidth benchmark ack timeout");
        };
        pendingMessages.addLast(message);
    }

    public void addImuListener(FaceclawImuListener listener) {
        if (listener != null) {
            imuListeners.add(listener);
        }
    }

    public void removeImuListener(FaceclawImuListener listener) {
        if (listener != null) {
            imuListeners.remove(listener);
        }
    }

    public void addAmbientLightListener(FaceclawAmbientLightListener listener) {
        if (listener != null) {
            ambientLightListeners.add(listener);
        }
    }

    public void removeAmbientLightListener(FaceclawAmbientLightListener listener) {
        if (listener != null) {
            ambientLightListeners.remove(listener);
        }
    }

    private void emitAmbientLight(byte[] body) {
        if (ambientLightListeners.isEmpty()) {
            return;
        }
        byte[] copy = java.util.Arrays.copyOf(body, body.length);
        mainHandler.post(() -> {
            for (FaceclawAmbientLightListener alsListener : ambientLightListeners) {
                try {
                    alsListener.onAmbientLight(copy);
                } catch (Throwable t) {
                    Log.w(TAG, "ambient light listener failed", t);
                }
            }
        });
    }

    /** Request one CFW ambient-light report (image-handler mode 16 op 0). */
    public void queryAmbientLight() {
        synchronized (lock) {
            enqueueAmbientLightControlLocked(new byte[] { (byte) 16, (byte) 0 }, "als query", false);
        }
        interruptibleSleep.interrupt();
    }

    /**
     * Start or stop CFW passive light-sensor polling (image-handler mode 16
     * ops 1/2). While polling, the firmware reads its OPT3001 every intervalMs
     * (clamped 100..5000 by the firmware), never steps the panel brightness
     * itself, and pushes a field-105 report when the reading moved by at least
     * minDelta or heartbeatMs elapsed. bindToLease stops polling automatically
     * when the Faceclaw framebuffer lease is released or lapses. Starting is
     * idempotent and re-opens the sensor if the stock firmware closed it.
     */
    public void setAmbientLightPolling(boolean enable, int intervalMs, int minDelta,
                                       int heartbeatMs, boolean bindToLease) {
        byte[] payload = enable
            ? new byte[] {
                (byte) 16,
                (byte) 1,
                (byte) (bindToLease ? 1 : 0),
                (byte) (intervalMs & 0xff),
                (byte) ((intervalMs >> 8) & 0xff),
                (byte) (minDelta & 0xff),
                (byte) ((minDelta >> 8) & 0xff),
                (byte) (heartbeatMs & 0xff),
                (byte) ((heartbeatMs >> 8) & 0xff),
            }
            : new byte[] { (byte) 16, (byte) 2 };
        synchronized (lock) {
            clearMessagesOfKindLocked("als-control");
            enqueueAmbientLightControlLocked(payload, "als polling " + (enable ? "start" : "stop"), true);
        }
        interruptibleSleep.interrupt();
    }

    private void enqueueAmbientLightControlLocked(byte[] payload, String label, boolean priority) {
        if (!running || !sessionReady || shutdownRequested || !fixedLayoutCreated) {
            logLine("skip " + label + "; display path not ready");
            return;
        }
        OutboundMessage message = messageBuilder.imagePayload(
            "als-control",
            DASHBOARD_TILE,
            nextMapSessionId(),
            payload,
            label,
            connectionOptions.sendImagesToLeft);
        message.onTimeout = () -> logLine(label + " ack timeout");
        if (priority) pendingMessages.addFirst(message);
        else pendingMessages.addLast(message);
        logLine("queue " + label);
    }

    public void addMicStatusListener(FaceclawMicStatusListener listener) {
        if (listener != null) {
            micStatusListeners.add(listener);
        }
    }

    public void removeMicStatusListener(FaceclawMicStatusListener listener) {
        if (listener != null) {
            micStatusListeners.remove(listener);
        }
    }

    private void emitMicStatus(byte[] body, String address) {
        if (micStatusListeners.isEmpty()) {
            return;
        }
        String arm = address.equalsIgnoreCase(leftAddress) ? "L"
            : address.equalsIgnoreCase(rightAddress) ? "R" : "?";
        byte[] copy = java.util.Arrays.copyOf(body, body.length);
        mainHandler.post(() -> {
            for (FaceclawMicStatusListener micListener : micStatusListeners) {
                try {
                    micListener.onMicStatus(copy, arm);
                } catch (Throwable t) {
                    Log.w(TAG, "mic status listener failed", t);
                }
            }
        });
    }

    /**
     * Queue a CFW mic_control record (['M','C',ver,op,...]) as a settings
     * field-103 write to both temples, or to a single one. Fire-and-forget:
     * the firmware answers with a field-104 status notify per temple, which
     * arrives through addMicStatusListener.
     */
    public void sendFaceclawMicControl(byte[] record, String label, boolean rightTemple, boolean leftTemple) {
        if (record == null || record.length < 4) {
            return;
        }
        synchronized (lock) {
            if (!running || !sessionReady) {
                logLine("skip mic control (" + label + "); session not ready");
                return;
            }
            if (rightTemple) {
                pendingMessages.addLast(messageBuilder.faceclawMicControl(record, label, false));
            }
            if (leftTemple) {
                pendingMessages.addLast(messageBuilder.faceclawMicControl(record, label, true));
            }
            logLine("queue mic control " + label);
        }
        interruptibleSleep.interrupt();
    }

    /**
     * Forward render-characteristic audio packets to the listener WITHOUT
     * sending the stock EvenHub audio-control enable. Used for the CFW
     * mic_control streaming path, where capture is armed through settings
     * field 103 and the temples emit 'SM' frames on the same characteristic
     * that stock mono LC3 uses. Returns false when no session is up.
     */
    public boolean startG2AudioForwarding(FaceclawAudioPacketListener listener) {
        if (listener == null) {
            throw new IllegalArgumentException("listener is required");
        }
        synchronized (lock) {
            if (!running || !sessionReady || shutdownRequested) {
                logLine("skip G2 audio forwarding; session not ready");
                return false;
            }
            audioPacketListener = listener;
            audioCaptureActive = true;
            logLine("G2 audio forwarding enabled");
        }
        return true;
    }

    public void stopG2AudioForwarding() {
        synchronized (lock) {
            audioPacketListener = null;
            audioCaptureActive = false;
            logLine("G2 audio forwarding disabled");
        }
    }

    /**
     * Subscribe to compass events. Callbacks are delivered on the Looper of
     * the thread that registered (falling back to the main thread), so app
     * worker isolates can listen without a cross-thread hop into their JS.
     */
    public void addCompassListener(FaceclawCompassListener listener) {
        if (listener == null) {
            return;
        }
        Looper looper = Looper.myLooper();
        Handler handler = looper != null ? new Handler(looper) : mainHandler;
        compassSubscriptions.add(new CompassSubscription(listener, handler));
    }

    public void removeCompassListener(FaceclawCompassListener listener) {
        if (listener == null) {
            return;
        }
        for (CompassSubscription subscription : compassSubscriptions) {
            if (subscription.listener == listener) {
                compassSubscriptions.remove(subscription);
            }
        }
    }


    // The most recently started communicator; lets app worker threads submit
    // surface frames without holding a cross-isolate reference to the bridge
    // object (JS wrappers do not cross isolates, but the Java instance does).
    private static volatile FaceclawBleCommunicator activeInstance;

    public static FaceclawBleCommunicator getActive() {
        return activeInstance;
    }

    /** Set the compositor's output frame size. Call before configuring surfaces. */
    public void configureCompositorScreen(int width, int height) {
        compositor.configureScreen(width, height);
    }

    /**
     * The current composited screen as a phone-UI preview bitmap, or null
     * before any surface has been configured. Built from the compositor so
     * the preview reflects every surface (chrome + whichever app is
     * foreground), including worker-app frames the TS side never sees.
     */
    public android.graphics.Bitmap getCompositePreviewBitmap(double brightenGamma) {
        return getCompositePreviewBitmap(brightenGamma, false);
    }

    /** As above; `green` renders the preview green-on-black (Settings > Phone display > Preview color). */
    public android.graphics.Bitmap getCompositePreviewBitmap(double brightenGamma, boolean green) {
        SurfaceCompositor.Composite composite = compositor.previewComposite();
        if (composite == null) {
            return null;
        }
        return PreviewBitmapUtil.fromGray(
                java.nio.ByteBuffer.wrap(composite.gray), composite.width, composite.height, brightenGamma, green);
    }

    /** Save the current composite as a 4-bit grayscale PNG; returns the path or "". */
    public String saveCompositePngScreenshot() throws java.io.IOException {
        SurfaceCompositor.Composite composite = compositor.previewComposite();
        if (composite == null) {
            return "";
        }
        return ScreenshotUtil.savePngScreenshot(appContext, composite.gray, composite.width, composite.height);
    }

    /**
     * Save the current composite cropped to the given screen rect (the region
     * the shell says is actually occupied). The rect is clamped to the screen;
     * a degenerate rect falls back to the full screen.
     */
    public String saveCompositePngScreenshot(int cropX, int cropY, int cropWidth, int cropHeight)
            throws java.io.IOException {
        SurfaceCompositor.Composite composite = compositor.previewComposite();
        if (composite == null) {
            return "";
        }
        int x = Math.max(0, cropX);
        int y = Math.max(0, cropY);
        int width = Math.min(composite.width - x, cropWidth - (x - cropX));
        int height = Math.min(composite.height - y, cropHeight - (y - cropY));
        if (width <= 0 || height <= 0 || (x == 0 && y == 0 && width == composite.width && height == composite.height)) {
            return ScreenshotUtil.savePngScreenshot(appContext, composite.gray, composite.width, composite.height);
        }
        byte[] cropped = new byte[width * height];
        for (int row = 0; row < height; row++) {
            System.arraycopy(composite.gray, (y + row) * composite.width + x, cropped, row * width, width);
        }
        return ScreenshotUtil.savePngScreenshot(appContext, cropped, width, height);
    }

    // Active animated-GIF screen recording, or null when idle. Frames are
    // pushed by recordScreenFrame(), which the TS side calls at each
    // phone-preview flush.
    private volatile GifScreenRecorder screenRecorder;

    /** Begin collecting composite frames for an animated-GIF screen recording. */
    public void startScreenRecording() {
        screenRecorder = new GifScreenRecorder();
    }

    /** Capture the current composite into the active recording; no-op when idle. */
    public void recordScreenFrame() {
        GifScreenRecorder recorder = screenRecorder;
        if (recorder == null) {
            return;
        }
        SurfaceCompositor.Composite composite = compositor.previewComposite();
        if (composite == null) {
            return;
        }
        recorder.addFrame(composite.gray, composite.width, composite.height, System.currentTimeMillis());
    }

    /** Finish the recording and save it as an animated GIF; returns the path or "". */
    public String stopScreenRecording() throws java.io.IOException {
        GifScreenRecorder recorder = screenRecorder;
        screenRecorder = null;
        if (recorder == null) {
            return "";
        }
        if (recorder.isOverflowed()) {
            logLine("screen recording hit its frame cap; the tail was dropped");
        }
        return recorder.save(appContext);
    }

    /**
     * Show or hide a compositor surface, immediately submitting the resulting
     * frame. Recompositing here (rather than waiting for the next surface
     * update) is what makes a just-foregrounded window's retained frame
     * actually appear — otherwise a static window (e.g. the terminal hub) whose
     * frame landed while briefly hidden would stay blank until its next repaint.
     */
    public void setSurfaceVisible(String id, boolean visible) {
        // Its own frame: this recomposite is a real screen update with real
        // latency, and without one it would show up in other frames' logs only
        // as an anonymous "superseded by frame#0".
        int frameId = FrameTimings.getInstance().startFrame(
                "compositor:visible " + id + "=" + visible);
        compositor.setSurfaceVisible(id, visible);
        SurfaceCompositor.Composite composite = compositor.composite();
        byte[] packed = BmpUtil.pack4bppFromGray8(composite.gray, composite.width, composite.height);
        storeDesiredComposite(composite, packed, 0, frameId);
    }

    /**
     * Blank (screen off) or unblank the composited output, immediately
     * submitting the resulting frame. Retained surface state is untouched, so
     * unblanking restores the previous screen content without repaints.
     */
    public void setScreenBlanked(boolean blanked) {
        int frameId = FrameTimings.getInstance().startFrame(
                "compositor:" + (blanked ? "blank" : "unblank"));
        compositor.setBlanked(blanked);
        SurfaceCompositor.Composite composite = compositor.composite();
        byte[] packed = BmpUtil.pack4bppFromGray8(composite.gray, composite.width, composite.height);
        storeDesiredComposite(composite, packed, 0, frameId);
    }

    /**
     * Create or reconfigure a compositor surface. transparency is one of the
     * SurfaceCompositor.TRANSPARENCY_* constants. Geometry changes take effect
     * when the next frame is submitted.
     */
    public void configureSurface(String id, int x, int y, int width, int height, int zOrder, int transparency) {
        compositor.configureSurface(id, x, y, width, height, zOrder, transparency);
    }

    public void removeSurface(String id) {
        compositor.removeSurface(id);
    }

    /**
     * Dim every surface below zOrder belowZOrder to factor256/256 (see
     * SurfaceCompositor.setUnderlayDim). Takes effect with the next submitted
     * frame: the shell always submits its own surface right after changing
     * this, so no recomposite happens here.
     */
    public void setUnderlayDim(int belowZOrder, int factor256) {
        compositor.setUnderlayDim(belowZOrder, factor256);
    }

    /**
     * Apply an update to one compositor surface and submit the recomposited
     * screen as the desired frame. The update covers the rect (rectX, rectY,
     * rectWidth, rectHeight) in surface-local coordinates; contentFingerprint
     * identifies the surface's full content after the update.
     *
     * pixels8bpp arrives as a ByteBuffer because NativeScript marshals a JS
     * ArrayBuffer to one without the per-element bridge copy that a byte[]
     * parameter would need (~150ms for a full frame).
     */
    public void submitSurfaceFrame(
            java.nio.ByteBuffer pixels8bpp,
            String surfaceId,
            int rectX,
            int rectY,
            int rectWidth,
            int rectHeight,
            String contentFingerprint,
            int paintMs,
            int frameId
    ) {
        submitSurfaceFrame(pixels8bpp, surfaceId, rectX, rectY, rectWidth, rectHeight,
                contentFingerprint, paintMs, frameId, null);
    }

    /**
     * As above, with the frame's glyph draws (see SurfaceCompositor's glyph
     * overload for the buffer format): the surface's full text content as
     * structured draws, letting the texture-cache planner ship glyphs as
     * on-glasses cached draws instead of pixels. Null when the submitter has
     * no glyph metadata; the pixels alone remain fully correct.
     */
    public void submitSurfaceFrame(
            java.nio.ByteBuffer pixels8bpp,
            String surfaceId,
            int rectX,
            int rectY,
            int rectWidth,
            int rectHeight,
            String contentFingerprint,
            int paintMs,
            int frameId,
            java.nio.ByteBuffer glyphs
    ) {
        Log.i(TAG, "Received an updated frame for surface " + surfaceId);
        FrameTimings.getInstance().log(frameId, "surface " + surfaceId + " updated rect="
                + rectWidth + "x" + rectHeight + "+" + rectX + "+" + rectY
                + (glyphs == null ? " (no glyph draws)" : ""));
        FrameTimings.getInstance().spanStart(frameId, "composite");
        SurfaceCompositor.Composite composite = compositor.applyAndComposite(
                surfaceId, pixels8bpp, rectX, rectY, rectWidth, rectHeight, contentFingerprint, glyphs);
        FrameTimings.getInstance().spanEnd(frameId, "composite");
        // Pack the composited 8bpp buffer down to the headerless 4bpp frame
        // format the wire planners consume; BMP framing is added later only for
        // the uncompressed fallback.
        FrameTimings.getInstance().spanStart(frameId, "pack-4bpp");
        byte[] packed = BmpUtil.pack4bppFromGray8(composite.gray, composite.width, composite.height);
        FrameTimings.getInstance().spanEnd(frameId, "pack-4bpp");
        storeDesiredComposite(composite, packed, paintMs, frameId);
    }

    /** Store a composite as the desired frame unless a newer one won the race. */
    private void storeDesiredComposite(SurfaceCompositor.Composite composite, byte[] packed, int paintMs, int frameId) {
        int supersededFrameId = 0;
        boolean stale = false;
        synchronized (desiredTilesLock) {
            if (composite.seq <= lastStoredCompositeSeq) {
                // A concurrent submission composited after us and stored first;
                // its composite already includes this surface update.
                stale = true;
            } else {
                lastStoredCompositeSeq = composite.seq;
                supersededFrameId = desiredFrameId;
                desiredPacked = packed;
                desiredWidth = composite.width;
                desiredHeight = composite.height;
                desiredFingerprint = composite.fingerprint;
                desiredPaintMs = paintMs;
                desiredFrameId = frameId;
                desiredDraws = composite.draws;
            }
        }
        if (stale) {
            finishFrame(frameId, "discarded: composite superseded before store");
            return;
        }
        if (supersededFrameId != 0 && supersededFrameId != frameId) {
            finishFrame(supersededFrameId, "discarded: superseded by frame#" + frameId + " before send");
        }
        FrameTimings.getInstance().log(frameId, "image submitted as desired frame");
        interruptibleSleep.interrupt();
    }

    /**
     * Play a tone sequence via CFW load_image_z mode 5 kind 4. The payload is
     * the complete wire buffer ([5][4][nSteps][freqLo,freqHi,duty,msLo,msHi]*n,
     * up to 48 steps), built on the TS side; it rides the arbitrary-payload
     * image path like the other mode-5 controls.
     */
    public void playBuzzerSequence(java.nio.ByteBuffer payload) {
        synchronized (lock) {
            if (!running || !sessionReady || !fixedLayoutCreated) {
                logLine("skip buzzer sequence; session not ready");
                return;
            }
            byte[] bytes = new byte[payload == null ? 0 : payload.remaining()];
            if (payload != null) {
                payload.get(bytes);
            }
            if (bytes.length < 3) {
                logLine("skip buzzer sequence; empty payload");
                return;
            }
            OutboundMessage message = messageBuilder.imagePayload(
                DASHBOARD_TILE,
                nextMapSessionId(),
                bytes,
                "buzzer sequence " + bytes.length + "B",
                connectionOptions.sendImagesToLeft
            );
            message.onTimeout = () -> {
                handleTransportFailure("buzzer sequence ack timeout");
            };
            pendingMessages.addLast(message);
            logLine("queue " + message.label);
        }
        interruptibleSleep.interrupt();
    }

    public boolean sendShutdown(int exitMode) {
        return sendShutdownInternal(exitMode, true);
    }

    /**
     * Send CFW image-handler mode 11 after quiescing normal traffic. A successful
     * return means the cleanup was ACKed and no later Faceclaw message should be
     * emitted before closing BLE. Unsupported/older CFWs return false so callers
     * can use the legacy shutdown-and-lease-release path.
     */
    public boolean sendCfwCleanup() {
        int magic;
        synchronized (lock) {
            if (cfwCleanupDelivered) {
                return true;
            }
            if (!customFirmwareDetected || !running || !sessionReady
                    || shutdownRequested || !fixedLayoutCreated) {
                logLine("skip CFW cleanup; mode 11 unavailable or image path not ready");
                return false;
            }

            /* Stop auto-renewals, heartbeats, image generation, and control
             * retries, then discard everything that has not reached BLE yet. */
            shutdownRequested = true;
            lastCfwCleanupAckMagic = 0;
            clearPendingMessagesLocked("CFW cleanup requested");
            logLine("quiescing transport for CFW cleanup");
        }
        interruptibleSleep.interrupt();

        /* WINDOW_SIZE can exceed one, so merely appending cleanup would allow it
         * to overlap previously-written image fragments. Wait until all of those
         * ACK or time out; shutdownRequested prevents the drive loop from adding
         * any fresh automatic traffic meanwhile. */
        long drainDeadline = SystemClock.elapsedRealtime() + CFW_CLEANUP_WAIT_MS;
        synchronized (lock) {
            while (running && sessionReady && !inFlightMessages.isEmpty()) {
                long remaining = drainDeadline - SystemClock.elapsedRealtime();
                if (remaining <= 0) break;
                try {
                    lock.wait(Math.min(remaining, 100));
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    break;
                }
            }
            if (!running || !sessionReady || !inFlightMessages.isEmpty()) {
                shutdownRequested = false;
                logLine("CFW cleanup could not drain prior traffic");
                return false;
            }

            /* External producers are expected to be stopped by the caller, but
             * clear once more at the barrier so cleanup is definitely last. */
            clearPendingMessagesLocked("CFW cleanup barrier");
            OutboundMessage message = messageBuilder.cfwCleanup(
                DASHBOARD_TILE,
                nextMapSessionId(),
                connectionOptions.sendImagesToLeft
            );
            magic = message.magic;
            message.onAck = () -> {
                lastCfwCleanupAckMagic = message.magic;
                cfwCleanupDelivered = true;
                compassMaybeOn = false;
                faceclawWakeLeaseEnabled = false;
                logLine("CFW cleanup completed");
            };
            message.onTimeout = () -> logLine("CFW cleanup ack timeout");
            pendingMessages.addLast(message);
            logLine("queue CFW cleanup");
        }
        interruptibleSleep.interrupt();

        long deadline = SystemClock.elapsedRealtime() + CFW_CLEANUP_WAIT_MS;
        synchronized (lock) {
            while (running
                    && sessionReady
                    && lastCfwCleanupAckMagic != magic
                    && hasPendingOrInflightMagicLocked(magic)) {
                long remaining = deadline - SystemClock.elapsedRealtime();
                if (remaining <= 0) break;
                try {
                    lock.wait(Math.min(remaining, 100));
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    break;
                }
            }
            boolean acked = lastCfwCleanupAckMagic == magic;
            if (!acked) shutdownRequested = false;
            return acked;
        }
    }

    /**
     * End the EvenHub page while retaining both arm GATT connections and all
     * notification subscriptions. A missed ACK is intentionally non-fatal:
     * reconnecting Bluetooth here would defeat the power-saving mode.
     */
    public boolean suspendEvenHubSession() {
        // Ending the plugin task releases the fb lease, which frees the
        // on-glasses texture cache; forget it phone-side either way (a lost
        // ack may still have taken effect).
        synchronized (lock) {
            textureCache.reset();
        }
        if (sendShutdownInternal(0, false)) {
            return true;
        }
        synchronized (lock) {
            // A shutdown ACK can be lost even though the command took effect.
            // If the transport remains intentionally quiesced, callers still
            // need to remember to run the resume path on the next wake.
            return running && sessionReady && shutdownRequested;
        }
    }

    /**
     * Start a fresh EvenHub plugin task on the existing BLE transport, then let
     * the session driver create the layout, warm up the image path, and send
     * the desired frame.
     */
    public boolean resumeEvenHubSession() {
        int claimGeneration = 0;
        synchronized (lock) {
            if (!running || !sessionReady || chargingMode) {
                logLine("skip EvenHub resume; transport not ready");
                return false;
            }
            if (!shutdownRequested) {
                return true;
            }
            if (faceclawWakePendingNonce >= 0
                    && hasPendingOrInflightKindLocked("wake-lease-control")) {
                claimGeneration = faceclawWakeControlGeneration;
            }
            logLine("replaying session prelude for EvenHub resume");
        }

        // A custom double-tap wake has only a short unclaimed fail-open
        // deadline. Let the worker put CLAIM on both arms before the direct
        // prelude write begins.
        if (claimGeneration != 0) {
            waitForFaceclawWakeControlDelivery(claimGeneration, 500);
        }

        try {
            // Empty-name Cmd=9 tears down the whole plugin task, not just its
            // image container. Re-run the launch prelude before Cmd=0 CREATE.
            sendPrelude(true);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            handleTransportFailure("EvenHub resume prelude interrupted");
            return false;
        } catch (Throwable t) {
            logLine("EvenHub resume prelude failed: " + safeMessage(t));
            handleTransportFailure("EvenHub resume prelude failed");
            return false;
        }

        synchronized (lock) {
            if (!running || !sessionReady || chargingMode) {
                return false;
            }
            shutdownRequested = false;
            fixedLayoutCreated = false;
            startupProbePending = false;
            audioCaptureActive = false;
            clearAllMessagesPreservingWakeLeaseLocked("EvenHub resume");
            displayedFingerprint = "";
            imageRetryAfterMs = 0;
            lastHeartbeatSentAtMs = 0;
            lastHeartbeatAckedAtMs = 0;
            logLine("EvenHub session resume requested");
        }
        interruptibleSleep.interrupt();
        return true;
    }

    private boolean sendShutdownInternal(int exitMode, boolean reconnectOnTimeout) {
        int magic;
        long startedAtMs = SystemClock.elapsedRealtime();
        synchronized (lock) {
            if (!running || !sessionReady) {
                logLine("skip shutdown; session not ready");
                return false;
            }
            if (shutdownRequested) {
                return true;
            }
            shutdownRequested = true;
            // Magic values wrap, so an ACK from a much older suspend must not
            // satisfy this request after enough sleep/wake cycles.
            lastShutdownAckMagic = 0;
            clearPendingMessagesLocked("shutdown requested");
            OutboundMessage message = messageBuilder.shutdown(exitMode);
            magic = message.magic;
            message.onAck = () -> {
                lastShutdownAckMagic = message.magic;
                fixedLayoutCreated = false;
                displayedFingerprint = "";
            };
            message.onTimeout = () -> {
                if (reconnectOnTimeout) {
                    handleTransportFailure("shutdown ack timeout");
                } else {
                    logLine("EvenHub shutdown ack timeout; keeping BLE connected");
                }
            };
            pendingMessages.addFirst(message);
            logLine("queue shutdown");
            // The stock compass keeps the magnetometer sampling independently of
            // the plugin task, so ending the page does not stop it. Force a
            // disable ahead of the shutdown command whenever it may be running:
            // this also covers a disable that was wiped by the queue flush above
            // or whose ack was lost, and the charging-mode/exit paths where the
            // Compass window never got a chance to release it.
            if (compassMaybeOn && fixedLayoutCreated) {
                enqueueCompassControlLocked(true, false);
            }
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


    @Override public void run() {
        logLine(String.format(Locale.US, "communicator start R=%s L=%s ring=%s", rightAddress, leftAddress, ringAddress));
        while (true) {
            try {
                if (!running) {
                    Log.w(TAG, "Exiting event looop");
                    break;
                }
                emitPhoneLockStateIfChanged(false);
                if (!sessionReady) {
                    if (reconnectHalted) {
                        interruptibleSleep.sleep(ConnectionOptions.IDLE_SLEEP_MS);
                        continue;
                    }
                    long now = SystemClock.elapsedRealtime();
                    if (now < reconnectAfterMs) {
                        interruptibleSleep.sleep(Math.min(ConnectionOptions.IDLE_SLEEP_MS, reconnectAfterMs - now));
                        continue;
                    }
                    Log.w(TAG, "Attempting to connect");
                    connectLoopOnce();
                    continue;
                }

                if (shouldAttemptRingConnect()) {
                    tryConnectRing("retry");
                    continue;
                }

                // Page ACKs queued from the GATT callback thread are written
                // here, on the only thread allowed to block on a GATT write.
                flushRingOutbound();

                // An on-demand pull asked for from the UI thread runs here for
                // the same reason: requestRingHealth() blocks on GATT writes and
                // on its own RSP/DATA waits, which only this thread may do.
                runRequestedRingHealthPull();
                // An aborted pull is unfinished business, not a speculative
                // repeat - see RING_HEALTH_ABORTED_RETRY_LIMIT. Cheap: returns
                // immediately unless a pull actually failed to complete.
                resumeAbortedRingHealthPull();

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

    @Override public void onNotification(String address, String characteristicUuid, byte[] data) {
        if (address == null || characteristicUuid == null || data == null) {
            return;
        }
        String uuid = characteristicUuid.toLowerCase(Locale.US);
        if (isDirectRingNotification(address, uuid)) {
            handleDirectRingNotification(uuid, data);
            return;
        }
        if (BleProtocol.RENDER_NOTIFY_UUID.equals(uuid)) {
            handleRenderNotification(address, data);
            return;
        }
        if (!BleProtocol.NOTIFY_CHAR_UUID.equals(uuid)) {
            return;
        }
        Log.d(TAG, "onNotification: address=" + address + " characteristicUuid=" + characteristicUuid + " data.length=" + data.length);
        BleProtocol.ParsedFrame frame = BleProtocol.parseFrame(data);
        int decodedWearState = BleProtocol.parseWearState(frame);
        BleProtocol.CompassEvent compassEvent = address.equalsIgnoreCase(rightAddress)
            ? BleProtocol.parseCompassEvent(frame)
            : null;
        boolean emitWearState = false;
        G2Event event = null;
        synchronized (lock) {
            lastIncomingAtMs = SystemClock.elapsedRealtime();
            if (decodedWearState >= 0 && decodedWearState != wearState) {
                wearState = decodedWearState;
                emitWearState = true;
            }
            boolean faceclawWakeNotification = false;
            if (shutdownRequested
                    && frame.ok
                    && frame.sid == BleProtocol.SID_UI_SETTING
                    && address.equalsIgnoreCase(rightAddress)) {
                int wakeNonce = BleProtocol.parseFaceclawWakeEvent(frame.pb);
                if (wakeNonce >= 0) {
                    faceclawWakePendingNonce = wakeNonce;
                    enqueueFaceclawWakeControlLocked(
                        BleProtocol.FACECLAW_WAKE_OP_CLAIM,
                        wakeNonce,
                        true
                    );
                    faceclawWakeNotification = true;
                    lastConnectionOrInputAtMs = lastIncomingAtMs;
                    // The event type says which gesture woke the glasses: TS
                    // gives a head-up the Glanceboard and a double tap the
                    // regular UI. The claim handshake is the same for both.
                    boolean headUp = BleProtocol.parseFaceclawWakeEventCode(frame.pb)
                        == BleProtocol.FACECLAW_WAKE_EVENT_HEAD_UP;
                    event = new G2Event(
                        "display-wake",
                        "",
                        headUp ? BleProtocol.EVENT_HEAD_UP : BleProtocol.EVENT_DOUBLE_CLICK,
                        0,
                        0
                    );
                    logLine("claimed deferred dashboard wake nonce=" + wakeNonce
                        + (headUp ? " (head-up)" : ""));
                }
            }
            if (!faceclawWakeNotification
                    && shutdownRequested
                    && frame.ok
                    && frame.sid == BleProtocol.SID_UI_SETTING
                    && address.equalsIgnoreCase(rightAddress)) {
                // CFW idle-gesture forwarding (firmware revision 2+): with no
                // EvenHub page the stock display thread drops taps, long
                // presses and releases; the CFW reports them on the settings
                // sid while our wake lease is held. Deliver them as the
                // sys-events a live page would have produced, so TS treats a
                // sleep-time tap or hold exactly like one during soft sleep
                // (the Glanceboard).
                BleProtocol.FaceclawGestureEvent gesture = BleProtocol.parseFaceclawGestureEvent(frame.pb);
                if (gesture != null) {
                    lastConnectionOrInputAtMs = lastIncomingAtMs;
                    event = new G2Event("sys-event", "", gesture.eventType, gesture.eventSource, 0);
                    logLine("idle gesture forwarded by CFW: type=" + gesture.eventType
                        + " source=" + gesture.eventSource);
                }
            }
            if (!faceclawWakeNotification
                    && event == null
                    && shutdownRequested
                    && address.equalsIgnoreCase(rightAddress)
                    && BleProtocol.isDisplayWakeStateChange(frame)) {
                // With no EvenHub page, ring/arm double-taps are handled by the
                // stock display lifecycle and surface only as this state ping.
                // Translate it back into an input event so TS can wake the shell
                // and recreate the page.
                event = new G2Event(
                    "display-wake",
                    "",
                    BleProtocol.EVENT_DOUBLE_CLICK,
                    0,
                    0
                );
            }
            if (!faceclawWakeNotification
                    && frame.ok
                    && frame.sid == BleProtocol.SID_UI_SETTING) {
                // Mode-17 query notifications; settings READs are handled by
                // createBatteryQueryMessageLocked so headset/ring update together.
                if (address.equalsIgnoreCase(rightAddress)
                        && (frame.flag == BleProtocol.FLAG_NOTIFY || frame.flag == BleProtocol.FLAG_NOTIFY_ALT)) {
                    BleProtocol.RingBatterySnapshot ring = BleProtocol.parseRingBattery(frame.pb);
                    if (ring != null) {
                        ringBattery = ring.battery;
                        ringCharging = ring.charging;
                        emitBatteryState(headsetBattery, headsetCharging);
                    }
                }
                // CFW mic status (field 104) rides both standalone pushes and
                // settings read acks, from each temple on its own link.
                byte[] micStatus = BleProtocol.parseFaceclawMicStatus(frame.pb);
                if (micStatus != null) {
                    emitMicStatus(micStatus, address);
                }
            }
            if (!faceclawWakeNotification
                    && frame.ok
                    && frame.sid == BleProtocol.SID_UI_SETTING) {
                // CFW ambient-light report (field 105) from the master temple.
                byte[] alsReport = BleProtocol.parseFaceclawAlsReport(frame.pb);
                if (alsReport != null) {
                    emitAmbientLight(alsReport);
                }
            }
            if (!faceclawWakeNotification
                    && decodedWearState < 0
                    && frame.ok
                    && frame.sid == BleProtocol.SID_UI_SETTING) {
                // Device-initiated settings push. It carries a magic the glasses
                // chose, so it would otherwise fall through to resolveAckLocked,
                // match nothing, and be logged as an unexpected ack.
                int pushedSilentMode = BleProtocol.parseSilentModePush(frame.pb);
                if (pushedSilentMode >= 0) {
                    updateSilentModeLocked(pushedSilentMode > 0);
                    return;
                }
            }
            if (!faceclawWakeNotification
                    && decodedWearState < 0
                    && frame.ok
                    && frame.msgSeq >= 0
                    && frame.flag != BleProtocol.FLAG_NOTIFY
                    && frame.flag != BleProtocol.FLAG_NOTIFY_ALT) {
                lastAckAtMs = lastIncomingAtMs;
                resolveAckLocked(frame.sid, frame.msgSeq, frame.pb);
            }
            if (!faceclawWakeNotification
                    && event == null
                    && frame.ok
                    && address.equalsIgnoreCase(rightAddress)
                    && (frame.flag == BleProtocol.FLAG_NOTIFY || frame.flag == BleProtocol.FLAG_NOTIFY_ALT)) {
                event = G2Event.decode(frame);
                if (event != null
                        && "sys-event".equals(event.kind)
                        && event.eventType == BleProtocol.EVENT_HEAD_UP) {
                    // CFW forwards the IMU head-up while our page is on screen
                    // (soft sleep). Surface it as the same wake-only input the
                    // deferred head-up wake produces from a dark display.
                    event = new G2Event("display-wake", "", BleProtocol.EVENT_HEAD_UP, event.eventSource, 0);
                    logLine("head-up forwarded by CFW while page on screen");
                }
                if (event != null) {
                    // Pure IMU samples arrive continuously; don't let them count
                    // as user input (which would starve battery polling).
                    boolean pureImuSample = "sys-event".equals(event.kind)
                        && event.eventType == BleProtocol.EVENT_IMU_DATA_REPORT;
                    if (!pureImuSample) {
                        lastConnectionOrInputAtMs = lastIncomingAtMs;
                    }
                    if ("list-click".equals(event.kind) || "text-click".equals(event.kind)) {
                        // Container-routed touchpad input reached us, so the
                        // firmware is dispatching input: silent mode is off,
                        // whether or not its end-of-silent push arrived.
                        updateSilentModeLocked(false);
                    }
                    if ("sys-event".equals(event.kind)) {
                        if (event.eventType == BleProtocol.EVENT_FOREGROUND_EXIT || event.eventType == BleProtocol.EVENT_ABNORMAL_EXIT || event.eventType == BleProtocol.EVENT_SYSTEM_EXIT) {
                            if (shutdownRequested) {
                                lastShutdownExitAtMs = SystemClock.elapsedRealtime();
                            }
                            fixedLayoutCreated = false;
                            displayedFingerprint = "";
                            clearAllMessagesLocked("firmware exit event");
                        }
                    }
                }
            }
        }
        interruptibleSleep.interrupt();
        if (emitWearState) {
            logLine(decodedWearState > 0 ? "wear state ON_HEAD" : "wear state OFF_HEAD");
            emitWearState(decodedWearState > 0);
        }
        if (compassEvent != null) {
            emitCompassEvent(compassEvent);
        }
        if (event != null) {
            if (event.hasImu) {
                emitImuData(event.imuX, event.imuY, event.imuZ, event.eventSource);
            }
            // A standalone IMU_DATA_REPORT is a sensor sample, not a gesture:
            // deliver it only to IMU listeners, skipping the input pipeline (and
            // its per-frame latency bookkeeping) to avoid flooding it.
            boolean pureImuSample = "sys-event".equals(event.kind)
                && event.eventType == BleProtocol.EVENT_IMU_DATA_REPORT;
            if (!pureImuSample) {
                int frameId = FrameTimings.getInstance().startFrame(
                    "input:" + event.kind + " type=" + event.eventType + " src=" + event.eventSource);
                FrameTimings.getInstance().log(frameId, "input event decoded from BLE notification");
                emitRingEvent(event.kind, event.containerName, event.eventType, event.eventSource, event.systemExitReasonCode, frameId);
            }
        }
    }

    private void handleDirectRingNotification(String characteristicUuid, byte[] data) {
        if (handleRingHealthNotification(characteristicUuid, data)) {
            return;
        }
        FaceclawRingEventDecoder.DirectRingEvent decoded = FaceclawRingEventDecoder.decode(data);
        if (decoded == null) {
            Log.d(TAG, "direct ring notify ignored: characteristicUuid=" + characteristicUuid + " raw=" + hex(data));
            return;
        }

        G2Event event = decoded.event;
        long arrivalMs = SystemClock.elapsedRealtime();
        synchronized (lock) {
            lastIncomingAtMs = arrivalMs;
            lastConnectionOrInputAtMs = arrivalMs;
        }
        logLine("direct ring " + decoded.label + " " + decoded.detail + " raw=" + hex(data));
        int frameId = FrameTimings.getInstance().startFrame("input:ring:" + decoded.label);
        FrameTimings.getInstance().log(frameId, "input event decoded from direct ring notification");
        emitRingEvent(event.kind, event.containerName, event.eventType, event.eventSource, event.systemExitReasonCode, frameId);
        interruptibleSleep.interrupt();
    }

    /**
     * The R1 health-data protocol branch. Returns true when the value belonged
     * to that protocol and must not fall through to the gesture decoder.
     *
     * <p>Runs on the GATT callback thread, so it only ever queues writes.
     *
     * <p>Restricted to R1_NOTIFY_CHAR_UUID because that is the notify
     * characteristic (ATT handle 0x0017) the reference capture shows this
     * protocol on; gesture traffic on the other notify characteristic is left
     * strictly alone rather than being offered to the reassembler.
     */
    private boolean handleRingHealthNotification(String characteristicUuid, byte[] data) {
        if (!BleProtocol.R1_NOTIFY_CHAR_UUID.equals(characteristicUuid)) {
            return false;
        }

        RingProtocol.Intake intake;
        synchronized (lock) {
            intake = ringReassembler.accept(data);
        }
        if (!intake.consumed) {
            return false;
        }

        long arrivalMs = SystemClock.elapsedRealtime();
        synchronized (lock) {
            lastIncomingAtMs = arrivalMs;
        }
        if (intake.note != null) {
            logLine("ring frame: " + intake.note);
        }
        RingProtocol.Frame frame = intake.frame;
        if (frame == null) {
            // Genuinely silent by default: the reassembler consumed these
            // bytes (e.g. as a fragment awaiting its continuation) without
            // yet producing a complete frame, and intake.note was null too.
            // This exact blind spot cost real debugging time on 2026-09-10 -
            // DATA appeared to simply never arrive, when the actual cause
            // (once found, by temporarily logging every raw notification
            // unconditionally) was a real handshake gap, not a dropped
            // frame here. If DATA ever looks like it's going missing again
            // with nothing logged at all, re-add that raw hex dump here
            // rather than assuming nothing arrived on the wire.
            logLine("ring frame: consumed, no complete frame yet, len=" + data.length);
            return true;
        }
        if (!frame.crcOk) {
            // Never act on a frame whose CRC failed: the payload offsets below
            // are only meaningful for an intact frame.
            logLine("ring frame CRC mismatch " + frame.describe());
            return true;
        }

        // Route on the CHAN byte, not on the shape of the payload.
        if (frame.chan != RingProtocol.CHAN_HEALTH) {
            Log.d(TAG, "ring device frame " + frame.describe());
            return true;
        }

        if (frame.kind == RingProtocol.KIND_RSP) {
            Log.d(TAG, "ring health rsp " + frame.describe());
            synchronized (lock) {
                ringHealthRspSeen = true;
                lock.notifyAll();
            }
            return true;
        }
        if (frame.kind != RingProtocol.KIND_DATA) {
            Log.d(TAG, "ring health frame " + frame.describe());
            return true;
        }

        RingProtocol.HealthRecord record = null;
        try {
            record = RingProtocol.decode(frame, System.currentTimeMillis());
        } catch (Throwable t) {
            logLine("ring health decode error " + frame.describe() + ": " + safeMessage(t));
        }
        if (record == null) {
            logLine("ring health page undecoded " + frame.describe());
        } else {
            synchronized (lock) {
                if (ringHealthRecords.size() >= RING_HEALTH_MAX_RECORDS) {
                    // This was silent. An eviction here drops a record that
                    // nothing has ingested yet - real data lost inside the
                    // phone, with no trace anywhere. Say so. With the consume
                    // path in place the buffer should never reach this size;
                    // if this line ever appears, the consumer has stopped.
                    logLine("ring health: buffer FULL at " + RING_HEALTH_MAX_RECORDS
                        + " - dropping the oldest UNINGESTED record");
                    ringHealthRecords.remove(0);
                }
                ringHealthRecords.add(record);
                ringHealthTotalAdded++;
            }
            logLine("ring health " + record.summary());
        }

        // Acknowledge the page regardless of whether we could decode it: the
        // ACK is what keeps the ring sending, and a decode gap must not stall
        // the rest of the transfer.
        queueRingPageAck(frame);
        return true;
    }

    private void queueRingPageAck(RingProtocol.Frame page) {
        byte[] ack;
        synchronized (lock) {
            if (!ringNotificationsReady) {
                return;
            }
            ack = RingProtocol.buildPageAck(
                nextRingSeqLocked(),
                nextRingNonceLocked(),
                page.cmdHi,
                page.cmdLo,
                page.seq
            );
            ringOutbound.add(ack);
            ringHealthPageCounter++;
            lock.notifyAll();
        }
        // The worker loop does the actual write; wake it so the ACK is not held
        // for a whole idle tick.
        interruptibleSleep.interrupt();
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

    @Override public void onConnectionStateChange(String address, boolean connected) {
        synchronized (lock) {
            if (address == null) {
                return;
            }
            if (isConfiguredRingAddress(address)) {
                ringConnected = connected;
                ringNotificationsReady = false;
                if (!connected) {
                    ringReconnectAfterMs = SystemClock.elapsedRealtime() + ConnectionOptions.RING_RECONNECT_DELAY_MS;
                    // Half-received fragments and unsent ACKs do not survive the
                    // link; the sequence counter restarts on the next connect.
                    ringReassembler.reset();
                    ringOutbound.clear();
                }
                logLine(connected ? "direct ring BLE connected" : "direct ring BLE disconnected");
                return;
            }
            if (address.equalsIgnoreCase(rightAddress)) {
                rightConnected = connected;
            } else if (address.equalsIgnoreCase(leftAddress)) {
                leftConnected = connected;
            } else {
                return;
            }
            if (!connected) {
                sessionReady = false;
                fixedLayoutCreated = false;
                startupProbePending = false;
                chargingMode = false;
                audioCaptureActive = false;
                audioPacketListener = null;
                clearAllMessagesLocked("connection lost");
                displayedFingerprint = "";
                if (!reconnectHalted) {
                    reconnectAfterMs = SystemClock.elapsedRealtime() + ConnectionOptions.RECONNECT_DELAY_MS;
                }
            }
        }
        interruptibleSleep.interrupt();
        if (connected) {
            setStateDisplay("connected", "Connected.");
        } else if (!reconnectHalted) {
            // While parked on a missing bond, keep the "unpaired" display: this
            // callback is just the teardown of the arm that did connect.
            setStateDisplay("connecting", "Connecting to the glasses...");
        }
    }

    private void connectLoopOnce() throws InterruptedException {
        setStateDisplay("connecting", "Connecting to the glasses...");
        try {
            connectArm(rightAddress, true);
            connectArm(leftAddress, true);
            if (!sleepDuringConnectSettling(800)) {
                return;
            }
            authenticateArms();
            sendPrelude();

            synchronized (lock) {
                sessionReady = true;
                // A fresh transport prelude always starts an active EvenHub
                // lifecycle, even if the previous connection dropped while
                // its page was intentionally suspended.
                shutdownRequested = false;
                fixedLayoutCreated = false;
                clearAllMessagesLocked("session ready");
                displayedFingerprint = "";
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
                faceclawWakePendingNonce = -1;
                cfwCleanupDelivered = false;
                lastCfwCleanupAckMagic = 0;
                lastFaceclawWakeLeaseQueuedAtMs = 0;
                lastFaceclawFramebufferLeaseQueuedAtMs = 0;
                enqueueFaceclawFramebufferControlLocked(
                    BleProtocol.FACECLAW_FB_OP_ACQUIRE,
                    true
                );
                if (faceclawWakeLeaseEnabled) {
                    enqueueFaceclawWakeControlLocked(
                        BleProtocol.FACECLAW_WAKE_OP_ACQUIRE,
                        0,
                        true
                    );
                }
            }
            setStateDisplay("connected", "Connected.");
            logLine("session ready");
            synchronized (lock) {
                // Query settings promptly on the first session so firmware
                // version/extension (and battery) arrive without waiting for
                // the input-quiet battery poll. The settings response doubles as
                // the firmware-compatibility check surfaced during onboarding.
                if (!firmwareInfoQueried) {
                    firmwareInfoQueried = true;
                    lastBatteryRefreshAtMs = SystemClock.elapsedRealtime();
                    pendingMessages.addLast(createBatteryQueryMessageLocked());
                    logLine("queue settings query for firmware info");
                }
            }
            tryConnectRing("initial");
        } catch (Throwable t) {
            logLine("connect failed: " + safeMessage(t));
            String unpairedArm = firstUnpairedArm();
            if (unpairedArm != null) {
                handleUnpairedFailure(unpairedArm);
            } else {
                handleTransportFailure("connect failed");
            }
        }
    }

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

    private boolean shouldAttemptRingConnect() {
        if (!hasRingAddress()) {
            return false;
        }
        long now = SystemClock.elapsedRealtime();
        synchronized (lock) {
            return running
                && sessionReady
                && !ringNotificationsReady
                && now >= ringReconnectAfterMs
                && pendingMessages.isEmpty()
                && inFlightMessages.isEmpty();
        }
    }

    private void tryConnectRing(String reason) {
        if (!hasRingAddress()) {
            return;
        }
        try {
            connectRing();
        } catch (Throwable t) {
            synchronized (lock) {
                ringConnected = false;
                ringNotificationsReady = false;
                ringReconnectAfterMs = SystemClock.elapsedRealtime() + ConnectionOptions.RING_RECONNECT_DELAY_MS;
            }
            logLine("direct ring connect failed (" + reason + "): " + safeMessage(t));
        }
    }

    private void connectRing() {
        logLine("connecting direct ring " + ringAddress);
        // autoConnect=true (see FaceclawBleManager.connect's 3-arg overload) -
        // matches what Even's own app does for this device specifically.
        // Direct connect (false, the default used for the glasses) was
        // measured tonight dying ~5s into an otherwise-idle ring connection,
        // repeatedly, with nothing else competing for it.
        if (!bleManager.connect(ringAddress, ConnectionOptions.RING_CONNECT_TIMEOUT_MS, true)) {
            throw new IllegalStateException("connect failed: " + ringAddress);
        }

        // Deliberately NOT requesting CONNECTION_PRIORITY_HIGH here (2026-09-11).
        // Even's own app never requests any priority for the ring at all - it
        // logs no requestConnectionPriority/onConnectionUpdated call anywhere -
        // and just runs on whatever Android's default (BALANCED) parameters are.
        // HIGH negotiated interval=12 (15ms) / timeout=500 (5000ms) here, and a
        // live test tonight found the ring-only connection reliably dying at
        // 5.5-5.7s, matching that 5000ms supervision timeout almost exactly,
        // on every attempt, with nothing else competing for the ring. If the
        // ring's firmware occasionally needs more than 5s of headroom after a
        // burst of writes, HIGH priority's short timeout would kill the link
        // while Even's default (longer) one wouldn't - untested but the timing
        // match is exact, not approximate. Leaving default priority for the
        // ring only; the glasses' own HIGH-priority request above is untouched.
        bleManager.requestMtu(ringAddress, ConnectionOptions.RING_DESIRED_MTU, ConnectionOptions.CONNECT_TIMEOUT_MS);

        if (!bleManager.discoverServices(ringAddress, ConnectionOptions.SERVICES_TIMEOUT_MS)) {
            throw new IllegalStateException("discoverServices failed: " + ringAddress);
        }

        // Even's app subscribes only to the health-data notify CCCD (ATT
        // handle 24) and never touches the phone-notify one (handle 19). That
        // difference was briefly suspected on 2026-09-11 of causing the ring's
        // total silence and this call was dropped to match - it changed
        // nothing, and the real cause turned out to be the malformed 00:08
        // frame (see sendRingHandshake). Restored, because the phone-notify
        // channel is plausibly what carries ring-as-remote gesture events,
        // which are a daily-driver feature; matching Even byte-for-byte here
        // buys nothing and risks breaking them.
        boolean phoneNotify = enableRingNotification(BleProtocol.R1_PHONE_NOTIFY_CHAR_UUID);
        boolean dataNotify = enableRingNotification(BleProtocol.R1_NOTIFY_CHAR_UUID);
        if (!phoneNotify && !dataNotify) {
            throw new IllegalStateException("no R1 notify characteristic subscribed");
        }

        synchronized (lock) {
            ringConnected = true;
            ringNotificationsReady = true;
            ringReconnectAfterMs = 0;
            // The ring's sequence counter restarts with the connection.
            ringSeq = 0;
            ringNonce = 0;
            ringReassembler.reset();
            ringOutbound.clear();
        }
        logLine("direct ring ready phoneNotify=" + phoneNotify + " dataNotify=" + dataNotify);

        if (dataNotify) {
            // The handshake mirrors what Even's own app repeats on every one
            // of its sync bursts (confirmed in the reference capture), so
            // sending it on every reconnect matches known-working behavior.
            // The actual health pull is throttled separately below - see
            // ringHealthLastRequestedAtMs and requestRingHealth()'s own
            // race-condition warning for why.
            sendRingHandshake();
            long now = SystemClock.elapsedRealtime();
            boolean dueForHealthPull;
            synchronized (lock) {
                dueForHealthPull = ringHealthPullDueLocked(now);
                if (dueForHealthPull) {
                    ringHealthLastRequestedAtMs = now;
                }
            }
            if (dueForHealthPull) {
                runRingHealthPull();
            } else {
                logLine("ring health: pull skipped, last one was "
                    + ((now - ringHealthLastRequestedAtMs) / 1000) + "s ago");
            }
        }
    }

    /**
     * Floor between health pulls, independent of how often the ring
     * reconnects. Heart rate/HRV/SpO2 update hourly at the source and steps
     * every 10 minutes (confirmed from the real export,
     * {@code knowledge/inbox/Even_health_data/}); 30 minutes is comfortably
     * inside that cadence while keeping reconnect churn from turning into
     * repeated pull attempts against the race condition documented on
     * {@link #requestRingHealth()}. Not tuned against any real constraint
     * from the ring itself - just a sane default.
     *
     * <p><b>Reduced 30min -> 5min on 2026-09-12, and its JOB CHANGED.</b> The
     * 30-minute figure was always meant as a CADENCE - how often to collect -
     * but it was implemented here as a floor, which is a different thing. The
     * result was that a connected, stable ring pulled <em>never</em>: nothing
     * drives a pull on a timer, only {@code onRingReady()} on reconnect, so the
     * floor was the only clock in the system and it gated a pull that had
     * nothing to trigger it.
     *
     * <p>The cadence now lives where it belongs, on a wall-clock-aligned tick
     * (:01 and :31) in {@code health-live.ts}. What remains here is purely an
     * ANTI-SPAM floor: stop a burst of reconnects turning into a burst of
     * requests against the race documented on {@link #requestRingHealth()}.
     * That job needs 5 minutes, not 30.
     */
    private static final long RING_HEALTH_MIN_PULL_INTERVAL_MS = 5L * 60L * 1000L;

    /**
     * Floor for a pull the user actually asked for by opening the health app,
     * as opposed to the automatic one above.
     *
     * <p>Deliberately much shorter than the automatic interval but <b>not
     * zero</b>. The 30-minute figure is conservative because an automatic pull
     * is speculative — nobody is waiting for it, so there is no reason to spend
     * a request. Opening the health app is the opposite: it is an explicit ask,
     * and the response-driven {@link #requestRingHealth()} now waits for each
     * type's DATA and ACKs its pages before advancing, which is what made the
     * backlog-discard race survivable in the first place. A floor still has to
     * exist, because the discard risk documented on {@code requestRingHealth()}
     * is real and open/close/open would otherwise hammer the ring.
     */
    private static final long RING_HEALTH_ON_DEMAND_MIN_INTERVAL_MS = 60L * 1000L;

    /**
     * How many times a pull that ABORTED may be resumed inside the anti-spam
     * floor before it goes back to waiting that floor out.
     *
     * <p>The floor exists to stop SPECULATIVE repeat pulls, because a request
     * that loses its race can permanently consume backlog - see
     * {@link #requestRingHealth()}. Resuming a pull that never got a single
     * answer is a different thing: nothing was ever in flight to be lost.
     *
     * <p>Measured 2026-09-12: the 09:33 pull got {@code no RSP} for 0x1, 0x4
     * and 0x2 and then died on {@code write error: IllegalStateException: Not
     * connected}. Every attempt after it was refused by the 30-minute floor, so
     * the rest of that night's data was simply never requested again - the
     * night's second sleep block went with it. The floor was protecting against
     * the wrong thing.
     *
     * <p>Bounded and non-looping on purpose: the budget is spent whether or not
     * the retries help, and a pull that completes resets it. Worst case is two
     * extra attempts, then silence until the floor expires.
     *
     * <p>⚠ UNTESTED, and worth knowing before trusting this: whether an aborted
     * pull's data is still on the ring at all, or was discarded when the ring
     * RSP'd (it did not RSP here, which is the reason to think it survives).
     * Nobody knows. The retry costs little if the data is gone.
     */
    private static final int RING_HEALTH_ABORTED_RETRY_LIMIT = 2;

    /**
     * Gap before an aborted pull may be resumed. Short, but not zero - a link
     * that just failed a write needs time to come back, and a tight loop
     * against a dead connection helps nobody.
     */
    private static final long RING_HEALTH_ABORTED_RETRY_GAP_MS = 60L * 1000L;

    /**
     * Ask for a health pull as soon as the worker thread can run one. Safe to
     * call from any thread; returns immediately without blocking.
     *
     * <p>Called when the health app opens, so a glance shows something current
     * rather than whatever the last automatic pull happened to catch. Subject
     * to {@link #RING_HEALTH_ON_DEMAND_MIN_INTERVAL_MS}; a request inside that
     * window is dropped rather than queued, because a stale duplicate pull has
     * no value and every pull carries the discard risk.
     */
    public void requestRingHealthNow() {
        synchronized (lock) {
            ringHealthPullRequested = true;
        }
        interruptibleSleep.interrupt();
    }

    /**
     * Whether an automatic pull may run now. Caller must hold {@code lock}.
     *
     * <p>Two ways to be due: the ordinary 30-minute floor has expired, or the
     * last pull ABORTED and still has retry budget. The second is not a
     * speculative repeat - see {@link #RING_HEALTH_ABORTED_RETRY_LIMIT}.
     */
    private boolean ringHealthPullDueLocked(long now) {
        if (ringHealthLastRequestedAtMs == 0) {
            return true;
        }
        long since = now - ringHealthLastRequestedAtMs;
        if (since >= RING_HEALTH_MIN_PULL_INTERVAL_MS) {
            return true;
        }
        return ringHealthAbortedRetries > 0 && since >= RING_HEALTH_ABORTED_RETRY_GAP_MS;
    }

    /**
     * Run a pull and account for whether it finished. The ONLY place
     * {@link #requestRingHealth()} may be called from, so that every path
     * shares one definition of "aborted".
     */
    private void runRingHealthPull() {
        boolean completed = requestRingHealth();
        synchronized (lock) {
            if (completed) {
                ringHealthAbortedRetries = 0;
            } else if (ringHealthAbortedRetries < RING_HEALTH_ABORTED_RETRY_LIMIT) {
                ringHealthAbortedRetries++;
                logLine("ring health: aborted pull may resume in "
                    + (RING_HEALTH_ABORTED_RETRY_GAP_MS / 1000L) + "s (retry "
                    + ringHealthAbortedRetries + "/" + RING_HEALTH_ABORTED_RETRY_LIMIT + ")");
            } else {
                ringHealthAbortedRetries = 0;
                logLine("ring health: aborted pull retry budget spent, back to the "
                    + (RING_HEALTH_MIN_PULL_INTERVAL_MS / 60000L) + "-minute anti-spam floor");
            }
        }
    }

    /**
     * Worker-thread tick that resumes a pull which ABORTED.
     *
     * <p>Distinct from {@link #runRequestedRingHealthPull()}: nobody asked for
     * this one. It exists because the automatic pull otherwise only fires from
     * the ring-ready path, so an abort that is not followed by a reconnect
     * would never be retried at all.
     */
    private void resumeAbortedRingHealthPull() {
        long now = SystemClock.elapsedRealtime();
        synchronized (lock) {
            if (ringHealthAbortedRetries == 0) {
                return;
            }
            if (!ringConnected || !ringNotificationsReady) {
                return;
            }
            if (now - ringHealthLastRequestedAtMs < RING_HEALTH_ABORTED_RETRY_GAP_MS) {
                return;
            }
            ringHealthLastRequestedAtMs = now;
        }
        logLine("ring health: resuming an aborted pull");
        runRingHealthPull();
    }

    /** Worker-thread side of {@link #requestRingHealthNow()}. */
    private void runRequestedRingHealthPull() {
        long now = SystemClock.elapsedRealtime();
        synchronized (lock) {
            if (!ringHealthPullRequested) {
                return;
            }
            ringHealthPullRequested = false;
            if (!ringConnected || !ringNotificationsReady) {
                logLine("ring health: on-demand pull skipped, ring not ready");
                return;
            }
            if (ringHealthLastRequestedAtMs != 0
                    && now - ringHealthLastRequestedAtMs < RING_HEALTH_ON_DEMAND_MIN_INTERVAL_MS) {
                logLine("ring health: on-demand pull skipped, last one was "
                    + ((now - ringHealthLastRequestedAtMs) / 1000) + "s ago");
                return;
            }
            ringHealthLastRequestedAtMs = now;
        }
        logLine("ring health: on-demand pull requested");
        runRingHealthPull();
    }

    /**
     * Device-channel prelude the ring requires before it will answer any
     * channel-0x02 (health) request. <b>Confirmed live, 2026-09-10: without
     * this, the ring never responds at all to a bare health REQ - not even
     * an RSP.</b> With it, RSPs start flowing immediately. The direct-ring
     * path has no other handshake or auth step, so this is the whole gate.
     *
     * <p>These five frames were found by byte-for-byte comparison against a
     * real Even-app sync (pkt 8814-9153 in the capture behind
     * {@code knowledge/staging/faceclaw-ring-protocol-decode-return.md}),
     * replayed here in the same order, right after the ring connects.
     * <b>Which of the five is actually load-bearing is unknown</b> - all
     * five go out together because that combination is the only one proven
     * to work; nobody has yet tried removing any of them. Three of them
     * (00:08, 06:02, 00:0A) carry payload bytes with no known meaning beyond
     * "the ring accepted them from Even's app" - opaque constants, copied
     * verbatim, not derived. Do not change them without new evidence.
     *
     * <p>The other two (00:0E clock-set, 00:05 day-anchor) need a live
     * value: both carry the current Unix time offset by the local UTC offset,
     * which in EDT is +14400s (4h) - and +14400s is what a real Even write
     * carries. Verified 2026-09-11 against six separate real Even clock-set
     * writes. As of 2026-09-12 the offset is COMPUTED from the device time
     * zone rather than hardcoded, which is identical in EDT and stays correct
     * across a DST change; see the comment in {@code sendRingHandshake()}.
     *
     * <p><b>Skew trap - read before "correcting" this number.</b> Earlier on
     * 2026-09-11 this was changed to +28800s (8h) and that was wrong. The
     * mistake: btsnoop packet timestamps on this phone run exactly 4 hours
     * BEHIND the Android system clock (the system clock itself is correct -
     * {@code adb shell date} agrees with real time). Measuring Even's sent
     * value against the btsnoop timestamp therefore double-counts the 4h and
     * makes a correct +14400 look like +28800. The skew is verified
     * sub-second by lining btsnoop up against logcat on the same connect:
     * logcat "direct ring BLE connected" 05:58:24.616 vs btsnoop MTU Req
     * 01:58:24.618; "ring ready" .983 vs CCCD Write Rsp .981; "handshake
     * sent" 25.085 vs first Write Command 25.071. Same milliseconds, hour
     * off by four. <b>Always convert btsnoop timestamps to real local time
     * (+4h) before comparing them to anything.</b>
     *
     * <p>A stale, yesterday's timestamp here was separately tested and ruled
     * out as the reason DATA wasn't following RSP - but nothing says a stale
     * value is harmless either, so this always sends the true current time.
     */
    /**
     * Round 2 (2026-09-11, ~00:55 EDT): compared this handshake against a
     * fresh HCI-snoop capture of Even's own app completing a real successful
     * sync minutes earlier. Two real findings from that comparison:
     * - The 00:0A payload (the "app identity?" blob) is byte-for-byte
     *   identical between that capture and one from two nights before - a
     *   true fixed constant, not a rotating per-session token. Rules out the
     *   "stale identity token" theory tried first.
     * - Even's real sequence also sends battery (00:01), firmware version
     *   (00:02), and device id (00:0B) - none of which round 1 ever sent -
     *   interleaved with the health requests, not just once upfront. Notably
     *   the firmware-version query lands immediately before Even's own first
     *   successful health request in the real trace. `06:02`, which round 1
     *   did send, never appears anywhere in that real successful sync -
     *   dropped here since there's now real evidence it isn't needed and it
     *   was never more than a guess to begin with.
     * This round adds 00:01/00:02/00:0B up front rather than interleaved
     * (interleaving would need restructuring requestRingHealth() too - a
     * bigger change deferred until this simpler version is shown to help or
     * not).
     */
    private void sendRingHandshake() {
        // +14400s was hardcoded here because every capture behind this work was
        // taken in EDT, where 14400s happens to be the magnitude of the UTC
        // offset - so the constant was right by coincidence of season, not by
        // derivation, and would have gone an hour wrong at the next DST change.
        // This computes it instead: identical in EDT, correct year-round.
        //
        // ⚠ MIND THE SIGN. The ring's clock runs AHEAD of real time by the
        // magnitude of a west-of-UTC offset, so the quantity wanted here is
        // NEGATIVE `TimeZone.getOffset()`, which is itself negative west of UTC
        // (-14400000ms in EDT). Getting this backwards sets the ring's clock 8h
        // wrong rather than 0h wrong. Measured 2026-09-12: the un-negated form
        // logged -14400 and the ring then returned step buckets dated 8h out.
        //
        // Note this is the OPPOSITE of the "ring stores naive local time"
        // hypothesis, which predicts `epoch + utc_offset` = epoch - 14400. The
        // measured, working value is epoch + 14400. The hypothesis is therefore
        // NOT confirmed by this code; what is preserved here is the behaviour
        // verified against six real Even clock-set writes.
        //
        // ⚠ PAIRED with `ringClockOffsetMs()` in `app/health/health-live.ts`,
        // which subtracts the same quantity on the way back out. These two must
        // move together; both now compute the value rather than hardcoding EDT.
        long nowMs = System.currentTimeMillis();
        long clockOffsetSeconds = -TimeZone.getDefault().getOffset(nowMs) / 1000L;
        long liveClockSeconds = (nowMs / 1000L) + clockOffsetSeconds;
        // Asserted at every handshake: in EDT this must read 14400. The clock write
        // is the part of this protocol that took two sessions to get working, so a
        // changed value here is the one way a working pull silently breaks.
        Log.i(TAG, "ring handshake clock offset seconds = " + clockOffsetSeconds
                + " (tz " + TimeZone.getDefault().getID() + ")");
        byte[] clock = le32(liveClockSeconds);

        int seq1, nonce1, seq2, nonce2, seq3, nonce3, seq4, nonce4, seq5, nonce5, seq6, nonce6, seq7, nonce7;
        synchronized (lock) {
            seq1 = nextRingSeqLocked();
            nonce1 = nextRingNonceLocked();
            seq2 = nextRingSeqLocked();
            nonce2 = nextRingNonceLocked();
            seq3 = nextRingSeqLocked();
            nonce3 = nextRingNonceLocked();
            seq4 = nextRingSeqLocked();
            nonce4 = nextRingNonceLocked();
            seq5 = nextRingSeqLocked();
            nonce5 = nextRingNonceLocked();
            seq6 = nextRingSeqLocked();
            nonce6 = nextRingNonceLocked();
            seq7 = nextRingSeqLocked();
            nonce7 = nextRingNonceLocked();
        }

        byte[][] frames = {
            RingProtocol.buildFrame(RingProtocol.CHAN_DEVICE, RingProtocol.KIND_REQ, 0x00, 0x08, seq1,
                // NO nonce prefix on this one frame - payload is exactly the
                // three bytes 3f 01 01. Every other request on both channels
                // starts with the 2-byte nonce; 00:08 does not, and the ring
                // silently drops the whole frame if you add one, then ignores
                // everything that follows on the connection.
                //
                // Measured 2026-09-11 across all four btsnoop captures, 46
                // real 00:08 writes, zero exceptions:
                //   payload 3f0101       (3 bytes) -> 3 writes, ALL answered (12-21 notifications each)
                //   payload 01003f0101   (5 bytes) -> 43 writes, ALL silent (zero notifications)
                // The 5-byte form is the more common one in the captures only
                // because it is ours, failing and retrying all night. Do not
                // "fix" this back to the nonce form by pattern-matching the
                // other frames or by counting which variant appears more.
                //
                // This also explains 2026-09-10: the handshake worked when it
                // was raw bytes replayed from the capture, and stopped working
                // the moment it was rebuilt "properly" through buildFrame(),
                // which is what introduced the nonce prefix.
                new byte[] {0x3f, 0x01, 0x01}),
            RingProtocol.buildFrame(RingProtocol.CHAN_DEVICE, RingProtocol.KIND_DATA, 0x00, 0x0e, seq2,
                concatBytes(le16(nonce2), clock, new byte[] {0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00})),
            RingProtocol.buildFrame(RingProtocol.CHAN_DEVICE, RingProtocol.KIND_DATA, 0x00, 0x05, seq3,
                concatBytes(le16(nonce3), new byte[] {0x10, (byte) 0xff}, clock)),
            // Battery, firmware version, device id - all bare nonce-only REQs,
            // same shape as the health requests. New this round.
            RingProtocol.buildFrame(RingProtocol.CHAN_DEVICE, RingProtocol.KIND_REQ, 0x00, 0x01, seq4,
                le16(nonce4)),
            RingProtocol.buildFrame(RingProtocol.CHAN_DEVICE, RingProtocol.KIND_REQ, 0x00, 0x02, seq5,
                le16(nonce5)),
            RingProtocol.buildFrame(RingProtocol.CHAN_DEVICE, RingProtocol.KIND_REQ, 0x00, 0x0b, seq6,
                le16(nonce6)),
            RingProtocol.buildFrame(RingProtocol.CHAN_DEVICE, RingProtocol.KIND_REQ, 0x00, 0x0a, seq7,
                concatBytes(le16(nonce7), parseHex("f8f53d235ac4ceaa073885cc"))),
        };
        for (byte[] frame : frames) {
            if (!writeRingFrame(frame, "handshake")) {
                return;
            }
        }
        logLine("ring health: sent device-channel handshake (" + frames.length + " frames)");
    }

    private static byte[] parseHex(String hex) {
        byte[] out = new byte[hex.length() / 2];
        for (int i = 0; i < out.length; i++) {
            out[i] = (byte) Integer.parseInt(hex.substring(i * 2, i * 2 + 2), 16);
        }
        return out;
    }

    private static byte[] le16(int value) {
        return new byte[] {(byte) value, (byte) (value >>> 8)};
    }

    private static byte[] le32(long value) {
        return new byte[] {(byte) value, (byte) (value >>> 8), (byte) (value >>> 16), (byte) (value >>> 24)};
    }

    private static byte[] concatBytes(byte[]... parts) {
        int len = 0;
        for (byte[] part : parts) {
            len += part.length;
        }
        byte[] out = new byte[len];
        int offset = 0;
        for (byte[] part : parts) {
            System.arraycopy(part, 0, out, offset, part.length);
            offset += part.length;
        }
        return out;
    }

    /**
     * Timeout waiting for a health REQ's own RSP. In the reference capture
     * (a real successful Even sync, extracted from
     * {@code /tmp/btsnoop_fresh.log} on bazzite-desktop, 2026-09-11) RSPs
     * land within ~150ms; this only needs to bound the pathological "ring
     * stopped answering entirely" case.
     */
    private static final long RING_HEALTH_RSP_TIMEOUT_MS = 3000L;

    /**
     * How long to keep waiting after the most recent DATA page for a health
     * type before deciding its transfer is over (or that there was never
     * going to be one). Chosen from the same reference capture: consecutive
     * pages for one type land well under a second apart, so 1.5s covers
     * that with real margin while still moving on quickly when a type
     * genuinely has nothing new.
     */
    private static final long RING_HEALTH_DATA_IDLE_MS = 1500L;

    /**
     * Device-channel commands Even's real app fires in the gaps between
     * health requests - identity (0x0a), battery (0x01), firmware version
     * (0x02), device id (0x0b) - found by extracting the literal wire order
     * of a real successful sync (same capture as above; two independent
     * syncs in it agree). Rotated one-per-health-type here rather than
     * replicated exactly (Even's real cadence isn't perfectly regular
     * either - compare the two syncs in the capture), since which of these,
     * if any, is actually load-bearing for the ring answering has never
     * been isolated. This is matching cadence, not a confirmed protocol
     * requirement.
     */
    private static final int[] RING_DEVICE_PING_CMD_LO = {0x0a, 0x01, 0x02, 0x0b};

    /**
     * Pull the five health record types. Each request is a bare 17-byte frame
     * carrying only a nonce; the ring answers with an RSP on the same
     * sequence number, then - sometimes - pushes one or more DATA pages,
     * which arrive through {@link #handleRingHealthNotification}.
     *
     * <p><b>Response-driven, not sleep-driven (rewritten 2026-09-11).</b>
     * The original version fired all five REQs on a blind fixed sleep and
     * only flushed queued page ACKs after the whole loop finished - a real
     * successful Even sync (see the constants above) does the opposite: it
     * waits for each REQ's own RSP, waits for DATA to go idle, ACKs
     * immediately, then interleaves one device-channel command before the
     * next health type. This version does the same, using the existing
     * lock.wait()/notifyAll() idiom already used elsewhere in this class
     * (e.g. the shutdown-ack wait above) rather than a new mechanism.
     *
     * <p><b>Race condition, confirmed live 2026-09-10 - this is what the
     * rewrite above addresses, not a reason to remove this warning.</b> The
     * ring appears to hold only one health type's response in flight at a
     * time. Sending the next health REQ before the previous type's DATA
     * page(s) have actually arrived silently drops the earlier type's DATA:
     * you still get its RSP, you never get its DATA, and nothing in the
     * protocol signals an error. Evidence: five REQs fired back-to-back (the
     * old blind-sleep version, badly timed) got five RSPs and zero DATA
     * pages over more than a minute of waiting.
     *
     * <p><b>Worse: a lost race may PERMANENTLY discard that backlog, not
     * just delay it.</b> On 2026-09-10, real HRV/SpO2/sleep backlog that
     * should have existed (unreported since that morning, confirmed against
     * the hourly export cadence in {@code knowledge/inbox/Even_health_data})
     * did not come back on a later, more carefully spaced retry. The working
     * theory - not proven, but treat it as true until disproven, because the
     * downside of being wrong is silent data loss with nothing to catch it
     * - is that the ring advances its own "last delivered" watermark for a
     * type as soon as it RSPs a REQ for it, whether or not the DATA page
     * actually made it out. <b>Do not send a speculative or test health REQ
     * for a type unless you intend to actually receive and persist its
     * DATA</b> - re-requesting will not recover what an earlier, raced
     * request already consumed. The rewrite below waiting for DATA to go
     * idle before advancing reduces how often this can happen but does not
     * prove it can no longer happen (e.g. if the ring's real per-type
     * timeout is shorter than RING_HEALTH_DATA_IDLE_MS for some type).
     *
     * <p>A separate, completely ordinary case looks identical from the wire
     * alone: an RSP with no DATA can also just mean the ring genuinely has
     * nothing new for that metric since the last successful pull. There is
     * currently no way to tell "raced and silently discarded" apart from
     * "genuinely nothing new" other than knowing independently whether fresh
     * data should exist (e.g. from the export's own sampling cadence).
     *
     * <p>Runs on the worker thread (from connectRing), which is the only
     * thread allowed to call the blocking write path - the wait loops below
     * block that same thread, which is why {@link #flushRingOutbound} is
     * called explicitly after each type rather than relying on the main
     * loop's own call to it.
     */
    private boolean requestRingHealth() {
        int[] commands = RingProtocol.HEALTH_COMMANDS;
        int rspCount = 0;
        for (int i = 0; i < commands.length; i++) {
            int command = commands[i];
            byte[] frame;
            synchronized (lock) {
                ringHealthRspSeen = false;
                frame = RingProtocol.buildHealthRequest(command, nextRingSeqLocked(), nextRingNonceLocked());
            }
            if (!writeRingFrame(frame, "health request 0x" + Integer.toHexString(command))) {
                // ABORTED: the sequence stopped partway. Distinct from "the
                // ring had nothing for a type", which is an ordinary outcome
                // and leaves the loop running - see the return below.
                logLine("ring health: pull ABORTED on write at 0x" + Integer.toHexString(command)
                    + " (" + i + " of " + commands.length + " types attempted, "
                    + rspCount + " answered)");
                return false;
            }

            if (awaitRingHealthRsp(RING_HEALTH_RSP_TIMEOUT_MS)) {
                rspCount++;
                awaitRingHealthDataIdle(RING_HEALTH_DATA_IDLE_MS);
            } else {
                logLine("ring health: no RSP for command 0x" + Integer.toHexString(command) + ", moving on");
            }
            // Write out any ACK(s) queued by DATA pages that just landed,
            // right now rather than after the whole loop - this is the fix
            // for the bug the doc above describes.
            flushRingOutbound();

            if (i < commands.length - 1) {
                sendRingDevicePing(RING_DEVICE_PING_CMD_LO[i % RING_DEVICE_PING_CMD_LO.length]);
            }
        }

        // Two more ways to have not really completed, both distinguishable from
        // "completed but empty":
        //
        //   - the link dropped while the loop was running, so the later types
        //     were written into nothing;
        //   - the ring answered NONE of the five. A type with no backlog still
        //     RSPs (measured: five REQs, five RSPs, zero DATA), so zero RSPs
        //     across the whole sequence means the ring was not answering at
        //     all, not that there was nothing to send.
        //
        // An RSP with no DATA remains ambiguous per type and is NOT treated as
        // a failure here - that is the ordinary "nothing new" case.
        boolean stillConnected;
        synchronized (lock) {
            stillConnected = ringConnected;
        }
        if (!stillConnected || rspCount == 0) {
            logLine("ring health: pull ABORTED - ran all " + commands.length + " types but "
                + (stillConnected ? "the ring answered none of them" : "the link dropped"));
            return false;
        }
        logLine("ring health: requested " + commands.length + " record types, "
            + rspCount + " answered");
        return true;
    }

    /** Block (worker thread) until the health RSP flag is set or the timeout
     * elapses. Not correlated to a specific command/seq - like the rest of
     * this protocol's request path, it trusts the ring answers in order. */
    private boolean awaitRingHealthRsp(long timeoutMs) {
        long deadline = SystemClock.elapsedRealtime() + timeoutMs;
        synchronized (lock) {
            while (running && ringConnected && !ringHealthRspSeen) {
                long remaining = deadline - SystemClock.elapsedRealtime();
                if (remaining <= 0) {
                    return false;
                }
                try {
                    lock.wait(Math.min(remaining, 100));
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    return ringHealthRspSeen;
                }
            }
            return ringHealthRspSeen;
        }
    }

    /** Block (worker thread) until DATA pages go idle for {@code idleMs},
     * extending the window on every new page so a real multi-page backlog
     * transfer isn't cut short. Not filtered by health type - correct given
     * the ring only has one type in flight at a time (see the class doc
     * above), so any page arriving here belongs to the type just requested. */
    private void awaitRingHealthDataIdle(long idleMs) {
        long idleDeadline = SystemClock.elapsedRealtime() + idleMs;
        synchronized (lock) {
            int lastSeenCounter = ringHealthPageCounter;
            while (running && ringConnected) {
                long remaining = idleDeadline - SystemClock.elapsedRealtime();
                if (remaining <= 0) {
                    return;
                }
                if (ringHealthPageCounter != lastSeenCounter) {
                    lastSeenCounter = ringHealthPageCounter;
                    idleDeadline = SystemClock.elapsedRealtime() + idleMs;
                    remaining = idleMs;
                }
                try {
                    lock.wait(Math.min(remaining, 100));
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    return;
                }
            }
        }
    }

    /**
     * Fire one bare device-channel REQ in the gap between health types,
     * matching (without waiting on a response) the cadence a real Even sync
     * uses. See {@link #RING_DEVICE_PING_CMD_LO} for provenance and caveats.
     */
    private void sendRingDevicePing(int cmdLo) {
        byte[] frame;
        synchronized (lock) {
            int seq = nextRingSeqLocked();
            int nonce = nextRingNonceLocked();
            if (cmdLo == 0x0a) {
                // The only one of these four that isn't a bare nonce - it
                // carries the same opaque constant blob as the handshake's
                // own 0x0a frame (confirmed byte-identical across two
                // different nights, see sendRingHandshake()'s comments).
                frame = RingProtocol.buildFrame(RingProtocol.CHAN_DEVICE, RingProtocol.KIND_REQ, 0x00, 0x0a, seq,
                    concatBytes(le16(nonce), parseHex("f8f53d235ac4ceaa073885cc")));
            } else {
                frame = RingProtocol.buildRequest(RingProtocol.CHAN_DEVICE, 0x00, cmdLo, seq, nonce);
            }
        }
        writeRingFrame(frame, "device ping 0x" + Integer.toHexString(cmdLo));
    }

    /** Write one already-built ring frame. Worker-thread only (blocking). */
    private boolean writeRingFrame(byte[] frame, String what) {
        try {
            boolean ok = bleManager.writeFrames(
                ringAddress,
                BleProtocol.R1_WRITE_CHAR_UUID,
                Collections.singletonList(frame),
                ConnectionOptions.WRITE_TYPE,
                ConnectionOptions.WRITE_TIMEOUT_MS
            );
            if (!ok) {
                logLine("ring " + what + " write failed");
            }
            return ok;
        } catch (Throwable t) {
            logLine("ring " + what + " write error: " + safeMessage(t));
            return false;
        }
    }

    /**
     * Drain queued ring frames (page ACKs). Worker-thread only. Returns true
     * when anything was written.
     */
    private boolean flushRingOutbound() {
        boolean wroteAny = false;
        while (true) {
            byte[] frame;
            synchronized (lock) {
                if (!ringNotificationsReady || ringOutbound.isEmpty()) {
                    return wroteAny;
                }
                frame = ringOutbound.poll();
            }
            if (frame == null) {
                return wroteAny;
            }
            wroteAny |= writeRingFrame(frame, "page ack");
        }
    }

    private int nextRingSeqLocked() {
        ringSeq = (ringSeq + 1) & 0xff;
        if (ringSeq == 0) {
            ringSeq = 1;
        }
        return ringSeq;
    }

    private int nextRingNonceLocked() {
        ringNonce = (ringNonce + 1) & 0xffff;
        return ringNonce;
    }

    /**
     * A snapshot of the health buffer together with the watermark identifying
     * it.
     *
     * <p>The two have to come out under ONE lock. Reading the list and the
     * count separately would let a page land in between, and the consumer would
     * then clear a record nothing had ingested - the exact failure the
     * watermark exists to prevent.
     */
    public static final class RingHealthBatch {
        private final List<RingProtocol.HealthRecord> records;
        private final long watermark;

        RingHealthBatch(List<RingProtocol.HealthRecord> records, long watermark) {
            this.records = records;
            this.watermark = watermark;
        }

        public List<RingProtocol.HealthRecord> getRecords() {
            return records;
        }

        /** Total-ever-added at the instant of the snapshot. */
        public long getWatermark() {
            return watermark;
        }
    }

    /**
     * Snapshot of everything the ring has pushed and not yet been consumed,
     * with the watermark needed to hand it back as consumed.
     */
    public RingHealthBatch takeRingHealthBatch() {
        synchronized (lock) {
            return new RingHealthBatch(new ArrayList<>(ringHealthRecords), ringHealthTotalAdded);
        }
    }

    /**
     * Drop every held record whose identity is below {@code watermark} - that
     * is, everything the caller has durably stored.
     *
     * <p>"Cut and paste instead of copy paste. If you didn't receive the pull
     * then it should not delete yet." Call this ONLY after the store write has
     * succeeded; a caller that dies before calling it simply sees the same
     * records again, which is a no-op at the store.
     *
     * <p>Records that arrived after the snapshot sit above the watermark and
     * are left alone, so a page landing during an ingest is never lost. If the
     * buffer evicted its oldest in the meantime (see
     * {@link #RING_HEALTH_MAX_RECORDS}) the arithmetic accounts for it via
     * {@code ringHealthTotalAdded} rather than clearing the wrong end.
     *
     * @return how many records were actually removed.
     */
    public int clearRingHealthRecordsBelow(long watermark) {
        synchronized (lock) {
            long firstHeldIndex = ringHealthTotalAdded - ringHealthRecords.size();
            long toRemove = watermark - firstHeldIndex;
            if (toRemove <= 0) {
                return 0;
            }
            if (toRemove > ringHealthRecords.size()) {
                toRemove = ringHealthRecords.size();
            }
            ringHealthRecords.subList(0, (int) toRemove).clear();
            return (int) toRemove;
        }
    }

    /**
     * Snapshot of everything the ring has pushed this session, WITHOUT
     * consuming it.
     *
     * <p>Kept for callers that only want to look. The ingest path must use
     * {@link #takeRingHealthBatch()} instead - a pure copy is what let the
     * buffer grow unbounded and every tick re-process the whole session.
     */
    public List<RingProtocol.HealthRecord> getRingHealthRecords() {
        synchronized (lock) {
            return new ArrayList<>(ringHealthRecords);
        }
    }

    private boolean enableRingNotification(String characteristicUuid) {
        try {
            return bleManager.enableNotifications(
                ringAddress,
                characteristicUuid,
                true,
                ConnectionOptions.DESCRIPTOR_TIMEOUT_MS
            );
        } catch (Throwable t) {
            Log.d(TAG, "direct ring notify subscribe skipped: " + characteristicUuid + " " + safeMessage(t));
            return false;
        }
    }

    /**
     * Complete the sid-0x80 security-auth exchange on both freshly opened arm
     * connections. Firmware 2.2.9 answers no queries until it completes over an
     * encrypted link and closes unauthenticated links after ~30 s (see
     * ../notes/ble-connections-2.2.9.md); on an unbonded phone the exchange is
     * also what triggers SMP pairing. Deliberately soft: on timeout we log and
     * continue rather than fail the connect — the custom firmware's response
     * behavior is not yet hardware-verified, and on stock firmware an
     * unanswered auth just means the prelude fails exactly as it did before.
     * A pairing prompt accepted after our window still bonds at the OS level,
     * so the next reconnect attempt authenticates promptly.
     */
    private void authenticateArms() throws InterruptedException {
        OutboundMessage right = messageBuilder.securityAuth(false);
        OutboundMessage left = messageBuilder.securityAuth(true);
        long now = SystemClock.elapsedRealtime();
        for (OutboundMessage message : new OutboundMessage[] {right, left}) {
            message.onAck = () -> {
            };
            message.onTimeout = () -> {
            };
            message.sentAtMs = now;
            writeMessage(message);
        }
        long deadline = SystemClock.elapsedRealtime() + ConnectionOptions.SECURITY_AUTH_SOFT_TIMEOUT_MS;
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
                clearInFlightMessagesLocked("security auth timeout");
                logLine("security auth not acknowledged; continuing (2.2.9 stock requires it; older/custom firmware may not answer)");
                return;
            }
        }
        boolean rightOk = BleProtocol.isAuthenticationSuccess(right.ackPayload, right.magic);
        boolean leftOk = BleProtocol.isAuthenticationSuccess(left.ackPayload, left.magic);
        logLine("security auth R=" + (rightOk ? "ok" : "unconfirmed") + " L=" + (leftOk ? "ok" : "unconfirmed"));
    }

    private void sendPrelude() throws InterruptedException {
        sendPrelude(false);
    }

    private void sendPrelude(boolean preserveWakeLeaseControls) throws InterruptedException {
        synchronized (lock) {
            if (preserveWakeLeaseControls) {
                clearAllMessagesPreservingWakeLeaseLocked("prelude");
            } else {
                clearAllMessagesLocked("prelude");
            }
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
    }

    private long driveSession() {
        //Log.d(TAG, "driveSession called (pendingMessages.size=" + pendingMessages.size() + " inFlightMessages.size=" + inFlightMessages.size() + ")");
        while (true) {
            // Run on the sender thread, outside `lock`: Bluetooth API calls can
            // wait on the global GATT lock, and callbacks need the session lock.
            // Keep negotiation outside the timed stream. A fixed settling period
            // is only an experiment boundary; HCI must confirm actual parameters.
            int linkMode = -1;
            String[] benchmarkAddresses = null;
            synchronized (lock) {
                if (benchmarkActive && benchmarkLinkPending) {
                    benchmarkLinkPending = false;
                    linkMode = benchmarkLinkMode;
                    benchmarkAddresses = new String[] {leftAddress, rightAddress};
                }
            }
            if (benchmarkAddresses != null) {
                for (String address : benchmarkAddresses) {
                    try {
                        bleManager.prepareBenchmarkLink(address, linkMode);
                    } catch (RuntimeException error) {
                        logLine("benchmark link request failed: " + safeMessage(error));
                    }
                }
                synchronized (lock) {
                    // Cancellation/new-run races leave the new run pending; its
                    // own preparation will replace this deadline before sending.
                    benchmarkReadyAtMs = SystemClock.elapsedRealtime() + 1_000;
                }
            }
            OutboundMessage messageToWrite = null;
            OutboundMessage messageToPrewrite = null;
            long now = SystemClock.elapsedRealtime();

            maybeFinishNoChangeDesiredFrame();

            synchronized (lock) {
                if (cfwCleanupDelivered) {
                    /* Successful mode 11 must be the last Faceclaw write. Drop
                     * anything a late external producer attempted to enqueue
                     * while DashboardController was closing the transport. */
                    clearPendingMessagesLocked("after CFW cleanup");
                    return 250;
                }
                if (sessionReady
                        && now - lastFaceclawFramebufferLeaseQueuedAtMs >= FACECLAW_WAKE_LEASE_RENEW_MS
                        && !hasPendingOrInflightKindLocked("framebuffer-lease-control")) {
                    enqueueFaceclawFramebufferControlLocked(
                        BleProtocol.FACECLAW_FB_OP_ACQUIRE,
                        false
                    );
                }
                if (faceclawWakeLeaseEnabled
                        && sessionReady
                        && now - lastFaceclawWakeLeaseQueuedAtMs >= FACECLAW_WAKE_LEASE_RENEW_MS
                        && !hasPendingOrInflightKindLocked("wake-lease-control")) {
                    enqueueFaceclawWakeControlLocked(
                        BleProtocol.FACECLAW_WAKE_OP_ACQUIRE,
                        0,
                        false
                    );
                }
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
                    if (connectionOptions.WINDOW_SIZE <= 1
                            && sessionReady
                            && prewrittenMessage == null
                            && !pendingMessages.isEmpty()
                            && canPrewriteCandidate(pendingMessages.peekFirst())
                            && !shouldBlockPrewriteForHeartbeatLocked(now)) {
                        // Only the serial (window==1) path pre-sends the all-but-last
                        // packet; with a real window we just send the next message fully.
                        messageToPrewrite = pendingMessages.peekFirst();
                    }
                }

                if (chargingMode) {
                    // Glasses are in the case: no display traffic, only battery
                    // polls (which also detect the end of charging).
                    finishDesiredFrameLocked("discarded: glasses charging");
                    if (sessionReady && inFlightMessages.isEmpty() && !pendingMessages.isEmpty()) {
                        messageToWrite = pendingMessages.removeFirst();
                        Log.i(TAG, "sending pending message (charging): " + messageToWrite.label);
                    } else if (sessionReady && pendingMessages.isEmpty() && inFlightMessages.isEmpty()
                            && now - lastBatteryRefreshAtMs >= ConnectionOptions.CHARGING_BATTERY_POLL_MS) {
                        Log.i(TAG, "Writing charging-mode battery poll");
                        messageToWrite = createBatteryQueryMessageLocked();
                        lastBatteryRefreshAtMs = now;
                    } else {
                        return 1_000;
                    }
                } else {
                    if (messageToPrewrite == null
                            && !shutdownRequested
                            && !fixedLayoutCreated
                            && pendingMessages.isEmpty()
                            && inFlightMessages.isEmpty()) {
                        Log.i(TAG, "enqueueing create layout");
                        enqueueCreateLayoutLocked();
                    } else if (messageToPrewrite != null) {
                        // Prewrite outside the lock; the logical message remains pending until
                        // its final BLE frame is sent after the current protocol ACK.
                    }
                    if (messageToPrewrite == null && !shutdownRequested && fixedLayoutCreated
                            && (firmwareDebugFlagsEnabled ? 2 : 1) != firmwareDebugFlagsLastSent
                            && pendingMessages.isEmpty() && inFlightMessages.isEmpty()) {
                        Log.i(TAG, "enqueueing firmware debug flags " + (firmwareDebugFlagsEnabled ? "show" : "hide"));
                        enqueueFirmwareDebugFlagsLocked();
                    }

                    if (messageToPrewrite == null && !shutdownRequested && fixedLayoutCreated
                            && (compassOwners.isEmpty() ? 0 : 1) != compassControlLastSent
                            && pendingMessages.isEmpty() && inFlightMessages.isEmpty()) {
                        boolean wanted = !compassOwners.isEmpty();
                        Log.i(TAG, "enqueueing compass " + (wanted ? "enable" : "disable"));
                        enqueueCompassControlLocked(false, wanted);
                    }

                    if (benchmarkActive) {
                        maintainBenchmarkLocked(now);
                    }

                    // Up to WINDOW_SIZE messages may be in flight at once (full
                    // pipelining); a slot frees when an ack arrives. An active
                    // bandwidth benchmark measures its own selected window instead.
                    boolean windowHasRoom = inFlightMessages.size()
                            < Math.max(1, benchmarkActive ? benchmarkWindowSize : connectionOptions.WINDOW_SIZE);
                    // A frame ready to send right now: don't inject a fresh
                    // heartbeat in front of it (the image's own ack resets the
                    // firmware heartbeat timer, so the heartbeat is redundant).
                    // "Ready" covers both a fresh composite still to be planned
                    // and a planned image already queued but not yet written --
                    // enqueueing sets lastEnqueuedFingerprint, so testing only
                    // the desired fingerprint left the queued-but-unwritten
                    // window unprotected and a heartbeat that came due there
                    // cost the frame a full ack round trip (measured 124ms on
                    // frame#232 of the 2026-08-20 02:27 capture).
                    // A benchmark run counts as image traffic here for the same
                    // reason: its acks reset the firmware heartbeat timer, so a
                    // fresh heartbeat in front of it is redundant.
                    boolean imageWaiting = !shutdownRequested && fixedLayoutCreated
                            && !hasPendingOrInflightKindLocked("heartbeat")
                            && (benchmarkActive
                                || (now >= imageRetryAfterMs
                                    && (hasPendingImageLocked()
                                        || !getDesiredFingerprint().equals(lastEnqueuedFingerprint))));
                    noteImageStallLocked(now, windowHasRoom);
                    if (messageToPrewrite == null && handleHeartbeat(imageWaiting)) {
                        return ConnectionOptions.IDLE_SLEEP_MS;
                    }

                    if (messageToPrewrite == null && sessionReady && windowHasRoom && !pendingMessages.isEmpty()) {
                        messageToWrite = pendingMessages.removeFirst();
                        Log.i(TAG, "sending pending message: " + messageToWrite.label);
                    } else if (messageToPrewrite == null && !shutdownRequested && !benchmarkActive
                            && fixedLayoutCreated
                            && windowHasRoom && !hasPendingImageLocked()
                            && now >= imageRetryAfterMs
                            && !getDesiredFingerprint().equals(lastEnqueuedFingerprint)) {
                        // Enqueue the next frame's delta against lastEnqueuedPacked
                        // (what the shadow will be), so it can pipeline behind an
                        // image still awaiting its ack.
                        Log.i(TAG, "Enqueued image update");
                        enqueueDesiredImageLocked();
                        return 0;
                    } else if (messageToPrewrite == null && shouldPollBatteryLocked(now)) {
                        Log.i(TAG, "Writing battery query");
                        messageToWrite = createBatteryQueryMessageLocked();
                        lastBatteryRefreshAtMs = now;
                    } else if (messageToPrewrite == null && (!pendingMessages.isEmpty() || !inFlightMessages.isEmpty())) {
                        return ConnectionOptions.IDLE_SLEEP_MS;
                    } else if (messageToPrewrite == null) {
                        return 250;
                    }
                }
            }

            if (messageToPrewrite != null) {
                if (prewriteMessage(messageToPrewrite)) {
                    return 0;
                }
                return ConnectionOptions.IDLE_SLEEP_MS;
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

    /**
     * If the desired image already matches what the glasses display, nothing will
     * ever be enqueued for it, so finish its frame now (otherwise the TS side
     * would block on it until its backpressure timeout).
     */
    private void maybeFinishNoChangeDesiredFrame() {
        int frameIdToFinish = 0;
        synchronized (lock) {
            synchronized (desiredTilesLock) {
                if (desiredFrameId != 0 && !lastEnqueuedFingerprint.isEmpty() && desiredFingerprint.equals(lastEnqueuedFingerprint)) {
                    frameIdToFinish = desiredFrameId;
                    desiredFrameId = 0;
                }
            }
        }
        if (frameIdToFinish != 0) {
            finishFrame(frameIdToFinish, "discarded: no change from displayed image");
        }
    }

    private boolean shouldBlockPrewriteForHeartbeatLocked(long now) {
        if (shutdownRequested || !fixedLayoutCreated) {
            return false;
        }
        return hasPendingOrInflightKindLocked("heartbeat")
                || now - lastHeartbeatAckedAtMs >= ConnectionOptions.HEARTBEAT_READY_MS;
    }

    private boolean canPrewriteCandidate(OutboundMessage message) {
        if (message == null || !message.isLeftArmMessage) {
            return false;
        }
        if (!"image".equals(message.kind)) {
            return false;
        }
        return message.message.length + 2 > 232;
    }

    private boolean handleHeartbeat(boolean imageWaiting) {
        long now = SystemClock.elapsedRealtime();
        boolean heartbeatEligible = !shutdownRequested && fixedLayoutCreated;
        boolean heartbeatPending = heartbeatEligible && hasPendingOrInflightKindLocked("heartbeat");
        long heartbeatElapsedMs = now - lastHeartbeatAckedAtMs;
        boolean heartbeatReady = heartbeatEligible && heartbeatElapsedMs >= ConnectionOptions.HEARTBEAT_READY_MS;
        boolean heartbeatUrgent = heartbeatEligible && heartbeatElapsedMs >= ConnectionOptions.HEARTBEAT_URGENT_MS;
        boolean heartbeatBlocksLeftWrites = heartbeatReady || heartbeatPending;

        if (heartbeatReady && !heartbeatPending && inFlightMessages.isEmpty()) {
            if (imageWaiting && !heartbeatUrgent) {
                // Defer to the waiting frame: sending it now satisfies the
                // firmware heartbeat deadline (its ack resets the timer), and
                // the heartbeat still fires once we reach the URGENT threshold
                // if rendering goes quiet again. Preserves the pending-heartbeat
                // inter-lens-sync invariant below (that path is untouched).
                return false;
            }
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
        List<byte[]> frames;
        if (prewrittenMessage != null && prewrittenMessage != message) {
            if (!spoilPrewrittenMessage("before " + message.label)) {
                return false;
            }
        }
        if (prewrittenMessage == message) {
            frames = Collections.singletonList(prewrittenFrames.get(prewrittenFrames.size() - 1));
            prewrittenMessage = null;
            prewrittenFrames = Collections.emptyList();
        } else {
            frames = BleProtocol.framePb(
                message.message,
                message.sid,
                message.flag,
                nextTransportSeq++
            );
        }
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
            if (result && message.onSent != null) {
                message.onSent.run();
                lock.notifyAll();
            }
        }

        return result;
    }

    private boolean prewriteMessage(OutboundMessage message) {
        if (prewrittenMessage == message) {
            return true;
        }
        if (prewrittenMessage != null && !spoilPrewrittenMessage("before prewrite " + message.label)) {
            return false;
        }
        if (!canPrewriteCandidate(message)) {
            return false;
        }

        List<byte[]> frames = BleProtocol.framePb(
            message.message,
            message.sid,
            message.flag,
            nextTransportSeq++
        );
        if (frames.size() <= 1) {
            return false;
        }

        String writeAddress = message.isLeftArmMessage ? leftAddress : rightAddress;
        List<byte[]> prefixFrames = frames.subList(0, frames.size() - 1);
        boolean result = bleManager.writeFrames(
            writeAddress,
            BleProtocol.WRITE_CHAR_UUID,
            prefixFrames,
            ConnectionOptions.WRITE_TYPE,
            ConnectionOptions.WRITE_TIMEOUT_MS
        );
        if (!result) {
            return false;
        }

        prewrittenMessage = message;
        prewrittenFrames = new ArrayList<>(frames);
        logLine("prewrote " + message.label + " frames=" + prefixFrames.size() + "/" + frames.size());
        return true;
    }

    private boolean spoilPrewrittenMessage(String reason) {
        if (prewrittenMessage == null || prewrittenFrames.isEmpty()) {
            prewrittenMessage = null;
            prewrittenFrames = Collections.emptyList();
            return true;
        }
        OutboundMessage message = prewrittenMessage;
        byte[] finalFrame = Arrays.copyOf(
            prewrittenFrames.get(prewrittenFrames.size() - 1),
            prewrittenFrames.get(prewrittenFrames.size() - 1).length
        );
        if (finalFrame.length > 8) {
            finalFrame[finalFrame.length - 1] ^= (byte) 0xff;
        }
        prewrittenMessage = null;
        prewrittenFrames = Collections.emptyList();

        String writeAddress = message.isLeftArmMessage ? leftAddress : rightAddress;
        logLine("spoiling prewritten " + message.label + ": " + reason);
        return bleManager.writeFrames(
            writeAddress,
            BleProtocol.WRITE_CHAR_UUID,
            Collections.singletonList(finalFrame),
            ConnectionOptions.WRITE_TYPE,
            ConnectionOptions.WRITE_TIMEOUT_MS
        );
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
        // onAck may have just satisfied a waiter blocked on lock.wait() (e.g.
        // awaitEvenHubSessionReady polling fixedLayoutCreated/displayedFingerprint
        // after a create-layout or image ack). Without this, that waiter only
        // notices on its own up-to-100ms poll tick, adding avoidable latency to
        // every EvenHub wake. Always called with lock held (see call site).
        lock.notifyAll();
    }

    private void logImageUpdateSendLandmarkLocked(OutboundMessage message) {
        if (message.imageUpdateId <= 0) {
            return;
        }
        BleImageOptimizer.ImageUpdateStats stats = imageUpdateStats.get(message.imageUpdateId);
        int frameId = stats == null ? 0 : stats.frameId;
        if (message.imageMessageNumber == 1) {
            if (stats != null && stats.firstWriteStartedAtMs <= 0) {
                stats.firstWriteStartedAtMs = message.writeStartedAtMs > 0 ? message.writeStartedAtMs : message.sentAtMs;
            }
            FrameTimings.getInstance().log(frameId, "first bluetooth packet sent");
            logImageUpdateLandmarkLocked("first bluetooth message sent", message, message.sentAtMs);
        }
        if (message.imageMessageNumber == message.imageMessageCount) {
            FrameTimings.getInstance().log(frameId,
                "last bluetooth packet sent (message " + message.imageMessageNumber + "/" + message.imageMessageCount + ")");
            logImageUpdateLandmarkLocked("last bluetooth message sent", message, message.sentAtMs);
        }
    }

    private void logImageUpdateAckLandmarkLocked(OutboundMessage message) {
        if (message.imageUpdateId <= 0 || message.imageMessageNumber != message.imageMessageCount) {
            return;
        }
        long ackedAtMs = SystemClock.elapsedRealtime();
        FaceclawBleManager.recordDisplayFrameSent();
        BleImageOptimizer.ImageUpdateStats stats = imageUpdateStats.remove(message.imageUpdateId);
        if (stats != null && stats.firstWriteStartedAtMs > 0) {
            emitFrameMetrics(stats.paintMs, (int) Math.max(0, ackedAtMs - stats.firstWriteStartedAtMs), stats.tileCount);
        }
        if (stats != null) {
            finishFrame(stats.frameId, "sent");
        }
        logImageUpdateLandmarkLocked("last bluetooth message acked", message, ackedAtMs);
    }

    /** Remove the stats entry for an image update that will not complete, finishing its frame. */
    private void discardImageUpdateStatsLocked(int imageUpdateId, String reason) {
        if (imageUpdateId <= 0) {
            return;
        }
        BleImageOptimizer.ImageUpdateStats stats = imageUpdateStats.remove(imageUpdateId);
        if (stats != null) {
            finishFrame(stats.frameId, "discarded: " + reason);
        }
    }

    private void logImageUpdateLandmarkLocked(String event, OutboundMessage message, long elapsedMs) {
        logLine("image update#" + message.imageUpdateId + " " + event
                + " at " + timestamp(elapsedMs)
                + " message=" + message.imageMessageNumber + "/" + message.imageMessageCount
                + " label=" + message.label);
    }

    private void enqueueCreateLayoutLocked() {
        // New session/container: re-assert the firmware-debug-flags overlay once
        // the layout is ready (the mode-7 send is gated on this having reset).
        firmwareDebugFlagsLastSent = -1;
        OutboundMessage message = messageBuilder.createLayout(DASHBOARD_TILE);
        message.onAck = () -> {
            startupProbePending = false;
            clearMessagesOfKindLocked("startup-text-probe");
            fixedLayoutCreated = true;
            displayedFingerprint = "";
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
            displayedFingerprint = "";
            logLine("existing dashboard layout accepted text probe");
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

    /**
     * Send the CFW mode-7 diagnostic-flag control op to the dashboard container:
     * [7][2] to show the on-glasses debug-flag overlay, [7][1] to hide it. Uses the
     * arbitrary-payload image path (no bmp/dedup/frame-timing interaction) and does
     * nothing on stock firmware (which ignores unknown image modes).
     */
    private void enqueueFirmwareDebugFlagsLocked() {
        boolean show = firmwareDebugFlagsEnabled;
        int sub = show ? 2 : 1;
        byte[] payload = new byte[] { (byte) 7, (byte) sub };
        OutboundMessage message = messageBuilder.imagePayload(
            DASHBOARD_TILE, nextMapSessionId(), payload,
            "fw-debug-flags " + (show ? "show" : "hide"),
            connectionOptions.sendImagesToLeft);
        pendingMessages.addLast(message);
        firmwareDebugFlagsLastSent = sub;
        logLine("queue firmware debug flags " + (show ? "show" : "hide"));
    }

    /**
     * Send CFW image-handler mode 10. Enable uses the configurable form
     * [10][2][interval-ms LE16][minimum-change-degrees LE16]; disable remains [10][0].
     */
    private void enqueueCompassControlLocked(boolean priority, boolean enable) {
        int sentState = enable ? 1 : 0;
        byte[] payload = enable
            ? new byte[] {
                (byte) 10,
                (byte) 2,
                (byte) (COMPASS_REPORT_INTERVAL_MS & 0xff),
                (byte) ((COMPASS_REPORT_INTERVAL_MS >> 8) & 0xff),
                (byte) (COMPASS_MIN_CHANGE_DEGREES & 0xff),
                (byte) ((COMPASS_MIN_CHANGE_DEGREES >> 8) & 0xff),
            }
            : new byte[] { (byte) 10, (byte) 0 };
        OutboundMessage message = messageBuilder.imagePayload(
            "compass-control",
            DASHBOARD_TILE,
            nextMapSessionId(),
            payload,
            "compass " + (enable ? "enable" : "disable"),
            connectionOptions.sendImagesToLeft);
        message.onTimeout = () -> {
            compassControlLastSent = -1;
            logLine("compass control ack timeout");
        };
        if (enable) {
            compassMaybeOn = true;
        } else {
            message.onAck = () -> compassMaybeOn = false;
        }
        if (priority) pendingMessages.addFirst(message);
        else pendingMessages.addLast(message);
        compassControlLastSent = sentState;
        logLine("queue " + message.label);
    }

    private void enqueueDesiredImageLocked() {
        String fingerprint = getDesiredFingerprint();
        byte[] packed;
        int width;
        int height;
        int paintMs;
        int frameId;
        SurfaceCompositor.ScreenDraw[] draws;
        synchronized (desiredTilesLock) {
            packed = desiredPacked;
            width = desiredWidth;
            height = desiredHeight;
            paintMs = desiredPaintMs;
            frameId = desiredFrameId;
            draws = desiredDraws;
            desiredFrameId = 0;
        }
        if (packed == null) {
            packed = new byte[0];
        }
        if (lastEnqueuedWidth == width && lastEnqueuedHeight == height
                && Arrays.equals(packed, lastEnqueuedPacked)) {
            lastEnqueuedFingerprint = fingerprint;
            finishFrame(frameId, "discarded: image content identical to displayed");
            return;
        }

        // Texture-cache path: ship text as cached-glyph draws, punching their
        // ink out of the baked deltas. Uploads (mode 12) ride ahead of the
        // image message on the ordered transport. Falls through to the plain
        // paths whenever the planner has nothing to draw.
        if (customFirmwareDetected && connectionOptions.TEXTURE_CACHE_FRAMES
                && draws != null && draws.length > 0 && packed.length > 0) {
            byte[] deltaBase = (connectionOptions.INCREMENTAL_FRAMES && lastEnqueuedPacked.length > 0
                    && lastEnqueuedWidth == width && lastEnqueuedHeight == height)
                    ? lastEnqueuedPacked : null;
            FrameTimings.getInstance().spanStart(frameId, "texture-plan");
            TexturePlanner.Result tex = TexturePlanner.plan(
                    deltaBase, packed, width, height, draws, textureCache,
                    nextImageFrameId,
                    connectionOptions.MULTI_RECT_FRAMES, ConnectionOptions.MULTI_RECT_MAX_RECTS);
            if (tex != null) {
                nextImageFrameId = tex.nextFid;
                for (byte[] upload : tex.uploads) {
                    enqueueTextureUploadLocked(upload);
                }
                BleImageOptimizer.TileImagePlan plan = new BleImageOptimizer.TileImagePlan(
                        0, DASHBOARD_TILE, packed, width, height, nextMapSessionId(), tex.payload);
                plan.fragments = BleImageOptimizer.planImageFragments(plan.payload, ConnectionOptions.IMAGE_FRAGMENT_SIZE);
                FrameTimings.getInstance().spanEnd(frameId, "texture-plan");
                String texLog = "texture update " + (tex.fullFrame ? "full" : ("rects=" + tex.rectCount))
                        + " glyphs=" + tex.drawnGlyphs + " runs=" + tex.runCount
                        + " images=" + tex.drawnImages
                        + " fw=" + tex.fwGlyphs + "/" + tex.fwRuns
                        + " baked=" + tex.bakedCandidates
                        + (tex.uploadBytes > 0 ? " upload=" + tex.uploadBytes + "B" : "")
                        + " cache=" + textureCache.usedBytes() + "B"
                        + " payload=" + tex.payload.length + "B"
                        + " (rects " + tex.rectsMs + "ms, match " + tex.matchMs
                        + "ms, cache " + tex.cacheMs + "ms, punch " + tex.punchMs
                        + "ms, encode " + tex.encodeMs + "ms)";
                FrameTimings.getInstance().log(frameId, texLog);
                finishEnqueueDesiredImageLocked(plan, fingerprint, paintMs, frameId);
                return;
            }
            FrameTimings.getInstance().spanEnd(frameId, "texture-plan");
        }

        FrameTimings.getInstance().spanStart(frameId, "compress-and-plan");
        // Incremental (mode 3 bounding box) update against the last ENQUEUED frame
        // (the base the firmware shadow will hold when this update is applied).
        // lastEnqueuedPacked is cleared whenever the image pipeline is cleared, so
        // a non-empty value means the display base is trusted.
        byte[] incrementalPayload = null;
        String incrementalLog = null;
        if (connectionOptions.INCREMENTAL_FRAMES && lastEnqueuedPacked.length > 0
                && lastEnqueuedWidth == width && lastEnqueuedHeight == height) {
            int baseFid = nextImageFrameId;
            BleImageOptimizer.IncrementalPlan single =
                BleImageOptimizer.buildIncrementalImagePayload(lastEnqueuedPacked, packed, width, height, baseFid);
            if (single != null) {
                incrementalPayload = single.payload;
                // advance only when a delta is actually emitted, so consecutive
                // deltas carry consecutive ids (CFW skip/reorder detection)
                nextImageFrameId = nextImageFrameId >= 0xfffe ? 1 : nextImageFrameId + 1;
                incrementalLog = "incremental update bbox="
                    + ((single.payload[3] & 0xff) * 4) + "x" + ((single.payload[4] & 0xff) * 2)
                    + "+" + ((single.payload[1] & 0xff) * 4) + "+" + ((single.payload[2] & 0xff) * 2)
                    + " changed=" + single.changedBytes + "/" + single.boxBytes + "B"
                    + " clusters=" + single.clusterCount;

                // When the bounding box spans multiple clusters or is sizeable, try
                // splitting into tight rects (CFW mode-8). Only replace the single
                // box if the multi-rect message is actually smaller on the wire.
                if (connectionOptions.MULTI_RECT_FRAMES
                        && (single.clusterCount > 1 || single.payload.length > ConnectionOptions.MULTI_RECT_MIN_PAYLOAD)) {
                    BleImageOptimizer.MultiRectPlan multi = BleImageOptimizer.buildMultiRectImagePayload(
                        lastEnqueuedPacked, packed, width, height, baseFid, ConnectionOptions.MULTI_RECT_MAX_RECTS);
                    if (multi != null && multi.payload.length < single.payload.length) {
                        incrementalPayload = multi.payload;
                        nextImageFrameId = multi.nextFid;   // rectCount fids consumed
                        incrementalLog = "multi-rect update n=" + multi.rectCount
                            + " covered=" + multi.coveredBytes + "B"
                            + " payload=" + multi.payload.length + "B (vs bbox " + single.payload.length + "B)";
                    }
                }
            }
        }
        BleImageOptimizer.TileImagePlan plan = incrementalPayload != null
            ? new BleImageOptimizer.TileImagePlan(0, DASHBOARD_TILE, packed, width, height, nextMapSessionId(), incrementalPayload)
            : new BleImageOptimizer.TileImagePlan(0, DASHBOARD_TILE, packed, width, height, nextMapSessionId());
        plan.fragments = BleImageOptimizer.planImageFragments(plan.payload, ConnectionOptions.IMAGE_FRAGMENT_SIZE);
        FrameTimings.getInstance().spanEnd(frameId, "compress-and-plan");
        if (incrementalLog != null) {
            FrameTimings.getInstance().log(frameId, incrementalLog);
        }
        finishEnqueueDesiredImageLocked(plan, fingerprint, paintMs, frameId);
    }

    /** Shared tail of enqueueDesiredImageLocked: enqueue fragments, advance the delta base, log. */
    private void finishEnqueueDesiredImageLocked(
            BleImageOptimizer.TileImagePlan plan, String fingerprint, int paintMs, int frameId) {
        int updateId = nextImageUpdateId++;
        int messageCount = plan.fragments.size();
        imageUpdateStats.put(updateId, new BleImageOptimizer.ImageUpdateStats(paintMs, 1, frameId));
        for (int i = 0; i < plan.fragments.size(); i++) {
            BleProtocol.ImageFragment fragment = plan.fragments.get(i);
            enqueueImageFragmentLocked(plan, fragment, fingerprint, updateId, i + 1, messageCount, true);
        }
        // This frame is now the base for the next delta (it will be the firmware
        // shadow once applied), even though it hasn't been acked yet — that is what
        // lets the next frame pipeline behind it. plan.packed is the full frame;
        // frames are immutable by convention, so referencing it is safe.
        lastEnqueuedPacked = plan.packed;
        lastEnqueuedWidth = plan.width;
        lastEnqueuedHeight = plan.height;
        lastEnqueuedFingerprint = fingerprint;

        FrameTimings.getInstance().log(frameId, "queued image update#" + updateId
                + " messages=" + messageCount + " payload=" + plan.payload.length + "B");
        logLine("queue image update#" + updateId + " fingerprint=" + fingerprint
                + " messages=" + messageCount);
    }

    /**
     * Enqueue one mode-12 texture-cache upload ahead of the image message that
     * references its glyphs (the transport is FIFO, so no ack round trip is
     * needed before use). A timeout means the on-glasses cache state is
     * unknown; forget everything phone-side (glyphs re-upload lazily) and let
     * the accompanying image update's own timeout drive the frame resync.
     */
    private void enqueueTextureUploadLocked(byte[] payload) {
        OutboundMessage message = messageBuilder.imagePayload(
            "texcache",
            DASHBOARD_TILE,
            nextMapSessionId(),
            payload,
            "texture upload " + payload.length + "B",
            connectionOptions.sendImagesToLeft);
        message.onTimeout = () -> {
            textureCache.reset();
            logLine("texture upload ack timeout; texture cache state reset");
        };
        pendingMessages.addLast(message);
        logLine("queue " + message.label);
    }

    private void enqueueImageFragmentLocked(
        BleImageOptimizer.TileImagePlan plan,
        BleProtocol.ImageFragment fragment,
        String fingerprint,
        int updateId,
        int messageNumber,
        int messageCount,
        boolean requestAck
    ) {
        OutboundMessage message = messageBuilder.imageFragment(fragment, plan, requestAck, connectionOptions.sendImagesToLeft);
        message.setImageUpdatePosition(updateId, messageNumber, messageCount);
        message.onAck = () -> {
            imageRetryAfterMs = 0;
            // Firmware >= 2.2.4.34 resets its heartbeat timer when it receives
            // image messages (not just heartbeats), so an acked image fragment
            // satisfies the heartbeat deadline and heartbeats stop contending
            // with active rendering.
            lastHeartbeatAckedAtMs = SystemClock.elapsedRealtime();
            logImageUpdateAckLandmarkLocked(message);
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
            discardImageUpdateStatsLocked(message.imageUpdateId, "image ack timeout (will retry)");
            clearMessagesOfKindLocked("image");
            displayedFingerprint = "";
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
            BleProtocol.RingBatterySnapshot ring = BleProtocol.parseRingBattery(message.ackPayload);
            // Old firmware and missing/malformed extensions must clear any prior reading.
            ringBattery = ring == null ? -1 : ring.battery;
            ringCharging = ring == null ? -1 : ring.charging;
            BleProtocol.BatterySnapshot snapshot = BleProtocol.parseSettingsBattery(message.ackPayload);
            if (snapshot != null) {
                headsetBattery = snapshot.battery;
                headsetCharging = snapshot.charging;
                emitBatteryState(headsetBattery, headsetCharging);
                if (snapshot.silentMode >= 0) {
                    // Backstop for the push in onNotification: the firmware is
                    // confirmed to push silent-mode-on, but the off transition is
                    // not, so re-read the authoritative value on every poll.
                    updateSilentModeLocked(snapshot.silentMode > 0);
                }
                updateChargingModeLocked(snapshot.charging > 0, snapshot.battery);
            }
            BleProtocol.FirmwareInfo firmwareInfo = BleProtocol.parseSettingsFirmwareInfo(message.ackPayload);
            if (firmwareInfo != null) {
                customFirmwareDetected = firmwareInfo.isFaceclawFirmware();
                emitFirmwareInfo(firmwareInfo);
            }
        };
        message.onTimeout = () -> {
            logLine("Battery query timed out");
        };
        return message;
    }

    /**
     * Track silent mode, which the wearer toggles by long-pressing both
     * touchpads at once. While it is on the firmware refuses input events and
     * app launches and powers the display down, so the glasses look dead even
     * though the BLE session is healthy; the phone UI says so explicitly.
     */
    private void updateSilentModeLocked(boolean silent) {
        int next = silent ? 1 : 0;
        if (silentMode == next) {
            return;
        }
        silentMode = next;
        logLine(silent ? "glasses entered silent mode" : "glasses left silent mode");
        emitSilentMode(silent);
    }

    /**
     * Track whether the glasses are in the charging case. Charging means nobody
     * is wearing them: display communication pauses (no heartbeats, so the
     * firmware tears down its EvenHub context on its own) and only battery polls
     * continue. When charging stops, tear the transport down and let the normal
     * reconnect loop rebuild the session, layout, and first frame.
     */
    private void updateChargingModeLocked(boolean charging, int battery) {
        if (charging == chargingMode) {
            if (chargingMode) {
                setStateDisplay("charging", chargingStatusText(battery));
            }
            return;
        }
        if (charging) {
            chargingMode = true;
            clearAllMessagesLocked("glasses charging");
            fixedLayoutCreated = false;
            startupProbePending = false;
            displayedFingerprint = "";
            finishDesiredFrameLocked("discarded: glasses charging");
            logLine("glasses are charging; pausing display communication");
            setStateDisplay("charging", chargingStatusText(battery));
        } else {
            chargingMode = false;
            logLine("glasses removed from charger; reconnecting");
            handleTransportFailure("charging ended");
        }
    }

    private static String chargingStatusText(int battery) {
        return battery >= 0
            ? "Glasses charging. Battery " + battery + "%."
            : "Glasses charging.";
    }

    /**
     * Record, into the frame that is waiting, why it did not go out on this
     * pass of the send loop. Without this the export shows a bare multi-second
     * jump between "image submitted as desired frame" and the first BLE
     * packet, with no hint whether we were blocked on a heartbeat, the
     * BLE window, or another message queued ahead. Deduped on (frame, reason),
     * so a frame stalled for seconds gets one line per state change rather
     * than one per loop pass.
     */
    private void noteImageStallLocked(long now, boolean windowHasRoom) {
        int frameId;
        synchronized (desiredTilesLock) {
            frameId = desiredFrameId;
        }
        String reason;
        if (frameId != 0 && !getDesiredFingerprint().equals(lastEnqueuedFingerprint)) {
            reason = describeEnqueueBlockerLocked(now, windowHasRoom);
        } else {
            // Nothing waiting to be planned; an already-planned image may still
            // be queued behind other traffic.
            OutboundMessage queuedImage = firstPendingImageLocked();
            frameId = queuedImage == null ? 0 : imageUpdateFrameIdLocked(queuedImage.imageUpdateId);
            reason = queuedImage == null ? null : describeWriteBlockerLocked(now, windowHasRoom, queuedImage);
        }
        if (frameId == 0 || reason == null) {
            stallFrameId = 0;
            stallReason = "";
            return;
        }
        if (frameId == stallFrameId && reason.equals(stallReason)) {
            return;
        }
        stallFrameId = frameId;
        stallReason = reason;
        FrameTimings.getInstance().log(frameId, "waiting to send: " + reason);
    }

    /** Why the desired composite has not been turned into wire messages yet, or null. */
    private String describeEnqueueBlockerLocked(long now, boolean windowHasRoom) {
        if (shutdownRequested) {
            return "shutdown requested";
        }
        if (!sessionReady) {
            return "BLE session not ready";
        }
        if (!fixedLayoutCreated) {
            return "display layout not created yet";
        }
        if (now < imageRetryAfterMs) {
            return "image retry backoff (" + (imageRetryAfterMs - now) + "ms left)";
        }
        if (hasPendingImageLocked()) {
            return "an earlier image is still queued";
        }
        if (!windowHasRoom) {
            return "BLE window full (" + inFlightMessages.size() + " message(s) in flight)";
        }
        if (hasPendingOrInflightKindLocked("heartbeat")) {
            return "heartbeat in flight";
        }
        if (!pendingMessages.isEmpty()) {
            return pendingMessages.size() + " message(s) queued ahead, next "
                + pendingMessages.peekFirst().label;
        }
        return null;
    }

    /** Why a planned image message has not been written to BLE yet, or null. */
    private String describeWriteBlockerLocked(long now, boolean windowHasRoom, OutboundMessage queuedImage) {
        if (!sessionReady) {
            return "BLE session not ready";
        }
        if (!windowHasRoom) {
            return "BLE window full (" + inFlightMessages.size() + " message(s) in flight)";
        }
        if (hasPendingOrInflightKindLocked("heartbeat")) {
            return "heartbeat in flight";
        }
        // handleHeartbeat is a barrier: while one is due it holds back every
        // other write, so a frame queued at the wrong moment waits a heartbeat
        // round trip. Reported explicitly because it is otherwise invisible --
        // heartbeats belong to no frame.
        long heartbeatElapsedMs = now - lastHeartbeatAckedAtMs;
        if (fixedLayoutCreated && !shutdownRequested
                && heartbeatElapsedMs >= ConnectionOptions.HEARTBEAT_READY_MS) {
            return "heartbeat due (" + heartbeatElapsedMs + "ms since the last one acked)";
        }
        OutboundMessage head = pendingMessages.peekFirst();
        if (head != null && head != queuedImage) {
            return "queued behind " + head.label;
        }
        return null;
    }

    private OutboundMessage firstPendingImageLocked() {
        for (OutboundMessage message : pendingMessages) {
            if (message.imageUpdateId > 0) {
                return message;
            }
        }
        return null;
    }

    private int imageUpdateFrameIdLocked(int imageUpdateId) {
        BleImageOptimizer.ImageUpdateStats stats = imageUpdateStats.get(imageUpdateId);
        return stats == null ? 0 : stats.frameId;
    }

    private void finishDesiredFrameLocked(String outcome) {
        int frameIdToFinish;
        synchronized (desiredTilesLock) {
            frameIdToFinish = desiredFrameId;
            desiredFrameId = 0;
        }
        finishFrame(frameIdToFinish, outcome);
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

    /**
     * Replace any stale lease control with one right-arm and one left-arm
     * fire-and-forget write. With priority=true the right arm is sent first so
     * CLAIM reaches the lens that originated the deferred wake immediately.
     */
    private int enqueueFaceclawWakeControlLocked(int operation, int nonce, boolean priority) {
        clearMessagesOfKindLocked("wake-lease-control");
        final int generation = ++faceclawWakeControlGeneration;
        faceclawWakeControlSentCount = 0;
        if (operation == BleProtocol.FACECLAW_WAKE_OP_ACQUIRE) {
            lastFaceclawWakeLeaseQueuedAtMs = SystemClock.elapsedRealtime();
        }
        Runnable onSent = () -> {
            if (faceclawWakeControlGeneration == generation) {
                faceclawWakeControlSentCount += 1;
            }
        };
        OutboundMessage right = messageBuilder.faceclawWakeControl(operation, nonce, false);
        OutboundMessage left = messageBuilder.faceclawWakeControl(operation, nonce, true);
        right.onSent = onSent;
        left.onSent = onSent;
        if (priority) {
            pendingMessages.addFirst(left);
            pendingMessages.addFirst(right);
        } else {
            pendingMessages.addLast(right);
            pendingMessages.addLast(left);
        }
        logLine("queue " + right.label + " + L");
        return generation;
    }

    private boolean waitForFaceclawWakeControlDelivery(int generation, long timeoutMs) {
        long deadline = SystemClock.elapsedRealtime() + Math.max(0, timeoutMs);
        synchronized (lock) {
            while (running
                    && sessionReady
                    && faceclawWakeControlGeneration == generation
                    && faceclawWakeControlSentCount < 2) {
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
            return faceclawWakeControlGeneration == generation
                && faceclawWakeControlSentCount >= 2;
        }
    }

    /**
     * Acquire/renew or release CFW's independent direct-framebuffer repaint
     * guard on both arms. It is separate from the optional idle-wake lease:
     * every Faceclaw display session needs this guard while its EvenHub layout
     * contains swipe-capturing stock widgets.
     */
    private int enqueueFaceclawFramebufferControlLocked(int operation, boolean priority) {
        clearMessagesOfKindLocked("framebuffer-lease-control");
        final int generation = ++faceclawFramebufferControlGeneration;
        faceclawFramebufferControlSentCount = 0;
        if (operation == BleProtocol.FACECLAW_FB_OP_ACQUIRE) {
            lastFaceclawFramebufferLeaseQueuedAtMs = SystemClock.elapsedRealtime();
        }
        Runnable onSent = () -> {
            if (faceclawFramebufferControlGeneration == generation) {
                faceclawFramebufferControlSentCount += 1;
            }
        };
        OutboundMessage right = messageBuilder.faceclawFramebufferControl(operation, false);
        OutboundMessage left = messageBuilder.faceclawFramebufferControl(operation, true);
        right.onSent = onSent;
        left.onSent = onSent;
        if (priority) {
            pendingMessages.addFirst(left);
            pendingMessages.addFirst(right);
        } else {
            pendingMessages.addLast(right);
            pendingMessages.addLast(left);
        }
        logLine("queue " + right.label + " + L");
        return generation;
    }

    private boolean waitForFaceclawFramebufferControlDelivery(int generation, long timeoutMs) {
        long deadline = SystemClock.elapsedRealtime() + Math.max(0, timeoutMs);
        synchronized (lock) {
            while (running
                    && sessionReady
                    && faceclawFramebufferControlGeneration == generation
                    && faceclawFramebufferControlSentCount < 2) {
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
            return faceclawFramebufferControlGeneration == generation
                && faceclawFramebufferControlSentCount >= 2;
        }
    }

    private boolean releaseFaceclawFramebufferLease() {
        int generation;
        synchronized (lock) {
            if (!running || !sessionReady) {
                return true;
            }
            generation = enqueueFaceclawFramebufferControlLocked(
                BleProtocol.FACECLAW_FB_OP_RELEASE,
                true
            );
        }
        interruptibleSleep.interrupt();
        return waitForFaceclawFramebufferControlDelivery(
            generation,
            FACECLAW_WAKE_CONTROL_WAIT_MS
        );
    }

    private void clearMessagesOfKindLocked(String kind) {
        Iterator<OutboundMessage> pendingIterator = pendingMessages.iterator();
        while (pendingIterator.hasNext()) {
            OutboundMessage message = pendingIterator.next();
            if (kind.equals(message.kind)) {
                pendingIterator.remove();
                discardPrewriteIfMatchesLocked(message);
                if ("image".equals(kind)) {
                    discardImageUpdateStatsLocked(message.imageUpdateId, "pending messages cleared (" + kind + ")");
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
                    discardImageUpdateStatsLocked(message.imageUpdateId, "inflight messages cleared (" + kind + ")");
                }
                magicPool.release(message.sid, message.magic, message.label, "cleared inflight " + kind);
            }
        }
        if ("image".equals(kind)) {
            // The image pipeline was flushed (e.g. ack timeout -> keyframe resync):
            // drop the pipelined delta base so the next image is a full keyframe.
            lastEnqueuedPacked = new byte[0];
            lastEnqueuedFingerprint = "";
        }
    }

    private void clearAllMessagesLocked(String reason) {
        clearPendingMessagesLocked(reason);
        clearInFlightMessagesLocked(reason);
        // The image pipeline is gone: drop the pipelined delta base so the next
        // image is a full keyframe rather than a delta onto a stale base.
        lastEnqueuedPacked = new byte[0];
        lastEnqueuedFingerprint = "";
        // Queued texture uploads (if any) were dropped with the rest, and the
        // session churn behind a full clear may have freed the on-glasses
        // cache; forget it phone-side so glyphs re-upload lazily.
        textureCache.reset();
    }

    /**
     * A custom wake queues CLAIM before NativeScript asks for a resume. Keep
     * that private control while flushing stale EvenHub traffic around the
     * direct prelude write.
     */
    private void clearAllMessagesPreservingWakeLeaseLocked(String reason) {
        Iterator<OutboundMessage> pendingIterator = pendingMessages.iterator();
        while (pendingIterator.hasNext()) {
            OutboundMessage message = pendingIterator.next();
            if ("wake-lease-control".equals(message.kind)) {
                continue;
            }
            pendingIterator.remove();
            discardPrewriteIfMatchesLocked(message);
            discardImageUpdateStatsLocked(
                message.imageUpdateId,
                "pending messages cleared: " + reason
            );
            magicPool.release(
                message.sid,
                message.magic,
                message.label,
                "cleared pending: " + reason
            );
        }
        clearInFlightMessagesLocked(reason);
        lastEnqueuedPacked = new byte[0];
        lastEnqueuedFingerprint = "";
        textureCache.reset();
    }

    /** Any image update whose fragments are still queued (not yet sent). */
    private boolean hasPendingImageLocked() {
        for (OutboundMessage message : pendingMessages) {
            if ("image".equals(message.kind)) {
                return true;
            }
        }
        return false;
    }

    private void clearPendingMessagesLocked(String reason) {
        while (!pendingMessages.isEmpty()) {
            var message = pendingMessages.removeFirst();
            discardPrewriteIfMatchesLocked(message);
            discardImageUpdateStatsLocked(message.imageUpdateId, "pending messages cleared: " + reason);
            magicPool.release(message.sid, message.magic, message.label, "cleared pending: " + reason);
        }
    }

    private void clearInFlightMessagesLocked(String reason) {
        while (!inFlightMessages.isEmpty()) {
            var message = inFlightMessages.removeFirst();
            discardImageUpdateStatsLocked(message.imageUpdateId, "inflight messages cleared: " + reason);
            magicPool.release(message.sid, message.magic, message.label, "cleared inflight: " + reason);
        }
    }

    private void discardPrewriteIfMatchesLocked(OutboundMessage message) {
        if (message != null && message == prewrittenMessage) {
            prewrittenMessage = null;
            prewrittenFrames = Collections.emptyList();
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

    /** The address of a configured arm Android no longer holds a bond for, or null. */
    private String firstUnpairedArm() {
        if (!bleManager.isBonded(rightAddress)) return rightAddress;
        if (!bleManager.isBonded(leftAddress)) return leftAddress;
        return null;
    }

    /**
     * A connect failure while an arm's bond is missing (the pairing was
     * forgotten in Android settings, or the address was typed in by hand and
     * never paired) will repeat forever, so instead of scheduling a retry,
     * park the worker loop and tell the user to re-pair. Only an explicit
     * connect (which builds a fresh communicator) starts a new attempt.
     */
    private void handleUnpairedFailure(String address) {
        Log.e(TAG, "Connect failed and " + address + " is not paired; suspending reconnect");
        synchronized (lock) {
            reconnectHalted = true;
            sessionReady = false;
            fixedLayoutCreated = false;
            startupProbePending = false;
            shutdownRequested = false;
            chargingMode = false;
            imageRetryAfterMs = 0;
            displayedFingerprint = "";
            faceclawWakePendingNonce = -1;
            lastFaceclawWakeLeaseQueuedAtMs = 0;
            faceclawWakeControlSentCount = 0;
            clearAllMessagesLocked("arm not paired: " + address);
            reconnectAfterMs = Long.MAX_VALUE;
            bleManager.disconnect(rightAddress);
            bleManager.disconnect(leftAddress);
        }
        if (!userDisconnectRequested) {
            setStateDisplay(
                "unpaired",
                "The glasses (" + address + ") are not paired with this phone."
                    + " Use \"Pair glasses\" to pair them again, then connect."
            );
        }
        interruptibleSleep.interrupt();
    }

    private void handleTransportFailure(String reason) {
        Log.e(TAG, "Transport failure: "+reason);
        synchronized (lock) {
            maybeEmitEvenAppConflictLocked(reason);
            finishBenchmarkLocked(true, "transport failure");
            sessionReady = false;
            fixedLayoutCreated = false;
            startupProbePending = false;
            shutdownRequested = false;
            chargingMode = false;
            imageRetryAfterMs = 0;
            displayedFingerprint = "";
            faceclawWakePendingNonce = -1;
            lastFaceclawWakeLeaseQueuedAtMs = 0;
            faceclawWakeControlSentCount = 0;
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
        ringBattery = -1;
        ringCharging = -1;
        sessionReady = false;
        shutdownRequested = false;
        fixedLayoutCreated = false;
        chargingMode = false;
        rightConnected = false;
        leftConnected = false;
        ringConnected = false;
        ringNotificationsReady = false;
        reconnectAfterMs = 0;
        reconnectHalted = false;
        ringReconnectAfterMs = 0;
        lastAckAtMs = 0;
        lastIncomingAtMs = 0;
        lastHeartbeatSentAtMs = 0;
        lastSessionReadyAtMs = 0;
        consecutiveAckTimeouts = 0;
        lastAudioControlAckMagic = 0;
        audioCaptureActive = false;
        audioPacketListener = null;
        compassControlLastSent = -1;
        // A dead transport orphans any glasses-side compass state; the fresh
        // session re-asserts the desired state once its layout is ready.
        compassMaybeOn = false;
        faceclawWakePendingNonce = -1;
        lastFaceclawWakeLeaseQueuedAtMs = 0;
        faceclawWakeControlSentCount = 0;
        cfwCleanupDelivered = false;
        lastCfwCleanupAckMagic = 0;
        wearState = -1;
        displayedFingerprint = "";
        // Deliberately not clearing silentMode: it is a property of the glasses,
        // not of our session, and silent mode blocks app launches, so it can be
        // the very cause of the session teardown that got us here.
    }

    private void emitRingEvent(String kind, String containerName, int eventType, int eventSource, int systemExitReasonCode, int frameId) {
        final FaceclawBleCommunicatorListener current = listener;
        if (current == null) {
            FrameTimings.getInstance().finishFrame(frameId, "discarded: no listener attached");
            return;
        }
        final String containerNameSnapshot = containerName == null ? "" : containerName;
        mainHandler.post(() -> {
            FrameTimings.getInstance().log(frameId, "dispatching input event on main thread");
            try {
                current.onRingEvent(kind, containerNameSnapshot, eventType, eventSource, systemExitReasonCode, frameId);
            } catch (Throwable t) {
                Log.w(TAG, "listener onRingEvent failed", t);
                FrameTimings.getInstance().finishFrame(frameId, "discarded: listener onRingEvent failed");
            }
        });
    }

    /** Finish a frame owned by the communicator and tell the TS side, which may be awaiting it. */
    private void finishFrame(int frameId, String outcome) {
        if (frameId <= 0) {
            return;
        }
        FrameTimings.getInstance().finishFrame(frameId, outcome);
        final FaceclawBleCommunicatorListener current = listener;
        if (current == null) {
            return;
        }
        mainHandler.post(() -> {
            try {
                current.onFrameFinished(frameId, outcome);
            } catch (Throwable t) {
                Log.w(TAG, "listener onFrameFinished failed", t);
            }
        });
    }

    private void emitImuData(double x, double y, double z, int eventSource) {
        if (imuListeners.isEmpty()) {
            return;
        }
        mainHandler.post(() -> {
            for (FaceclawImuListener imuListener : imuListeners) {
                try {
                    imuListener.onImuData(x, y, z, eventSource);
                } catch (Throwable t) {
                    Log.w(TAG, "listener onImuData failed", t);
                }
            }
        });
    }

    private void emitCompassEvent(BleProtocol.CompassEvent event) {
        if (event.diagnosticFlags >= 0) {
            String[] sources = { "unknown", "GRV", "GMRV", "RV" };
            Log.i("FaceclawCompass", "heading=" + event.headingDegrees
                + " magneticAccuracy=" + event.magneticAccuracy
                + " magneticAnomalies=" + event.magneticAnomalies
                + " orientationSource=" + sources[event.orientationSource]
                + " flags=0x" + Integer.toHexString(event.diagnosticFlags)
                + " sampleTimeMs=" + event.sampleTimeMs);
        }
        for (CompassSubscription subscription : compassSubscriptions) {
            subscription.handler.post(() -> {
                try {
                    subscription.listener.onCompassEvent(event.command, event.headingDegrees,
                        event.magneticAccuracy, event.magneticAnomalies, event.orientationSource,
                        event.diagnosticFlags, event.sampleTimeMs);
                } catch (Throwable t) {
                    Log.w(TAG, "listener onCompassEvent failed", t);
                }
            });
        }
    }

    private void emitSilentMode(boolean silent) {
        final FaceclawBleCommunicatorListener current = listener;
        if (current == null) {
            return;
        }
        mainHandler.post(() -> {
            try {
                current.onSilentMode(silent);
            } catch (Throwable t) {
                Log.w(TAG, "listener onSilentMode failed", t);
            }
        });
    }

    private void emitWearState(boolean wearing) {
        final FaceclawBleCommunicatorListener current = listener;
        if (current == null) return;
        mainHandler.post(() -> {
            try {
                current.onWearState(wearing);
            } catch (Throwable t) {
                Log.w(TAG, "listener onWearState failed", t);
            }
        });
    }

    private void emitPhoneLockStateIfChanged(boolean force) {
        final boolean locked;
        synchronized (lock) {
            long now = SystemClock.elapsedRealtime();
            if (!force && now - lastPhoneLockCheckAtMs < 1_000) return;
            lastPhoneLockCheckAtMs = now;
            locked = keyguardManager != null && keyguardManager.isDeviceLocked();
            int value = locked ? 1 : 0;
            if (!force && value == phoneLockState) return;
            phoneLockState = value;
        }
        final FaceclawBleCommunicatorListener current = listener;
        if (current == null) return;
        mainHandler.post(() -> {
            try {
                current.onPhoneLockState(locked);
            } catch (Throwable t) {
                Log.w(TAG, "listener onPhoneLockState failed", t);
            }
        });
    }

    private void emitBatteryState(int headsetBattery, int headsetCharging) {
        final int reportedRingBattery = ringBattery;
        final int reportedRingCharging = ringCharging;
        final FaceclawBleCommunicatorListener current = listener;
        if (current == null) {
            return;
        }
        mainHandler.post(() -> {
            try {
                current.onBatteryState(headsetBattery, headsetCharging, reportedRingBattery, reportedRingCharging);
            } catch (Throwable t) {
                Log.w(TAG, "listener onBatteryState failed", t);
            }
        });
    }

    private void emitFirmwareInfo(BleProtocol.FirmwareInfo info) {
        final FaceclawBleCommunicatorListener current = listener;
        if (current == null) {
            return;
        }
        mainHandler.post(() -> {
            try {
                current.onFirmwareInfo(info.leftVersion, info.rightVersion, info.extension);
            } catch (Throwable t) {
                Log.w(TAG, "listener onFirmwareInfo failed", t);
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

    private void updateG2ScreenWakeLock(boolean screenOn) {
        if (screenOn) {
            if (g2ScreenWakeLock == null) {
                g2ScreenWakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, G2_SCREEN_WAKE_LOCK_TAG);
                g2ScreenWakeLock.setReferenceCounted(false);
            }
            if (!g2ScreenWakeLock.isHeld()) {
                g2ScreenWakeLock.acquire();
                logLine("G2 screen wake lock acquired");
            }
            return;
        }
        releaseG2ScreenWakeLock();
    }

    private void releaseG2ScreenWakeLock() {
        if (g2ScreenWakeLock != null && g2ScreenWakeLock.isHeld()) {
            g2ScreenWakeLock.release();
            logLine("G2 screen wake lock released");
        }
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

    private boolean hasRingAddress() {
        return ringAddress != null && !ringAddress.trim().isEmpty();
    }

    private boolean isConfiguredRingAddress(String address) {
        return hasRingAddress() && address != null && address.equalsIgnoreCase(ringAddress);
    }

    private boolean isDirectRingNotification(String address, String characteristicUuid) {
        if (!isConfiguredRingAddress(address) || characteristicUuid == null) {
            return false;
        }
        return BleProtocol.R1_PHONE_NOTIFY_CHAR_UUID.equals(characteristicUuid)
            || BleProtocol.R1_NOTIFY_CHAR_UUID.equals(characteristicUuid);
    }

    private static String hex(byte[] data) {
        if (data == null || data.length == 0) {
            return "";
        }
        char[] out = new char[data.length * 2];
        char[] digits = "0123456789abcdef".toCharArray();
        for (int i = 0; i < data.length; i++) {
            int value = data[i] & 0xff;
            out[i * 2] = digits[value >>> 4];
            out[i * 2 + 1] = digits[value & 0x0f];
        }
        return new String(out);
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
