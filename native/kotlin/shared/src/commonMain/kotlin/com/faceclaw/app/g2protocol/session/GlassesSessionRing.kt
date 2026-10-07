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

/** First pause after a failed ring write; doubles per consecutive failure. See [writeRingFrame]. */
private const val RING_WRITE_BACKOFF_MS = 1_000L
private const val RING_WRITE_BACKOFF_MAX_MS = 15_000L

/**
 * Device-channel commands Even's real app fires in the gaps between
 * health requests - battery (0x01), firmware version (0x02), device id
 * (0x0b) - found by extracting the literal wire order of a real
 * successful sync (same capture as ringHealthRspTimeoutMs; two
 * independent syncs in it agree). Rotated one-per-health-type here rather
 * than replicated exactly (Even's real cadence isn't perfectly regular
 * either - compare the two syncs in the capture), since which of these,
 * if any, is actually load-bearing for the ring answering has never
 * been isolated. This is matching cadence, not a confirmed protocol
 * requirement.
 *
 * Even's sync also sends 0x0a, which used to be replayed here with the
 * capture's "opaque blob". 0x0a is advStart: the blob was the capturing
 * phone's two glasses MACs, which the ring persists as the only glasses it
 * accepts. It is now sent only on request (queueRingConfigCommandLocked),
 * with our own glasses' addresses.
 */
