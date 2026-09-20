package com.faceclaw.app

import kotlin.jvm.JvmField

class ConnectionOptions {
    companion object {
        @JvmField val WRITE_MODE = GattWriteMode.WITHOUT_RESPONSE
        const val DESIRED_MTU = 512

        const val CONNECT_TIMEOUT_MS = 5_000
        const val SERVICES_TIMEOUT_MS = 5_000
        const val DESCRIPTOR_TIMEOUT_MS = 5_000
        const val RING_DESIRED_MTU = 247
        const val RING_RECONNECT_DELAY_MS = 2_000
        const val WRITE_TIMEOUT_MS = 2_000
        const val PRELUDE_TIMEOUT_MS = 2_000
        // Application security-auth exchange (sid 0x80). The success notification
        // only arrives once the BLE link is encrypted, which on a first-time
        // connection means SMP pairing — possibly with an OS dialog the user has
        // to accept — so the stock-firmware paths wait generously.
        const val SECURITY_AUTH_TIMEOUT_MS = 30_000
        // The main communicator's wait is soft (it proceeds on timeout so firmware
        // that never answers can't stall every reconnect), so it is kept short.
        const val SECURITY_AUTH_SOFT_TIMEOUT_MS = 6_000
        const val ACK_TIMEOUT_MS = 3_500
        const val HEARTBEAT_FAILURE_DEADLINE_MS = 10_000
        const val HEARTBEAT_READY_MS = 4_000
        const val HEARTBEAT_URGENT_MS = 6_000
        const val BATTERY_REFRESH_INTERVAL_MS = 5 * 60_000
        const val BATTERY_INPUT_QUIET_MS = 5_000
        // Poll cadence while in charging mode; also bounds how quickly we notice
        // the glasses coming back out of the case.
        const val CHARGING_BATTERY_POLL_MS = 30_000
        const val IMAGE_FRAGMENT_SIZE = 3800
        const val IMAGE_RETRY_DELAY_MS = 2_000
        const val MAX_CONSECUTIVE_ACK_TIMEOUTS = 8
        const val EVEN_APP_WRITE_FAILURE_WINDOW_MS = 15_000
        const val IDLE_SLEEP_MS = 100
        const val RECONNECT_DELAY_MS = 2_000
        // Cap on rects per batch. Each rect consumes a distinct CFW frame id, and the
        // firmware's duplicate-fid ring holds 16, so keep several batches of history
        // within it. Above this the split is abandoned for a single bounding box.
        const val MULTI_RECT_MAX_RECTS = 6
        // Don't bother splitting when the single bounding box already compresses this
        // small (one tight rect); only attempt multi-rect above it or when the box
        // spans multiple horizontal clusters.
        const val MULTI_RECT_MIN_PAYLOAD = 900
    }

    @JvmField val sendImagesToLeft = true
    @JvmField val skipSessionIds = true
    // Max messages in flight (awaiting ack) at once — full pipelining. >1 lets a
    // frame be sent before the previous frame's ack returns, hiding the BLE ack
    // round-trip that otherwise serialized every update. Requires firmware that
    // accepts pipelined image messages (the CFW snapshot/deferred FIFO). At 1 the
    // communicator behaves exactly as before (serial sends + last-packet prewrite).
    @JvmField val WINDOW_SIZE = 3
    // Send changed-region (mode 3 bounding box) updates instead of full frames
    // when the previous frame is known to be displayed. Requires firmware with
    // the experimental bbox-incremental mode. Disabled: the firmware-side
    // display buffer is not always the previous frame (occasionally two frames
    // back, apparently display-driver buffer swapping), so partial updates
    // composite onto stale content per-lens. Re-enable once the firmware
    // guarantees the compositing base.
    @JvmField val INCREMENTAL_FRAMES = true

    // Send several tight rectangle deltas as one CFW mode-8 multi-segment message
    // instead of a single bounding box, when the change splits into regions whose
    // bounding box wastes bytes (distant edits, or a sparse box). Requires firmware
    // with mode-8 multi-rect support; needs INCREMENTAL_FRAMES (same seeded shadow).
    // Falls back to the single bounding box whenever multi-rect isn't smaller.
    @JvmField val MULTI_RECT_FRAMES = true

    // Ship text as on-glasses cached-glyph draws (CFW modes 12/14) instead of
    // pixels, punching glyph ink out of the baked deltas (see TexturePlanner).
    // Also gated at runtime on the firmware advertising texcache12 + texstr14.
    @JvmField val TEXTURE_CACHE_FRAMES = true
}
