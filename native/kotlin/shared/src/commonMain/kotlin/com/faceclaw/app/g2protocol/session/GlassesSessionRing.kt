package com.faceclaw.app

/**
 * The direct R1 ring link: its dedicated worker, the health-data protocol
 * (RingProtocol) branch of the notification path, and the response-driven
 * health pull. Extension functions on [GlassesSessionCore] like the sibling
 * GlassesSessionSend.kt / GlassesSessionControls.kt; the state lives in the
 * core's class body.
 */

/**
 * Cap on decoded ring health pages held in memory. A full backlog sync is
 * ~40 pages, so this holds several syncs; oldest is dropped first. This is a
 * holding area until TypeScript ingests the records, not storage.
 */
private const val RING_HEALTH_MAX_RECORDS = 256

/**
 * Floor between health pulls, independent of how often the ring
 * reconnects. Heart rate/HRV/SpO2 update hourly at the source and steps
 * every 10 minutes (confirmed from the real export,
 * `knowledge/inbox/Even_health_data/`).
 *
 * **Reduced 30min -> 5min on 2026-09-12, and its JOB CHANGED.** The
 * 30-minute figure was always meant as a CADENCE - how often to collect -
 * but it was implemented here as a floor, which is a different thing. The
 * result was that a connected, stable ring pulled *never*: nothing
 * drives a pull on a timer, only `onRingReady()` on reconnect, so the
 * floor was the only clock in the system and it gated a pull that had
 * nothing to trigger it.
 *
 * The cadence now lives where it belongs, on a wall-clock-aligned tick
 * (:01 and :31) in `health-live.ts`. What remains here is purely an
 * ANTI-SPAM floor: stop a burst of reconnects turning into a burst of
 * requests against the race documented on [requestRingHealth].
 * That job needs 5 minutes, not 30.
 */
private const val RING_HEALTH_MIN_PULL_INTERVAL_MS = 5L * 60L * 1000L

/**
 * Floor for a pull the user actually asked for by opening the health app,
 * as opposed to the automatic one above.
 *
 * Deliberately much shorter than the automatic interval but **not
 * zero**. An automatic pull is speculative — nobody is waiting for it, so
 * there is no reason to spend a request. Opening the health app is the
 * opposite: it is an explicit ask, and the response-driven
 * [requestRingHealth] waits for each type's DATA and ACKs its pages before
 * advancing, which is what made the backlog-discard race survivable in the
 * first place. A floor still has to exist, because the discard risk
 * documented on `requestRingHealth()` is real and open/close/open would
 * otherwise hammer the ring.
 */
private const val RING_HEALTH_ON_DEMAND_MIN_INTERVAL_MS = 60L * 1000L

/**
 * How many times a pull that ABORTED may be resumed inside the anti-spam
 * floor before it goes back to waiting that floor out.
 *
 * The floor exists to stop SPECULATIVE repeat pulls, because a request
 * that loses its race can permanently consume backlog - see
 * [requestRingHealth]. Resuming a pull that never got a single answer is a
 * different thing: nothing was ever in flight to be lost.
 *
 * Measured 2026-09-12: the 09:33 pull got `no RSP` for 0x1, 0x4
 * and 0x2 and then died on `write error: IllegalStateException: Not
 * connected`. Every attempt after it was refused by the 30-minute floor, so
 * the rest of that night's data was simply never requested again - the
 * night's second sleep block went with it. The floor was protecting against
 * the wrong thing.
 *
 * Bounded and non-looping on purpose: the budget is spent whether or not
 * the retries help, and a pull that completes resets it. Worst case is two
 * extra attempts, then silence until the floor expires.
 *
 * ⚠ UNTESTED, and worth knowing before trusting this: whether an aborted
 * pull's data is still on the ring at all, or was discarded when the ring
 * RSP'd (it did not RSP here, which is the reason to think it survives).
 * Nobody knows. The retry costs little if the data is gone.
 */
private const val RING_HEALTH_ABORTED_RETRY_LIMIT = 2

/**
 * Gap before an aborted pull may be resumed. Short, but not zero - a link
 * that just failed a write needs time to come back, and a tight loop
 * against a dead connection helps nobody.
 */
private const val RING_HEALTH_ABORTED_RETRY_GAP_MS = 60L * 1000L

