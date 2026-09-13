package com.faceclaw.app;
import android.bluetooth.BluetoothGattCharacteristic;

public class ConnectionOptions {
    public static final int WRITE_TYPE = BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE;
    public static final int DESIRED_MTU = 512;

    public static final int CONNECT_TIMEOUT_MS = 5_000;
    public static final int SERVICES_TIMEOUT_MS = 5_000;
    public static final int DESCRIPTOR_TIMEOUT_MS = 5_000;
    public static final int RING_DESIRED_MTU = 247;
    public static final int RING_RECONNECT_DELAY_MS = 2_000;
    // The ring connects with autoConnect=true (see FaceclawBleManager.connect's
    // 3-arg overload) - Android manages that as a background reconnect rather
    // than an immediate attempt, so it needs far more room than the glasses'
    // direct-connect CONNECT_TIMEOUT_MS. Untuned guess, not measured.
    public static final int RING_CONNECT_TIMEOUT_MS = 20_000;
    public static final int WRITE_TIMEOUT_MS = 2_000;
    public static final int PRELUDE_TIMEOUT_MS = 2_000;
    // Application security-auth exchange (sid 0x80). The success notification
    // only arrives once the BLE link is encrypted, which on a first-time
    // connection means SMP pairing — possibly with an OS dialog the user has
    // to accept — so the stock-firmware paths wait generously.
    public static final int SECURITY_AUTH_TIMEOUT_MS = 30_000;
    // The main communicator's wait is soft (it proceeds on timeout so firmware
    // that never answers can't stall every reconnect), so it is kept short.
    public static final int SECURITY_AUTH_SOFT_TIMEOUT_MS = 6_000;
    public static final int ACK_TIMEOUT_MS = 3_500;
    public static final int HEARTBEAT_FAILURE_DEADLINE_MS = 10_000;
    public static final int HEARTBEAT_READY_MS = 4_000;
    public static final int HEARTBEAT_URGENT_MS = 6_000;
    public static final int BATTERY_REFRESH_INTERVAL_MS = 5 * 60_000;
    public static final int BATTERY_INPUT_QUIET_MS = 5_000;
    // Poll cadence while in charging mode; also bounds how quickly we notice
    // the glasses coming back out of the case.
    public static final int CHARGING_BATTERY_POLL_MS = 30_000;
    public static final int IMAGE_FRAGMENT_SIZE = 3800;
    public static final int IMAGE_RETRY_DELAY_MS = 2_000;
    public static final int MAX_CONSECUTIVE_ACK_TIMEOUTS = 8;
    public static final int EVEN_APP_WRITE_FAILURE_WINDOW_MS = 15_000;
    public static final int IDLE_SLEEP_MS = 100;
    public static final int RECONNECT_DELAY_MS = 2_000;

    final boolean sendImagesToLeft = true;
    final boolean skipSessionIds = true;
    // Max messages in flight (awaiting ack) at once — full pipelining. >1 lets a
    // frame be sent before the previous frame's ack returns, hiding the BLE ack
    // round-trip that otherwise serialized every update. Requires firmware that
    // accepts pipelined image messages (the CFW snapshot/deferred FIFO). At 1 the
    // communicator behaves exactly as before (serial sends + last-packet prewrite).
    final int WINDOW_SIZE = 3;
    // Send changed-region (mode 3 bounding box) updates instead of full frames
    // when the previous frame is known to be displayed. Requires firmware with
    // the experimental bbox-incremental mode. Disabled: the firmware-side
    // display buffer is not always the previous frame (occasionally two frames
    // back, apparently display-driver buffer swapping), so partial updates
    // composite onto stale content per-lens. Re-enable once the firmware
    // guarantees the compositing base.
    final boolean INCREMENTAL_FRAMES = true;

    // Send several tight rectangle deltas as one CFW mode-8 multi-segment message
    // instead of a single bounding box, when the change splits into regions whose
    // bounding box wastes bytes (distant edits, or a sparse box). Requires firmware
    // with mode-8 multi-rect support; needs INCREMENTAL_FRAMES (same seeded shadow).
    // Falls back to the single bounding box whenever multi-rect isn't smaller.
    final boolean MULTI_RECT_FRAMES = true;
    // Cap on rects per batch. Each rect consumes a distinct CFW frame id, and the
    // firmware's duplicate-fid ring holds 16, so keep several batches of history
    // within it. Above this the split is abandoned for a single bounding box.
    public static final int MULTI_RECT_MAX_RECTS = 6;
    // Don't bother splitting when the single bounding box already compresses this
    // small (one tight rect); only attempt multi-rect above it or when the box
    // spans multiple horizontal clusters.
    public static final int MULTI_RECT_MIN_PAYLOAD = 900;

    // Ship text as on-glasses cached-glyph draws (CFW modes 12/14) instead of
    // pixels, punching glyph ink out of the baked deltas (see TexturePlanner).
    // Also gated at runtime on the firmware advertising texcache12 + texstr14.
    final boolean TEXTURE_CACHE_FRAMES = true;
}