private val RING_DEVICE_PING_CMD_LO = intArrayOf(0x01, 0x02, 0x0b)

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
            restartRingLinkForRoleChange()
            if (shouldAttemptRingConnect()) tryConnectRing("ring worker")
            if (!running) break
            flushRingConfigCommands()
            runRingGlassesSetup()
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
                lastDirectRingError = "worker error: " + GlassesSessionCore.safeMessage(t)
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
        recordRingConfigResponse(frame)
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
        if (!ringConnected || !ringNotificationsReady || directRingRole == DIRECT_RING_ROLE_GLASSES) {
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
        if (directRingRole == DIRECT_RING_ROLE_GLASSES) {
            logLine("ring health: on-demand pull skipped, direct link holds the glasses role")
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

    val seqs = IntArray(6)
    val nonces = IntArray(6)
    monitor.withLock {
        for (i in 0 until 6) {
            seqs[i] = nextRingSeqLocked()
            nonces[i] = nextRingNonceLocked()
        }
    }

    val frames = arrayOf(
        // pairAuth. Its bytes after the header must be exactly 3f 01 01:
        // measured 2026-09-11 across all four btsnoop captures, 46 real
        // 00:08 writes, zero exceptions:
        //   3f0101       (3 bytes) -> 3 writes, ALL answered (12-21 notifications each)
        //   01003f0101   (5 bytes) -> 43 writes, ALL silent (zero notifications)
        // The 5-byte form was ours, failing and retrying all night. The
        // first two bytes are not a nonce: they are the frame's phone
        // checksum (3f01 is its value at seq 1), and the role byte 01 must
        // follow it directly. A nonce in front shifted the role byte, so the
        // ring never assigned us the phone role and ignored everything after.
        // buildPairAuth computes the checksum; at seq 1 it is the captured
        // frame byte for byte (see GlassesRingLinkTest).
        RingProtocol.buildPairAuth(seqs[0]),
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
        // Even's handshake ends with advStart (00:0A) naming its glasses; it is
        // not replayed here (see RING_DEVICE_PING_CMD_LO).
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
        RingProtocol.buildRequest(RingProtocol.CHAN_DEVICE, 0x00, cmdLo, nextRingSeqLocked(), nextRingNonceLocked())
    }
    writeRingFrame(frame, "device ping 0x" + cmdLo.toString(16))
}

/**
 * Write one already-built ring frame. Ring worker only (blocking).
 *
 * After a failure, further writes fail immediately (without touching the
 * link) until an exponential backoff expires. The ring worker otherwise
 * retries a queued ACK every 100ms tick, and each failing attempt can occupy
 * the GATT pipeline the glasses' display writes need for up to the write
 * timeout.
 */
internal fun GlassesSessionCore.writeRingFrame(
    frame: ByteArray, what: String, characteristicUuid: String = BleProtocol.R1_WRITE_CHAR_UUID,
): Boolean {
    val blockedForMs = monitor.withLock { ringWriteBlockedUntilMs - now() }
    if (blockedForMs > 0) {
        return false
    }
    val ok = try {
        val written = link.writeFrames(
            ringAddress,
            characteristicUuid,
            listOf(frame),
            ConnectionOptions.WRITE_MODE,
            ConnectionOptions.WRITE_TIMEOUT_MS
        )
        if (!written) {
            logLine("ring $what write failed")
        }
        written
    } catch (t: Throwable) {
        logLine("ring " + what + " write error: " + GlassesSessionCore.safeMessage(t))
        false
    }
    monitor.withLock {
        if (ok) {
            ringWriteFailures = 0
        } else {
            val backoffMs = minOf(RING_WRITE_BACKOFF_MAX_MS, RING_WRITE_BACKOFF_MS shl minOf(ringWriteFailures, 4))
            ringWriteFailures++
            ringWriteBlockedUntilMs = now() + backoffMs
            logLine("ring writes paused for " + backoffMs + "ms after " + ringWriteFailures + " consecutive failure(s)")
        }
    }
    return ok
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

// ---------------------------------------------------------------------------
// The glasses' own link to the ring (sid 0x80 pair-manager commands)
//
// While the glasses hold the ring, it reports gestures only to them, so a
// direct phone link sees nothing. These ask the glasses to let go of it, to
// forget it, and to take it back. Shapes and handler behavior come from
// g2-kit-unofficial's protos and openCFW's decompilation of
// pb_service_pair_mgr.c; the connect form also matches the official app's
// decompiled builder. None of it has been verified on hardware. UNPAIR_INFO
// wipes the glasses' stored ring pairing; the Even app can re-pair.

/**
 * Parse "AA:BB:CC:DD:EE:FF" into wire order, least-significant byte first,
 * for both ring and glasses addresses. The official app's
 * StringExt.macToBytes reverses the same way for RING_CONNECT_INFO, and the
 * R1 (a Nordic part) compares advStart targets against its little-endian
 * peer addresses.
 */
internal fun macWireBytes(address: String): ByteArray? {
    val parts = address.trim().split(':')
    if (parts.size != 6) return null
    val bytes = ByteArray(6)
    for (i in 0 until 6) {
        val value = parts[i].toIntOrNull(16) ?: return null
        bytes[5 - i] = value.toByte()
    }
    return bytes
}

/**
 * Queue one ring-link command to both temples (only the ring-owning temple
 * acts on a connect; either may hold the link). Actions:
 * - "disconnect": DISCONNECT_INFO. Drops the link and resets the retry
 *   counter without touching the stored ring target; the glasses' own
 *   reconnect policy may take the ring back later.
 * - "release": RING_CONNECT_INFO connect=0. Also cancels pending connect
 *   timeouts and clears the connect mode, so it may hold off auto-reconnect.
 * - "connect": RING_CONNECT_INFO connect=1 with the ring's MAC and name.
 * - "unpair": UNPAIR_INFO dev=RING. The glasses forget the ring, so they
 *   stop reconnecting to it until something sends "connect" again.
 * Both RING_CONNECT_INFO forms overwrite the stored target, so they echo the
 * target the glasses reported when there is one.
 */
internal fun GlassesSessionCore.queueGlassesRingLinkCommandLocked(
    action: String, fallbackAddress: String, fallbackName: String,
): Boolean {
    val reported = glassesRingMac
    val mac = reported ?: macWireBytes(fallbackAddress)
    if (mac == null) {
        logLine("glasses ring $action skipped: no ring address")
        return false
    }
    val name = (if (reported != null && glassesRingName.isNotEmpty()) glassesRingName else fallbackName)
        .encodeToByteArray()
    val macSource = if (reported != null) "glasses-reported" else "configured"
    lastRingLinkCommand = "$action mac=${GlassesSessionCore.hex(mac)} ($macSource)"
    lastRingLinkCommandAtMs = now()
    lastRingLinkResultR = "sent"
    lastRingLinkResultL = "sent"
    for (leftArm in booleanArrayOf(false, true)) {
        val message = messageBuilder.ringLinkCommand("glasses ring $action", leftArm) { magic ->
            when (action) {
                "disconnect" -> BleProtocol.buildRingDisconnectRequest(magic, mac)
                "unpair" -> BleProtocol.buildRingUnpairRequest(magic, mac)
                "release" -> BleProtocol.buildRingConnectRequest(magic, false, mac, name)
                else -> BleProtocol.buildRingConnectRequest(magic, true, mac, name)
            }
        }
        message.onAck = MessageCallback {
            val result = "ack " + GlassesSessionCore.hex(message.ackPayload)
            if (leftArm) lastRingLinkResultL = result else lastRingLinkResultR = result
            logLine("glasses ring $action ${if (leftArm) "L" else "R"} $result")
        }
        message.onTimeout = MessageCallback {
            if (leftArm) lastRingLinkResultL = "no ack" else lastRingLinkResultR = "no ack"
            logLine("glasses ring $action ${if (leftArm) "L" else "R"} ack timeout")
        }
        pendingMessages.addLast(message)
    }
    logLine("queue glasses ring $action mac=${GlassesSessionCore.hex(mac)} ($macSource) name=${name.decodeToString()}")
    return true
}

/**
 * Note ring-link reports from the glasses: RING_CONNECT_INFO notifications
 * (connRet 0 = connected, 90 = connect timeout) and sid-0x91 ring events,
 * both carrying the ring MAC in the glasses' byte order. Acks to our own
 * commands are skipped for the MAC so it never just echoes our guess.
 */
internal fun GlassesSessionCore.recordGlassesRingReportLocked(frame: BleProtocol.ParsedFrame, address: String) {
    val report = if (frame.sid == BleProtocol.SID_RING_DATA) BleProtocol.parseRingDataEvent(frame.pb)
        else BleProtocol.parseRingConnectInfo(frame.pb)
    if (report == null) return
    val arm = if (address.equals(leftAddress, ignoreCase = true)) "L" else "R"
    val ownAck = inFlightMessages.any { it.sid == frame.sid && it.magic == frame.msgSeq }
    val mac = report.ringMac
    lastGlassesRingReport = report.source + " " + arm + " code=" + report.code +
        (if (mac != null) " mac=" + GlassesSessionCore.hex(mac) else "") +
        (if (report.ringName.isNotEmpty()) " name=" + report.ringName else "") +
        (if (ownAck) " (ack)" else "")
    lastGlassesRingReportAtMs = now()
    if (!ownAck && mac != null && mac.size == 6 && mac.any { it.toInt() != 0 }) {
        glassesRingMac = mac.copyOf()
        if (report.ringName.isNotEmpty()) glassesRingName = report.ringName
    }
    logLine("glasses ring report: $lastGlassesRingReport")
    if (!ownAck && frame.sid != BleProtocol.SID_RING_DATA && report.code == 0) {
        releaseRingFromGlassesLocked("glasses connected the ring")
    }
}

// ---------------------------------------------------------------------------
// The ring's own binding state (system-channel commands over the direct link)
//
// The R1 keeps one phone role and one glasses role, and a pair of glasses
// addresses (advStart targets) it will accept in the glasses role; gestures go
// only to the glasses role. Behavior is from openCFW's R1 decompilation
// (r1/docs/correlation/CONNECTION-CONTROL-CORRELATION.md and
// ADV-START-TOUCH-SWITCH-HANDLERS-CORRELATION.md); the official app's order
// (advStart, then RING_CONNECT_INFO to the glasses) is from its decompiled
// EvConnect.startRingAdvForCurrentGlasses. Not verified on hardware.

internal const val DIRECT_RING_ROLE_PHONE = "phone"
internal const val DIRECT_RING_ROLE_GLASSES = "glasses"

/** How long a command with a follow-up waits for the ring's answer before running it anyway. */
private const val RING_CONFIG_RESPONSE_TIMEOUT_MS = 3_000L

/** Six 0xFF bytes: an unset advStart target, the value removeRingNotify writes. */
private val RING_TARGET_UNSET = ByteArray(6) { 0xff.toByte() }

/**
 * One queued ring command. `followUp` is a glasses ring-link action (see
 * [queueGlassesRingLinkCommandLocked]) to queue once the ring has answered.
 */
internal class RingConfigCommand(
    val label: String,
    val frame: ByteArray,
    val cmdLo: Int,
    val followUp: String?,
    val followUpAddress: String,
    val followUpName: String,
)

/**
 * Queue one ring-side command for the ring worker. Actions:
 * - "pair-auth": pairAuth, claiming the phone role (the handshake already does).
 * - "targets-glasses": advStart with this session's right and left arms.
 * - "targets-clear": advStart with both targets unset (any glasses accepted).
 * - "touch-on" / "touch-off": touchSwitch on the glasses touch source.
 * - "remove-ring": removeRingNotify (clears both targets and the
 *   glasses-connected flag).
 * Returns null when queued, else why not.
 */
internal fun GlassesSessionCore.queueRingConfigCommandLocked(
    action: String, followUp: String?, followUpAddress: String, followUpName: String,
): String? {
    val seq = nextRingSeqLocked()
    val label: String
    val frame: ByteArray
    when (action) {
        "pair-auth" -> {
            label = "pairAuth"
            frame = RingProtocol.buildPairAuth(seq)
        }
        "targets-glasses" -> {
            val right = macWireBytes(rightAddress)
            val left = macWireBytes(leftAddress)
            if (right == null || left == null) return "not sent: glasses addresses unparseable"
            label = "advStart R=$rightAddress L=$leftAddress"
            frame = RingProtocol.buildAdvStart(seq, right, left)
        }
        "targets-clear" -> {
            label = "advStart cleared"
            frame = RingProtocol.buildAdvStart(seq, RING_TARGET_UNSET, RING_TARGET_UNSET)
        }
        "touch-on", "touch-off" -> {
            label = "touchSwitch glasses " + (if (action == "touch-on") "on" else "off")
            frame = RingProtocol.buildTouchSwitch(seq, RingProtocol.TOUCH_SWITCH_SELECTOR_GLASSES, action == "touch-on")
        }
        "remove-ring" -> {
            label = "removeRingNotify"
            frame = RingProtocol.buildRemoveRingNotify(seq)
        }
        else -> return "not sent: unknown ring action $action"
    }
    val cmdLo = frame[12].toInt() and 0xff
    ringConfigQueue.addLast(RingConfigCommand(label, frame, cmdLo, followUp, followUpAddress, followUpName))
    lastRingConfigCommand = label + (if (followUp != null) " then glasses $followUp" else "")
    lastRingConfigCommandAtMs = now()
    lastRingConfigResult = "queued"
    logLine("queue ring command $label seq=$seq" + (if (followUp != null) " then glasses $followUp" else ""))
    monitor.signalAll()
    return null
}

/** The direct link went away: queued commands (and their follow-ups) are not sent. */
internal fun GlassesSessionCore.dropRingConfigCommandsLocked(reason: String) {
    lastRingConfigResult = when {
        ringConfigQueue.isNotEmpty() -> "dropped: $reason"
        ringConfigAwaiting != null -> "no answer: $reason"
        else -> return
    }
    ringConfigQueue.clear()
    ringConfigAwaiting = null
    monitor.signalAll()
}

/**
 * Write queued ring commands. Ring worker only. A command with a follow-up
 * waits for the ring's answer (or a timeout), then queues the glasses half.
 * A failed write leaves the command queued for the next tick.
 */
internal fun GlassesSessionCore.flushRingConfigCommands() {
    while (true) {
        val command = monitor.withLock {
            if (!ringNotificationsReady) return
            ringConfigQueue.firstOrNull() ?: return
        }
        if (!writeRingFrame(command.frame, command.label)) return
        monitor.withLock {
            val index = ringConfigQueue.indexOfFirst { it === command }
            if (index >= 0) ringConfigQueue.removeAt(index)
            ringConfigAwaiting = command
            lastRingConfigResult = "sent, awaiting ring"
        }
        logLine("ring command ${command.label} written: " + GlassesSessionCore.hex(command.frame))
        val followUp = command.followUp ?: continue
        val answered = awaitRingConfigResponse(command)
        val queued = monitor.withLock {
            if (!running || !sessionReady) false
            else queueGlassesRingLinkCommandLocked(followUp, command.followUpAddress, command.followUpName)
        }
        logLine("ring command ${command.label}: " + (if (answered) "answered" else "no answer")
            + "; glasses $followUp " + (if (queued) "queued" else "not sent"))
        interruptibleSleep.interrupt()
    }
}

private fun GlassesSessionCore.awaitRingConfigResponse(command: RingConfigCommand): Boolean {
    val deadline = now() + RING_CONFIG_RESPONSE_TIMEOUT_MS
    monitor.withLock {
        while (running && ringConfigAwaiting === command) {
            val remaining = deadline - now()
            if (remaining <= 0) break
            monitor.awaitMs(remaining)
        }
        return ringConfigAwaiting !== command
    }
}

/** Match a system-channel response to the command awaiting one. GATT callback thread. */
internal fun GlassesSessionCore.recordRingConfigResponse(frame: RingProtocol.Frame) {
    if (frame.cmdHi != RingProtocol.CMD_HI_DEVICE) return
    val result = RingProtocol.responseResult(frame.kind) ?: return
    val label = monitor.withLock {
        val awaiting = ringConfigAwaiting
        if (awaiting == null || awaiting.cmdLo != frame.cmdLo) return
        ringConfigAwaiting = null
        lastRingConfigResult = result + " (status " + RingProtocol.hex2(frame.kind) + ")"
        monitor.signalAll()
        awaiting.label
    }
    logLine("ring command $label answered: $result " + frame.describe())
}

/** Apply a [GlassesSessionCore.setDirectRingRole] change by reconnecting the direct link. Ring worker only. */
internal fun GlassesSessionCore.restartRingLinkForRoleChange() {
    val role = monitor.withLock {
        if (!ringRoleReconnectPending) return
        ringRoleReconnectPending = false
        ringConnected = false
        ringNotificationsReady = false
        ringReconnectAfterMs = 0
        ringOutbound.clear()
        dropRingConfigCommandsLocked("role change")
        directRingRole
    }
    logLine("direct ring: reconnecting to take the $role role")
    link.disconnect(ringAddress)
}

// ---------------------------------------------------------------------------
// Acting as the ring's glasses (direct ring role "glasses")
//
// Mirrors what the stock G2 does on connecting to its ring
// (g2-firmware-emulator docs/r1-cccd-frontier.md, r1-command88-native.md):
// enable the legacy CCCD (connectRing), then write the legacy pair-auth. We
// add touchSwitch "glasses source on", without which a link gets no
// gestures (hardware, 2026-10-06). The ring keeps its targets and the
// glasses keep their unpairing across connections, so those are sent only
// when the ring or the glasses show they are still bound to each other.

/** Floor between automatic glasses unpair requests, so a fight with something re-binding the ring stays slow. */
private const val RING_RELEASE_MIN_INTERVAL_MS = 2L * 60L * 1000L

/**
 * The per-connection glasses-role setup. Ring worker only; a failed write
 * leaves it pending for the next tick (after writeRingFrame's backoff).
 */
internal fun GlassesSessionCore.runRingGlassesSetup() {
    monitor.withLock {
        if (!ringGlassesSetupPending || !ringNotificationsReady) return
        // Before the write: the ring answers within milliseconds.
        directGlassesAuth = "sent"
        directGlassesAuthAtMs = now()
    }
    if (!writeRingFrame(RingProtocol.LEGACY_GLASSES_PAIR_AUTH, "glasses pair-auth", BleProtocol.R1_LEGACY_WRITE_CHAR_UUID)) {
        return
    }
    val touch = monitor.withLock {
        RingProtocol.buildTouchSwitch(nextRingSeqLocked(), RingProtocol.TOUCH_SWITCH_SELECTOR_GLASSES, true)
    }
    if (!writeRingFrame(touch, "touch source on")) {
        return
    }
    monitor.withLock { ringGlassesSetupPending = false }
    logLine("direct ring: sent glasses pair-auth and touch source on")
}

/**
 * Legacy-channel control frames that are not input: the battery report and
 * the target rejection. Returns true when consumed. GATT callback thread.
 */
internal fun GlassesSessionCore.handleRingLegacyControl(data: ByteArray): Boolean {
    val battery = RingProtocol.parseLegacyBattery(data)
    if (battery != null) {
        monitor.withLock {
            directRingBattery = battery.battery
            directRingCharging = battery.charging
            // Only the accepted glasses peer gets these.
            directGlassesAuth = "accepted"
            directGlassesAuthAtMs = now()
            emitBatteryState(headsetBattery, headsetCharging)
        }
        logLine("direct ring battery " + battery.battery + "% charging=" + battery.charging + " (legacy report)")
        return true
    }
    if (!RingProtocol.isLegacyTargetRejected(data)) {
        return false
    }
    // The ring's advStart targets name other glasses (normally ours, from the
    // Even app's pairing), so it drops this link in ~20 s. Clear them once per
    // connection, then repeat the pair-auth so it is checked again.
    val clearing = monitor.withLock {
        directGlassesAuthAtMs = now()
        if (directGlassesAuthRetried) {
            directGlassesAuth = "rejected again: ring is bound to other glasses"
            false
        } else {
            directGlassesAuthRetried = true
            directGlassesAuth = "rejected: clearing the ring's glasses targets"
            queueRingConfigCommandLocked("remove-ring", null, "", "")
            ringGlassesSetupPending = true
            true
        }
    }
    logLine("direct ring: glasses pair-auth rejected (ring bound to other glasses)"
        + if (clearing) "; clearing its targets and retrying" else "; giving up for this connection")
    return true
}

/**
 * The glasses still hold the ring while the direct link wants its glasses
 * role: ask them to unpair it (UNPAIR_INFO), which they remember until
 * something re-pairs them. Rate-limited. Caller holds `monitor`.
 */
internal fun GlassesSessionCore.releaseRingFromGlassesLocked(reason: String) {
    if (!hasRingAddress() || directRingRole != DIRECT_RING_ROLE_GLASSES || !running || !sessionReady) return
    val now = now()
    if (lastRingReleaseAtMs != 0L && now - lastRingReleaseAtMs < RING_RELEASE_MIN_INTERVAL_MS) return
    lastRingReleaseAtMs = now
    logLine("direct ring: the glasses still hold the ring ($reason); asking them to unpair it")
    if (queueGlassesRingLinkCommandLocked("unpair", ringAddress, glassesRingName)) {
        interruptibleSleep.interrupt()
    }
}