/**
 * Device-channel commands Even's real app fires in the gaps between
 * health requests - identity (0x0a), battery (0x01), firmware version
 * (0x02), device id (0x0b) - found by extracting the literal wire order
 * of a real successful sync (same capture as ringHealthRspTimeoutMs; two
 * independent syncs in it agree). Rotated one-per-health-type here rather
 * than replicated exactly (Even's real cadence isn't perfectly regular
 * either - compare the two syncs in the capture), since which of these,
 * if any, is actually load-bearing for the ring answering has never
 * been isolated. This is matching cadence, not a confirmed protocol
 * requirement.
 */
private val RING_DEVICE_PING_CMD_LO = intArrayOf(0x0a, 0x01, 0x02, 0x0b)

/** The opaque blob Even sends with every device-channel 0x0a request (f8f53d235ac4ceaa073885cc). */
private val RING_IDENTITY_BLOB: ByteArray = "f8f53d235ac4ceaa073885cc".chunked(2).map { it.toInt(16).toByte() }.toByteArray()

/**
 * A snapshot of the health buffer together with the watermark identifying
 * it.
 *
 * The two have to come out under ONE lock. Reading the list and the
 * count separately would let a page land in between, and the consumer would
 * then clear a record nothing had ingested - the exact failure the
 * watermark exists to prevent.
 */
class RingHealthBatch internal constructor(
    val records: List<RingProtocol.HealthRecord>,
    /** Total-ever-added at the instant of the snapshot. */
    val watermark: Long,
)

/** Sole owner of blocking ring operations; callbacks only enqueue ACKs. */
internal fun GlassesSessionCore.runRingWorker() {
    while (running) {
        try {
            if (shouldAttemptRingConnect()) tryConnectRing("ring worker")
            if (!running) break
            flushRingOutbound()
            runRequestedRingHealthPull()
            resumeAbortedRingHealthPull()
            monitor.withLock {
                if (running) monitor.awaitMs(100)
            }
        } catch (t: Throwable) {
            if (!running) {
                // disconnect() interrupted a blocking wait; nothing to recover.
                break
            }
            logLine("ring worker error: " + GlassesSessionCore.safeMessage(t))
            // A ring failure must not tear down the glasses session.
            monitor.withLock {
                ringConnected = false
                ringNotificationsReady = false
                ringReconnectAfterMs = now() + ConnectionOptions.RING_RECONNECT_DELAY_MS
            }
            link.disconnect(ringAddress)
        }
    }
    logLine("ring worker stop")
}

/**
 * The R1 health-data protocol branch. Returns true when the value belonged
 * to that protocol and must not fall through to the gesture decoder.
 *
 * Runs on the GATT callback thread, so it only ever queues writes.
 *
 * Restricted to R1_NOTIFY_CHAR_UUID because that is the notify
 * characteristic (ATT handle 0x0017) the reference capture shows this
 * protocol on; gesture traffic on the other notify characteristic is left
 * strictly alone rather than being offered to the reassembler.
 */
