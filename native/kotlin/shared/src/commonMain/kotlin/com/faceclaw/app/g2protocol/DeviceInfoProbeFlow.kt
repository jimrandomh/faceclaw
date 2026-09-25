package com.faceclaw.app

/**
 * Connects to the glasses (stock-firmware compatible), reads the device-info / settings
 * response, and reports the firmware versions plus the firmware-extension string (empty on
 * stock firmware). Used by onboarding to decide whether to flash. Owns its own [StockLink] and
 * runs [run] on the caller's worker thread; listener callbacks are synchronous on that thread
 * (the platform adapter marshals them). Shows nothing on the lens.
 */
class DeviceInfoProbeFlow(
    link: StockLink,
    rightAddress: String,
    leftAddress: String,
    private val listener: FaceclawDeviceInfoProbeListener,
    private val timings: StockFlowTimings = StockFlowTimings(),
    platform: ProtocolPlatform = protocolPlatform(),
) {
    companion object {
        const val TAG = "FaceclawDeviceInfo"

        /** Connect + auth attempts per arm; a link that drops mid-pairing is retried once the bond settles. */
        const val ARM_ATTEMPTS = 3
    }

    private val rightAddress = rightAddress.trim()
    private val leftAddress = leftAddress.trim()
    private val sleeper = InterruptibleSleep(platform)
    private val session = StockLinkSession(link, ::emitLog, timings, traceFrames = true, platform = platform)

    val cancelled: Boolean
        get() = session.cancelled

    fun cancel() {
        session.cancel()
        sleeper.interrupt()
    }

    fun run() {
        try {
            if (rightAddress.isEmpty()) {
                emitError("No right-arm address configured.")
                return
            }

            val haveLeft = leftAddress.isNotEmpty() && !leftAddress.equals(rightAddress, ignoreCase = true)

            // Bring up and authenticate BOTH arms before asking for versions. Each arm is its
            // own peripheral with its own bond, so on a fresh phone each raises its own pairing
            // prompt; completing both here means the flash step (and the app proper) find both
            // bonds in place. Strictly one arm at a time: Android pairs with one device at a
            // time, and a second arm connected while the first was still pairing has been seen
            // to drop within a second and never pair (2026-09-11 logcat).
            var rightAuthenticated = bringUpArm(rightAddress, "right")
            var leftAuthenticated = false
            if (haveLeft && !cancelled) {
                leftAuthenticated = bringUpArm(leftAddress, "left")
            }
            if (cancelled) {
                emitError("Cancelled.")
                return
            }
            if (!session.isConnected(rightAddress)) {
                // The right lens may have dropped while the left one paired; it is bonded by
                // now, so this comes back quickly.
                emitLog("right lens disconnected while the left lens was set up; reconnecting")
                rightAuthenticated = bringUpArm(rightAddress, "right")
                if (cancelled) {
                    emitError("Cancelled.")
                    return
                }
            }

            var ack: ByteArray? = null
            var rightFailure: String? = null
            try {
                ack = queryArm(rightAddress, "right", rightAuthenticated)
            } catch (e: IllegalStateException) {
                rightFailure = StockLinkSession.messageOf(e)
                emitLog("right-lens query failed: $rightFailure")
            }
            // The right lens is the documented control endpoint, but a silent right lens has
            // been observed on stock 2.2.9 even after a successful security auth — run the same
            // probe against the left lens rather than giving up, and log which lens answered.
            if (ack == null && !cancelled && haveLeft) {
                emitLog("right lens did not answer the settings query; probing the left lens")
                try {
                    ack = queryArm(leftAddress, "left", leftAuthenticated)
                } catch (e: Exception) {
                    emitLog("left-lens probe failed: " + StockLinkSession.messageOf(e))
                }
            }
            if (cancelled) {
                emitError("Cancelled.")
                return
            }
            if (ack == null) {
                throw IllegalStateException(
                    rightFailure
                        ?: ("no response to the device-info query on either lens — check `adb logcat -s " + TAG + "` for the frame trace")
                )
            }

            val info = BleProtocol.parseSettingsFirmwareInfo(ack)
            val left = info?.leftVersion ?: ""
            val right = info?.rightVersion ?: ""
            val extension = info?.extension ?: ""
            emitLog("device-info: L=$left R=$right ext=[$extension]")
            listener.onResult(left, right, extension)
        } catch (e: Exception) {
            emitError(if (cancelled) "Cancelled." else StockLinkSession.messageOf(e))
        } finally {
            session.closeQuietly()
        }
    }

    /**
     * Connect to one arm and complete its security-auth exchange, retrying when the link drops
     * mid-pairing. Returns whether the auth success was seen (false = connected but
     * unconfirmed, tolerated because the custom firmware's response to the exchange is not yet
     * hardware-verified); throws when the arm cannot be brought up at all.
     */
    private fun bringUpArm(address: String, label: String): Boolean {
        var lastFailure: String? = null
        var attempt = 1
        while (attempt <= ARM_ATTEMPTS && !cancelled) {
            if (attempt > 1) {
                // A link the OS dropped while it was still pairing comes back once the bond
                // settles; reconnecting sooner just fails again.
                session.waitForBondToSettle(address, label, sleeper)
                if (cancelled) {
                    break
                }
                emitLog("retrying the $label lens (attempt $attempt/$ARM_ATTEMPTS): $lastFailure")
                sleeper.sleep(timings.armRetryDelayMs.toLong())
            }
            listener.onState("connecting", label)
            try {
                session.bringUp(address)
            } catch (e: IllegalStateException) {
                lastFailure = StockLinkSession.messageOf(e)
                emitLog("$label lens: $lastFailure")
                attempt++
                continue
            }
            if (cancelled) {
                break
            }

            // Firmware 2.2.9 answers no queries until the security-auth exchange completes over
            // an encrypted link; on a phone with no existing bond this is also what triggers SMP
            // pairing (and its OS prompt), so it must come before the prelude and query.
            listener.onState("authenticating", label)
            when (session.authenticate(address, label)) {
                StockLinkSession.AuthResult.SUCCESS -> return true
                StockLinkSession.AuthResult.UNCONFIRMED -> return false
                StockLinkSession.AuthResult.LINK_DROPPED -> {
                    lastFailure = "link dropped during authentication"
                    attempt++
                }
            }
        }
        if (cancelled) {
            return false
        }
        throw IllegalStateException(
            "could not connect to the $label lens ($address): " + lastFailure +
                " — if the phone showed a Bluetooth pairing request, accept it and try again"
        )
    }

    /**
     * Prelude + settings read on an already connected/authenticated lens. Returns the settings
     * ack protobuf, an unsolicited settings push that carried firmware versions, or null when
     * the lens never answered the read. Throws on prelude failure; the caller wraps the fallback
     * lens's attempt so its failure cannot mask the primary lens's outcome.
     */
    private fun queryArm(address: String, label: String, authenticated: Boolean): ByteArray? {
        if (cancelled) {
            return null
        }
        listener.onState("querying", label)
        // Session prelude, then a settings/device-info read (both arms' versions and the
        // firmware-extension string ride back in one response).
        session.sendPrelude(
            address,
            " ($label lens)" +
                (if (authenticated) "" else "; authentication did not complete — if the phone shows a Bluetooth pairing request, accept it and try again"),
        )

        // Two attempts: the first read straight after a fresh pairing has been seen to go
        // unanswered while a later one succeeds.
        var attempt = 0
        while (attempt < 2 && !cancelled) {
            val ack = session.readSettings(address, timings.queryTimeoutMs)
            if (ack != null) {
                return ack
            }
            // A push with the firmware versions on the device's own magic is as good as the
            // ack we asked for.
            val pushed = session.unsolicitedSettingsPb
            if (pushed != null) {
                emitLog("using unsolicited settings push instead of the read ack ($label lens)")
                return pushed
            }
            emitLog("settings query attempt " + (attempt + 1) + " unanswered (" + label + " lens)")
            attempt++
        }
        return null
    }

    // Log lines reach the platform log through the adapter's onLog (Android: logcat under TAG).
    private fun emitLog(line: String) {
        listener.onLog(line)
    }

    private fun emitError(message: String) {
        listener.onError(message)
    }
}