internal fun GlassesSessionCore.handleRingHealthNotification(characteristicUuid: String, data: ByteArray): Boolean {
    if (BleProtocol.R1_NOTIFY_CHAR_UUID != characteristicUuid || !host.supportsRingHealth()) {
        return false
    }

    val intake = monitor.withLock { ringReassembler.accept(data) }
    if (!intake.consumed) {
        return false
    }

    val arrivalMs = now()
    monitor.withLock {
        lastIncomingAtMs = arrivalMs
    }
    if (intake.note != null) {
        logLine("ring frame: " + intake.note)
    }
    val frame = intake.frame
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
        logLine("ring frame: consumed, no complete frame yet, len=" + data.size)
        return true
    }
    if (!frame.crcOk) {
        // Never act on a frame whose CRC failed: the payload offsets below
        // are only meaningful for an intact frame.
        logLine("ring frame CRC mismatch " + frame.describe())
        return true
    }

    // Keep the original bytes before acknowledging them. Ring firmware
    // variants can have layouts we cannot decode yet, and the ring may
    // never deliver an acknowledged page again. This private journal also
    // lets us diagnose a new device without repeatedly draining its data.
    if (!journalRingFrame(frame)) return true

    // Route on the CHAN byte, not on the shape of the payload.
    if (frame.chan != RingProtocol.CHAN_HEALTH) {
        val status = RingProtocol.decodeDeviceStatus(frame)
        if (status != null) {
            monitor.withLock {
                directRingBattery = status.battery
                directRingCharging = status.charging
                emitBatteryState(headsetBattery, headsetCharging)
            }
            logLine("direct ring battery " + status.battery + "% charging=" + status.charging)
        }
        logDebug("ring device frame " + frame.describe())
        return true
    }

    if (frame.kind == RingProtocol.KIND_RSP) {
        logDebug("ring health rsp " + frame.describe())
        monitor.withLock {
            ringHealthRspSeen = true
            monitor.signalAll()
        }
        return true
    }
    if (frame.kind != RingProtocol.KIND_DATA) {
        logDebug("ring health frame " + frame.describe())
        return true
    }

    var record: RingProtocol.HealthRecord? = null
    try {
        record = RingProtocol.decode(frame, currentTimeMillis())
    } catch (t: Throwable) {
        logLine("ring health decode error " + frame.describe() + ": " + GlassesSessionCore.safeMessage(t))
    }
    if (record == null) {
        logLine("ring health page undecoded " + frame.describe())
    } else {
        monitor.withLock {
            if (ringHealthRecords.size >= RING_HEALTH_MAX_RECORDS) {
                // This was silent. An eviction here drops a record that
                // nothing has ingested yet - real data lost inside the
                // phone, with no trace anywhere. Say so. With the consume
                // path in place the buffer should never reach this size;
                // if this line ever appears, the consumer has stopped.
                logLine("ring health: buffer FULL at " + RING_HEALTH_MAX_RECORDS
                    + " - dropping the oldest UNINGESTED record")
                ringHealthRecords.removeAt(0)
            }
            ringHealthRecords.add(record)
            ringHealthTotalAdded++
        }
        logLine("ring health " + record.summary())
    }

    // Acknowledge the page regardless of whether we could decode it: the
    // ACK is what keeps the ring sending, and a decode gap must not stall
    // the rest of the transfer.
    queueRingPageAck(frame)
    return true
}

internal fun GlassesSessionCore.queueRingPageAck(page: RingProtocol.Frame) {
    monitor.withLock {
        if (!ringNotificationsReady) {
            return
        }
        val ack = RingProtocol.buildPageAck(
            nextRingSeqLocked(),
            nextRingNonceLocked(),
            page.cmdHi,
            page.cmdLo,
            page.seq
        )
        ringOutbound.addLast(ack)
        ringHealthPageCounter++
        // Wakes the ring worker, independently of the glasses.
        monitor.signalAll()
    }
}

internal fun GlassesSessionCore.journalRingFrame(frame: RingProtocol.Frame): Boolean {
    return try {
        host.appendRingFrameJournal(
            "\n{\"receivedAtMs\":" + currentTimeMillis() + ",\"raw\":\"" + GlassesSessionCore.hex(frame.raw) + "\"}\n")
        true
    } catch (error: Throwable) {
        logLine("ring frame persistence failed; page not acknowledged: " + GlassesSessionCore.safeMessage(error))
        false
    }
}

/**
 * The ring's data channel is subscribed: send the device-channel handshake,
 * then run a health pull unless the anti-spam floor says one ran recently.
 * Ring worker only (blocking).
 */
internal fun GlassesSessionCore.onRingDataChannelReady() {
    // The handshake mirrors what Even's own app repeats on every one
    // of its sync bursts (confirmed in the reference capture), so
    // sending it on every reconnect matches known-working behavior.
    // The actual health pull is throttled separately below - see
    // ringHealthLastRequestedAtMs and requestRingHealth()'s own
    // race-condition warning for why.
    sendRingHandshake()
    val now = now()
    val dueForHealthPull: Boolean
    val lastRequestedAtMs: Long
    monitor.withLock {
        lastRequestedAtMs = ringHealthLastRequestedAtMs
        dueForHealthPull = ringHealthPullDueLocked(now)
        if (dueForHealthPull) {
            ringHealthLastRequestedAtMs = now
        }
    }
    if (dueForHealthPull) {
        runRingHealthPull()
    } else {
        logLine("ring health: pull skipped, last one was " + ((now - lastRequestedAtMs) / 1000) + "s ago")
    }
}

/**
 * Whether an automatic pull may run now. Caller must hold `monitor`.
 *
 * Two ways to be due: the ordinary anti-spam floor has expired, or the
 * last pull ABORTED and still has retry budget. The second is not a
 * speculative repeat - see RING_HEALTH_ABORTED_RETRY_LIMIT.
 */
internal fun GlassesSessionCore.ringHealthPullDueLocked(now: Long): Boolean {
    if (ringHealthLastRequestedAtMs == 0L) {
        return true
    }
    val since = now - ringHealthLastRequestedAtMs
    if (since >= RING_HEALTH_MIN_PULL_INTERVAL_MS) {
        return true
    }
    return ringHealthAbortedRetries > 0 && since >= RING_HEALTH_ABORTED_RETRY_GAP_MS
}

/**
 * Run a pull and account for whether it finished. The ONLY place
 * [requestRingHealth] may be called from, so that every path shares one
 * definition of "aborted".
 */
internal fun GlassesSessionCore.runRingHealthPull() {
    val completed = requestRingHealth()
    monitor.withLock {
        if (completed) {
            ringHealthAbortedRetries = 0
        } else if (ringHealthAbortedRetries < RING_HEALTH_ABORTED_RETRY_LIMIT) {
            ringHealthAbortedRetries++
            logLine("ring health: aborted pull may resume in "
                + (RING_HEALTH_ABORTED_RETRY_GAP_MS / 1000L) + "s (retry "
                + ringHealthAbortedRetries + "/" + RING_HEALTH_ABORTED_RETRY_LIMIT + ")")
        } else {
            ringHealthAbortedRetries = 0
            logLine("ring health: aborted pull retry budget spent, back to the "
                + (RING_HEALTH_MIN_PULL_INTERVAL_MS / 60000L) + "-minute anti-spam floor")
        }
    }
}

/**
 * Ring-worker tick that resumes a pull which ABORTED.
 *
 * Distinct from [runRequestedRingHealthPull]: nobody asked for this one. It
 * exists because the automatic pull otherwise only fires from the ring-ready
 * path, so an abort that is not followed by a reconnect would never be
 * retried at all.
 */
internal fun GlassesSessionCore.resumeAbortedRingHealthPull() {
    val now = now()
    monitor.withLock {
        if (ringHealthAbortedRetries == 0) {
            return
        }
        if (!ringConnected || !ringNotificationsReady) {
            return
        }
        if (now - ringHealthLastRequestedAtMs < RING_HEALTH_ABORTED_RETRY_GAP_MS) {
            return
        }
        ringHealthLastRequestedAtMs = now
    }
    logLine("ring health: resuming an aborted pull")
    runRingHealthPull()
}

/** Ring-worker side of [GlassesSessionCore.requestRingHealthNow]. */
internal fun GlassesSessionCore.runRequestedRingHealthPull() {
    val now = now()
    monitor.withLock {
        if (!ringHealthPullRequested) {
            return
        }
        ringHealthPullRequested = false
        if (!ringConnected || !ringNotificationsReady) {
            logLine("ring health: on-demand pull skipped, ring not ready")
            return
        }
        if (ringHealthLastRequestedAtMs != 0L
                && now - ringHealthLastRequestedAtMs < RING_HEALTH_ON_DEMAND_MIN_INTERVAL_MS) {
            logLine("ring health: on-demand pull skipped, last one was "
                + ((now - ringHealthLastRequestedAtMs) / 1000) + "s ago")
            return
        }
        ringHealthLastRequestedAtMs = now
    }
    logLine("ring health: on-demand pull requested")
    runRingHealthPull()
}

/**
 * Device-channel initialization. 00:0e enables health recording; 00:05 sets
 * the clock (signed timezone minutes plus Unix seconds).
 *
 * The inherited extra timezone shift is WRONG: on this PDT ring, fresh HR
 * timestamps track receipt time + 7h. Firmware expects UTC seconds and
 * applies the timezone separately. Do not simply deploy a seven-hour
 * rewind: stock firmware can format its health database on a backward
 * jump >= 1h. Existing pages also contain mixed clock domains and invalid
 * daily anchors, so their dates cannot be repaired by one subtraction.
 *
 * TODO: controlled UTC migration after preserving ring history. Retain the
 * existing wire behavior until that migration is authorized and validated.
 * See notes/ring-health-live-validation.md for evidence and the next test.
 */
internal fun GlassesSessionCore.sendRingHandshake() {
    val nowMs = currentTimeMillis()
    val utcOffsetMs = localUtcOffsetMs(nowMs)
    val clockOffsetSeconds = -utcOffsetMs / 1000L
    val liveClockSeconds = (nowMs / 1000L) + clockOffsetSeconds
    logLine("ring handshake legacy clock offset seconds = " + clockOffsetSeconds
        + " (tz " + localTimeZoneId() + ")")
    val clock = le32(liveClockSeconds)

    val seqs = IntArray(7)
    val nonces = IntArray(7)
    monitor.withLock {
        for (i in 0 until 7) {
            seqs[i] = nextRingSeqLocked()
            nonces[i] = nextRingNonceLocked()
        }
    }

    val frames = arrayOf(
        RingProtocol.buildFrame(RingProtocol.CHAN_DEVICE, RingProtocol.KIND_REQ, 0x00, 0x08, seqs[0],
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
            byteArrayOf(0x3f, 0x01, 0x01)),
        RingProtocol.buildFrame(RingProtocol.CHAN_DEVICE, RingProtocol.KIND_DATA, 0x00, 0x0e, seqs[1],
            le16(nonces[1]) + clock + byteArrayOf(0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00)),
        RingProtocol.buildFrame(RingProtocol.CHAN_DEVICE, RingProtocol.KIND_DATA, 0x00, 0x05, seqs[2],
            le16(nonces[2]) + le16(utcOffsetMs / 60000) + clock),
        // Battery, firmware version, device id - all bare nonce-only REQs,
        // same shape as the health requests.
        RingProtocol.buildFrame(RingProtocol.CHAN_DEVICE, RingProtocol.KIND_REQ, 0x00, 0x01, seqs[3],
            le16(nonces[3])),
        RingProtocol.buildFrame(RingProtocol.CHAN_DEVICE, RingProtocol.KIND_REQ, 0x00, 0x02, seqs[4],
            le16(nonces[4])),
        RingProtocol.buildFrame(RingProtocol.CHAN_DEVICE, RingProtocol.KIND_REQ, 0x00, 0x0b, seqs[5],
            le16(nonces[5])),
        RingProtocol.buildFrame(RingProtocol.CHAN_DEVICE, RingProtocol.KIND_REQ, 0x00, 0x0a, seqs[6],
            le16(nonces[6]) + RING_IDENTITY_BLOB),
    )
    for (frame in frames) {
        if (!writeRingFrame(frame, "handshake")) {
            return
        }
    }
    logLine("ring health: sent device-channel handshake (" + frames.size + " frames)")
}

private fun le16(value: Int): ByteArray = byteArrayOf(value.toByte(), (value ushr 8).toByte())

private fun le32(value: Long): ByteArray =
    byteArrayOf(value.toByte(), (value ushr 8).toByte(), (value ushr 16).toByte(), (value ushr 24).toByte())

/**
 * Pull the five health record types. Each request is a bare 17-byte frame
 * carrying only a nonce; the ring answers with an RSP on the same
 * sequence number, then - sometimes - pushes one or more DATA pages,
 * which arrive through [handleRingHealthNotification].
 *
 * **Response-driven, not sleep-driven (rewritten 2026-09-11).**
 * The original version fired all five REQs on a blind fixed sleep and
 * only flushed queued page ACKs after the whole loop finished - a real
 * successful Even sync does the opposite: it waits for each REQ's own RSP,
 * waits for DATA to go idle, ACKs immediately, then interleaves one
 * device-channel command before the next health type. This version does
 * the same, using the monitor's await/signalAll idiom already used
 * elsewhere in the session.
 *
 * **Race condition, confirmed live 2026-09-10 - this is what the
 * rewrite above addresses, not a reason to remove this warning.** The
 * ring appears to hold only one health type's response in flight at a
 * time. Sending the next health REQ before the previous type's DATA
 * page(s) have actually arrived silently drops the earlier type's DATA:
 * you still get its RSP, you never get its DATA, and nothing in the
 * protocol signals an error. Evidence: five REQs fired back-to-back (the
 * old blind-sleep version, badly timed) got five RSPs and zero DATA
 * pages over more than a minute of waiting.
 *
 * **Worse: a lost race may PERMANENTLY discard that backlog, not
 * just delay it.** On 2026-09-10, real HRV/SpO2/sleep backlog that
 * should have existed (unreported since that morning, confirmed against
 * the hourly export cadence in `knowledge/inbox/Even_health_data`)
 * did not come back on a later, more carefully spaced retry. The working
 * theory - not proven, but treat it as true until disproven, because the
 * downside of being wrong is silent data loss with nothing to catch it
 * - is that the ring advances its own "last delivered" watermark for a
 * type as soon as it RSPs a REQ for it, whether or not the DATA page
 * actually made it out. **Do not send a speculative or test health REQ
 * for a type unless you intend to actually receive and persist its
 * DATA** - re-requesting will not recover what an earlier, raced
 * request already consumed. Waiting for DATA to go idle before advancing
 * reduces how often this can happen but does not prove it can no longer
 * happen (e.g. if the ring's real per-type timeout is shorter than
 * ringHealthDataIdleMs for some type).
 *
 * A separate, completely ordinary case looks identical from the wire
 * alone: an RSP with no DATA can also just mean the ring genuinely has
 * nothing new for that metric since the last successful pull. There is
 * currently no way to tell "raced and silently discarded" apart from
 * "genuinely nothing new" other than knowing independently whether fresh
 * data should exist (e.g. from the export's own sampling cadence).
 *
 * Runs on the ring worker, which is the only thread allowed to call the
 * blocking write path - the wait loops below block that same thread, which
 * is why [flushRingOutbound] is called inside the response and DATA waits
 * rather than relying on the ring loop's own call to it.
 */
internal fun GlassesSessionCore.requestRingHealth(): Boolean {
    // A previous attempt may have left an ACK queued after a failed write.
    // Never start another type's request ahead of that acknowledgement.
    if (flushRingOutbound() < 0) return false
    val commands = RingProtocol.HEALTH_COMMANDS
    var rspCount = 0
    for (i in commands.indices) {
        val command = commands[i]
        val frame = monitor.withLock {
            ringHealthRspSeen = false
            RingProtocol.buildHealthRequest(command, nextRingSeqLocked(), nextRingNonceLocked())
        }
        if (!writeRingFrame(frame, "health request 0x" + command.toString(16))) {
            // ABORTED: the sequence stopped partway. Distinct from "the
            // ring had nothing for a type", which is an ordinary outcome
            // and leaves the loop running - see the return below.
            logLine("ring health: pull ABORTED on write at 0x" + command.toString(16)
                + " (" + i + " of " + commands.size + " types attempted, "
                + rspCount + " answered)")
            return false
        }

        if (awaitRingHealthRsp(ringHealthRspTimeoutMs)) {
            rspCount++
            if (!awaitRingHealthDataIdle(ringHealthDataIdleMs)) {
                logLine("ring health: pull ABORTED while acknowledging DATA")
                return false
            }
        } else {
            logLine("ring health: pull ABORTED waiting for RSP at 0x" + command.toString(16))
            return false
        }

        if (i < commands.size - 1) {
            sendRingDevicePing(RING_DEVICE_PING_CMD_LO[i % RING_DEVICE_PING_CMD_LO.size])
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
    val stillConnected = monitor.withLock { ringConnected }
    if (!stillConnected || rspCount == 0) {
        logLine("ring health: pull ABORTED - ran all " + commands.size + " types but "
            + (if (stillConnected) "the ring answered none of them" else "the link dropped"))
        return false
    }
    logLine("ring health: requested " + commands.size + " record types, " + rspCount + " answered")
    return true
}

/** Block (ring worker) until the health RSP flag is set or the timeout
 * elapses. Not correlated to a specific command/seq - like the rest of
 * this protocol's request path, it trusts the ring answers in order. */
internal fun GlassesSessionCore.awaitRingHealthRsp(timeoutMs: Long): Boolean {
    val deadline = now() + timeoutMs
    while (true) {
        // A DATA notification may precede its RSP. Writes must happen
        // outside the lock so GATT callbacks can continue delivering pages.
        if (flushRingOutbound() < 0) return false
        monitor.withLock {
            if (!running || !ringConnected) return false
            if (ringHealthRspSeen) return true
            if (ringOutbound.isEmpty()) {
                val remaining = deadline - now()
                if (remaining <= 0) {
                    return false
                }
                monitor.awaitMs(minOf(remaining, 100L))
            }
        }
    }
}

/** Block (ring worker) until DATA pages go idle for [idleMs], extending
 * the window on every new page so a real multi-page backlog transfer isn't
 * cut short. Not filtered by health type - correct given the ring only has
 * one type in flight at a time (see [requestRingHealth]), so any page
 * arriving here belongs to the type just requested. */
internal fun GlassesSessionCore.awaitRingHealthDataIdle(idleMs: Long): Boolean {
    var idleDeadline = now() + idleMs
    var lastSeenCounter = -1
    while (true) {
        // The next page can depend on this ACK. Waiting for idle first
        // mistakes an ACK-paced transfer for a completed transfer.
        val acknowledged = flushRingOutbound()
        if (acknowledged < 0) return false
        monitor.withLock {
            if (!running || !ringConnected) return false
            if (acknowledged > 0 || ringHealthPageCounter != lastSeenCounter) {
                lastSeenCounter = ringHealthPageCounter
                // Start the next-page window AFTER the blocking ACK write.
                idleDeadline = now() + idleMs
            }
            // A callback may have queued a page between flush and lock.
            if (ringOutbound.isEmpty()) {
                val remaining = idleDeadline - now()
                if (remaining <= 0) return true
                monitor.awaitMs(minOf(remaining, 100L))
            }
        }
    }
}

/**
 * Fire one bare device-channel REQ in the gap between health types,
 * matching (without waiting on a response) the cadence a real Even sync
 * uses. See RING_DEVICE_PING_CMD_LO for provenance and caveats.
 */
internal fun GlassesSessionCore.sendRingDevicePing(cmdLo: Int) {
    val frame = monitor.withLock {
        val seq = nextRingSeqLocked()
        val nonce = nextRingNonceLocked()
        if (cmdLo == 0x0a) {
            // The only one of these four that isn't a bare nonce - it
            // carries the same opaque constant blob as the handshake's
            // own 0x0a frame (confirmed byte-identical across two
            // different nights, see sendRingHandshake()'s comments).
            RingProtocol.buildFrame(RingProtocol.CHAN_DEVICE, RingProtocol.KIND_REQ, 0x00, 0x0a, seq,
                le16(nonce) + RING_IDENTITY_BLOB)
        } else {
            RingProtocol.buildRequest(RingProtocol.CHAN_DEVICE, 0x00, cmdLo, seq, nonce)
        }
    }
    writeRingFrame(frame, "device ping 0x" + cmdLo.toString(16))
}

/** Write one already-built ring frame. Ring worker only (blocking). */
internal fun GlassesSessionCore.writeRingFrame(frame: ByteArray, what: String): Boolean {
    return try {
        val ok = link.writeFrames(
            ringAddress,
            BleProtocol.R1_WRITE_CHAR_UUID,
            listOf(frame),
            ConnectionOptions.WRITE_MODE,
            ConnectionOptions.WRITE_TIMEOUT_MS
        )
        if (!ok) {
            logLine("ring $what write failed")
        }
        ok
    } catch (t: Throwable) {
        logLine("ring " + what + " write error: " + GlassesSessionCore.safeMessage(t))
        false
    }
}

/**
 * Drain queued ring frames (page ACKs). Ring worker only. Returns the
 * number written, or -1 if the link is unavailable or a write failed.
 */
internal fun GlassesSessionCore.flushRingOutbound(): Int {
    var acknowledged = 0
    while (true) {
        val frame = monitor.withLock {
            if (!ringNotificationsReady) return -1
            ringOutbound.firstOrNull() ?: return acknowledged
        }
        if (!writeRingFrame(frame, "page ack")) return -1
        monitor.withLock {
            // Keep failed writes queued for retry. A disconnect can clear
            // the queue during the write, so remove this exact frame only.
            val index = ringOutbound.indexOfFirst { it === frame }
            if (index >= 0) ringOutbound.removeAt(index)
            acknowledged++
        }
    }
}

internal fun GlassesSessionCore.nextRingSeqLocked(): Int {
    ringSeq = (ringSeq + 1) and 0xff
    if (ringSeq == 0) {
        ringSeq = 1
    }
    return ringSeq
}

internal fun GlassesSessionCore.nextRingNonceLocked(): Int {
    ringNonce = (ringNonce + 1) and 0xffff
    return ringNonce
}
