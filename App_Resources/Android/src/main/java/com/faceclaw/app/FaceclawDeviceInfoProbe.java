package com.faceclaw.app;

import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;

import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * Connects to the glasses (stock-firmware compatible), reads the device-info /
 * settings response, and reports the firmware versions plus the firmware-
 * extension string (empty on stock firmware). Used by onboarding to decide whether to
 * flash. Reuses FaceclawBleManager + BleProtocol; owns its own connection and
 * runs on a single worker thread. Shows nothing on the lens.
 */
public class FaceclawDeviceInfoProbe implements FaceclawBleListener {
    private static final String TAG = "FaceclawDeviceInfo";
    private static final int QUERY_TIMEOUT_MS = 4_000;
    /** Connect + auth attempts per arm; a link that drops mid-pairing is retried once the bond settles. */
    private static final int ARM_ATTEMPTS = 3;
    private static final int ARM_RETRY_DELAY_MS = 1_000;
    /**
     * Upper bound on waiting for the auth success while Android reports the arm
     * as BOND_BONDING — i.e. an OS pairing dialog may be sitting there waiting
     * for the user, which can take a lot longer than the normal 30 s window.
     */
    private static final int PAIRING_WAIT_CAP_MS = 90_000;
    /** After a fresh bond, how long the firmware gets to notify success on its own before the request is re-sent. */
    private static final int POST_BOND_GRACE_MS = 2_000;
    private static final int POLL_MS = 250;

    private final Context context;
    private final String rightAddress;
    private final String leftAddress;
    private final FaceclawBleManager bleManager;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private final Object lock = new Object();
    private int nextSeq = 0x40;
    private int nextMagic = 100;

    private int awaitSid = -1;
    private int awaitMagic = -1;
    private byte[] awaitPb = null;
    private CountDownLatch awaitLatch = null;

    /**
     * Security-auth wait, kept separate from the generic ack wait: only the
     * firmware's SUCCESS result (empty result message) may satisfy it. The
     * firmware answers the request as soon as it arrives, but with a
     * non-success result until the link is encrypted; accepting that first
     * reply as "the ack" is what let the probe move on to the other arm while
     * Android's pairing dialog for this one was still up.
     */
    private final Set<Integer> authMagics = new HashSet<>();
    private CountDownLatch authLatch = null;

    /**
     * A sid-0x09 frame that carried firmware versions without matching the
     * awaited magic — some firmware pushes the settings snapshot on a magic it
     * picked itself instead of (or in addition to) acking the read.
     */
    private volatile byte[] unsolicitedSettingsPb;

    private volatile FaceclawDeviceInfoProbeListener listener;
    private volatile Thread worker;
    private volatile boolean cancelled = false;

    public FaceclawDeviceInfoProbe(Context context, String rightAddress, String leftAddress) {
        this.context = context.getApplicationContext();
        this.rightAddress = rightAddress == null ? "" : rightAddress;
        this.leftAddress = leftAddress == null ? "" : leftAddress;
        this.bleManager = new FaceclawBleManager(this.context);
        this.bleManager.setListener(this);
    }

    public void setListener(FaceclawDeviceInfoProbeListener listener) {
        this.listener = listener;
    }

    public void start() {
        synchronized (lock) {
            if (worker != null) {
                return;
            }
            worker = new Thread(this::run, "faceclaw-device-info");
            worker.start();
        }
    }

    public void cancel() {
        cancelled = true;
        Thread w = worker;
        if (w != null) {
            w.interrupt();
        }
    }

    public void close() {
        cancel();
        try {
            bleManager.close();
        } catch (Exception ignored) {
        }
    }

    private void run() {
        try {
            if (rightAddress.trim().isEmpty()) {
                emitError("No right-arm address configured.");
                return;
            }

            boolean haveLeft = !leftAddress.trim().isEmpty() && !leftAddress.equalsIgnoreCase(rightAddress);

            // Bring up and authenticate BOTH arms before asking for versions.
            // Each arm is its own peripheral with its own bond, so on a fresh
            // phone each raises its own pairing prompt; completing both here
            // means the flash step (and the app proper) find both bonds in
            // place. Strictly one arm at a time: Android pairs with one device
            // at a time, and a second arm connected while the first was still
            // pairing has been seen to drop within a second and never pair
            // (2026-09-11 logcat).
            boolean rightAuthenticated = bringUpArm(rightAddress, "right");
            boolean leftAuthenticated = false;
            if (haveLeft && !cancelled) {
                leftAuthenticated = bringUpArm(leftAddress, "left");
            }
            if (cancelled) {
                emitError("Cancelled.");
                return;
            }
            if (!bleManager.isConnected(rightAddress)) {
                // The right lens may have dropped while the left one paired;
                // it is bonded by now, so this comes back quickly.
                emitLog("right lens disconnected while the left lens was set up; reconnecting");
                rightAuthenticated = bringUpArm(rightAddress, "right");
                if (cancelled) {
                    emitError("Cancelled.");
                    return;
                }
            }

            byte[] ack = null;
            String rightFailure = null;
            try {
                ack = queryArm(rightAddress, "right", rightAuthenticated);
            } catch (IllegalStateException e) {
                rightFailure = e.getMessage() == null ? e.toString() : e.getMessage();
                emitLog("right-lens query failed: " + rightFailure);
            }
            // The right lens is the documented control endpoint, but a silent
            // right lens has been observed on stock 2.2.9 even after a
            // successful security auth — run the same probe against the left
            // lens rather than giving up, and log which lens answered.
            if (ack == null && !cancelled && haveLeft) {
                emitLog("right lens did not answer the settings query; probing the left lens");
                try {
                    ack = queryArm(leftAddress, "left", leftAuthenticated);
                } catch (Exception e) {
                    emitLog("left-lens probe failed: " + (e.getMessage() == null ? e.toString() : e.getMessage()));
                }
            }
            if (cancelled) {
                emitError("Cancelled.");
                return;
            }
            if (ack == null) {
                throw new IllegalStateException(rightFailure != null
                    ? rightFailure
                    : "no response to the device-info query on either lens — check `adb logcat -s "
                        + TAG + "` for the frame trace");
            }

            BleProtocol.FirmwareInfo info = BleProtocol.parseSettingsFirmwareInfo(ack);
            String left = info == null ? "" : info.leftVersion;
            String right = info == null ? "" : info.rightVersion;
            String extension = info == null ? "" : info.extension;
            emitLog("device-info: L=" + left + " R=" + right + " ext=[" + extension + "]");
            emitResult(left, right, extension);
        } catch (Exception e) {
            String message = cancelled ? "Cancelled." : (e.getMessage() == null ? e.toString() : e.getMessage());
            emitError(message);
        } finally {
            try {
                bleManager.close();
            } catch (Exception ignored) {
            }
        }
    }

    /**
     * Connect to one arm and complete its security-auth exchange, retrying
     * when the link drops mid-pairing. Returns whether the auth success was
     * seen (false = connected but unconfirmed, tolerated because the custom
     * firmware's response to the exchange is not yet hardware-verified);
     * throws when the arm cannot be brought up at all.
     */
    private boolean bringUpArm(String address, String label) throws InterruptedException {
        String lastFailure = null;
        for (int attempt = 1; attempt <= ARM_ATTEMPTS && !cancelled; attempt++) {
            if (attempt > 1) {
                // A link Android dropped while it was still pairing comes back
                // once the bond settles; reconnecting sooner just fails again.
                waitForBondToSettle(address, label);
                if (cancelled) {
                    break;
                }
                emitLog("retrying the " + label + " lens (attempt " + attempt + "/" + ARM_ATTEMPTS + "): " + lastFailure);
                Thread.sleep(ARM_RETRY_DELAY_MS);
            }
            emitState("connecting", label);
            try {
                connectArm(address);
            } catch (IllegalStateException e) {
                lastFailure = e.getMessage() == null ? e.toString() : e.getMessage();
                emitLog(label + " lens: " + lastFailure);
                continue;
            }
            if (cancelled) {
                break;
            }

            // Firmware 2.2.9 answers no queries until the security-auth
            // exchange completes over an encrypted link; on a phone with no
            // existing bond this is also what triggers SMP pairing (and its OS
            // prompt), so it must come before the prelude and query.
            emitState("authenticating", label);
            AuthResult result = authenticate(address, label);
            if (result == AuthResult.SUCCESS) {
                return true;
            }
            if (result == AuthResult.UNCONFIRMED) {
                return false;
            }
            lastFailure = "link dropped during authentication";
        }
        if (cancelled) {
            return false;
        }
        throw new IllegalStateException("could not connect to the " + label + " lens (" + address + "): "
            + lastFailure + " — if Android showed a Bluetooth pairing request, accept it and try again");
    }

    private enum AuthResult { SUCCESS, UNCONFIRMED, LINK_DROPPED }

    /**
     * Send the sid-0x80 authentication request and wait for the firmware's
     * SUCCESS notification, which only arrives once the link is encrypted.
     * On an unbonded phone that means waiting through Android's pairing flow
     * (BOND_BONDING, possibly with a dialog up), so the wait is extended while
     * the OS reports pairing in progress and the request is re-sent once
     * after a fresh bond in case the pre-pairing write was dropped. Bond
     * state is polled rather than awaited via broadcast; 250 ms granularity
     * is plenty here.
     */
    private AuthResult authenticate(String address, String label) throws InterruptedException {
        long start = SystemClock.elapsedRealtime();
        long deadline = start + ConnectionOptions.SECURITY_AUTH_TIMEOUT_MS;
        long hardDeadline = start + PAIRING_WAIT_CAP_MS;
        CountDownLatch latch = new CountDownLatch(1);
        synchronized (lock) {
            authMagics.clear();
            authLatch = latch;
        }
        int initialBond = bleManager.getBondState(address);
        emitLog("security auth: " + label + " lens, Android bond state " + bondStateName(initialBond));
        try {
            int sends = 0;
            boolean lastSendFailed = false;
            long nextSendAt = start;
            long bondedAt = -1;
            boolean resentAfterBond = false;
            boolean loggedBonding = false;
            while (!cancelled) {
                long now = SystemClock.elapsedRealtime();
                int bond = bleManager.getBondState(address);

                if (bond == BluetoothDevice.BOND_BONDING) {
                    // OS pairing in progress — the firmware will answer once the
                    // link is encrypted. Don't write, don't give up, don't move
                    // on to the other arm.
                    if (!loggedBonding) {
                        emitLog("Android is pairing with the " + label + " lens; waiting for the user to accept");
                        loggedBonding = true;
                    }
                    if (now >= hardDeadline) {
                        break;
                    }
                } else {
                    if (bond == BluetoothDevice.BOND_BONDED && initialBond != BluetoothDevice.BOND_BONDED
                            && bondedAt < 0) {
                        bondedAt = now;
                        emitLog("Android bond established with the " + label + " lens; waiting for the auth success");
                        deadline = Math.max(deadline, now + ConnectionOptions.SECURITY_AUTH_SOFT_TIMEOUT_MS);
                    }
                    boolean wantSend = sends == 0
                        || (lastSendFailed && sends < 3 && now >= nextSendAt)
                        || (bondedAt >= 0 && !resentAfterBond && now - bondedAt >= POST_BOND_GRACE_MS);
                    if (wantSend) {
                        if (bondedAt >= 0) {
                            resentAfterBond = true;
                            if (sends > 0) {
                                emitLog("re-sending the auth request after pairing (" + label + " lens)");
                            }
                        }
                        lastSendFailed = !sendAuthRequest(address);
                        sends++;
                        nextSendAt = SystemClock.elapsedRealtime() + ARM_RETRY_DELAY_MS;
                        if (lastSendFailed && !bleManager.isConnected(address)) {
                            return AuthResult.LINK_DROPPED;
                        }
                    }
                    if (now >= deadline) {
                        break;
                    }
                }

                if (latch.await(POLL_MS, TimeUnit.MILLISECONDS)) {
                    emitLog("security auth complete: " + label + " lens (" + address + ")");
                    return AuthResult.SUCCESS;
                }
                if (!bleManager.isConnected(address)) {
                    emitLog("security auth: " + label + " lens disconnected while waiting"
                        + (bond == BluetoothDevice.BOND_BONDING ? " (Android was still pairing)" : ""));
                    return AuthResult.LINK_DROPPED;
                }
            }
            if (cancelled) {
                return AuthResult.UNCONFIRMED;
            }
            emitLog("security auth unconfirmed: " + label + " lens (" + address + "), Android bond state "
                + bondStateName(bleManager.getBondState(address)));
            return AuthResult.UNCONFIRMED;
        } finally {
            synchronized (lock) {
                authLatch = null;
                authMagics.clear();
            }
        }
    }

    private boolean sendAuthRequest(String address) {
        int magic = allocMagic();
        int seq;
        synchronized (lock) {
            authMagics.add(magic);
            seq = nextSeq++ & 0xff;
        }
        byte[] payload = BleProtocol.buildAuthenticationRequest(magic);
        emitLog(String.format("tx %s sid=0x%02x flag=0x%02x magic=%d seq=0x%02x len=%d",
            address, BleProtocol.SID_SECURITY_AUTH, BleProtocol.FLAG_SECURITY_AUTH, magic, seq, payload.length));
        List<byte[]> frames = BleProtocol.framePb(payload, BleProtocol.SID_SECURITY_AUTH, BleProtocol.FLAG_SECURITY_AUTH, seq);
        boolean written;
        try {
            written = bleManager.writeFrames(
                address, BleProtocol.WRITE_CHAR_UUID, frames, ConnectionOptions.WRITE_TYPE, ConnectionOptions.WRITE_TIMEOUT_MS);
        } catch (IllegalStateException e) {
            // "Not connected" — the link went away underneath us.
            written = false;
        }
        if (!written) {
            emitLog("tx write FAILED sid=0x80 (" + address + ")");
        }
        return written;
    }

    /** Block while Android reports this arm as BOND_BONDING (pairing dialog up / SMP in flight). */
    private void waitForBondToSettle(String address, String label) throws InterruptedException {
        long cap = SystemClock.elapsedRealtime() + PAIRING_WAIT_CAP_MS;
        boolean logged = false;
        while (!cancelled && bleManager.getBondState(address) == BluetoothDevice.BOND_BONDING
                && SystemClock.elapsedRealtime() < cap) {
            if (!logged) {
                emitLog("waiting for Android to finish pairing with the " + label + " lens before reconnecting");
                logged = true;
            }
            Thread.sleep(POLL_MS);
        }
    }

    private static String bondStateName(int state) {
        switch (state) {
            case BluetoothDevice.BOND_NONE:
                return "none";
            case BluetoothDevice.BOND_BONDING:
                return "bonding";
            case BluetoothDevice.BOND_BONDED:
                return "bonded";
            default:
                return "unknown";
        }
    }

    /**
     * Prelude + settings read on an already connected/authenticated lens.
     * Returns the settings ack protobuf, an unsolicited settings push that
     * carried firmware versions, or null when the lens never answered the read.
     * Throws on prelude failure; the caller wraps the fallback lens's attempt
     * so its failure cannot mask the primary lens's outcome.
     */
    private byte[] queryArm(String address, String label, boolean authenticated) throws InterruptedException {
        if (cancelled) {
            return null;
        }

        emitState("querying", label);
        // Session prelude, then a settings/device-info read (both arms'
        // versions and the firmware-extension string ride back in one response).
        if (writeAndAwaitAck(address, BleProtocol.PRELUDE_ACK_SID, BleProtocol.FLAG_REQUEST,
                BleProtocol.PRELUDE_ACK_MAGIC, BleProtocol.PRELUDE_F5872_PAYLOAD,
                ConnectionOptions.PRELUDE_TIMEOUT_MS) == null) {
            throw new IllegalStateException("session prelude not acked (" + label + " lens)"
                + (authenticated ? "" : "; authentication did not complete —"
                    + " if Android shows a Bluetooth pairing request, accept it and try again"));
        }

        // Two attempts: the first read straight after a fresh pairing has been
        // seen to go unanswered while a later one succeeds.
        for (int attempt = 0; attempt < 2 && !cancelled; attempt++) {
            int magic = allocMagic();
            byte[] ack = writeAndAwaitAck(address, BleProtocol.SID_UI_SETTING, BleProtocol.FLAG_REQUEST,
                magic, BleProtocol.buildSettingsQuery(magic), QUERY_TIMEOUT_MS);
            if (ack != null) {
                return ack;
            }
            // A push with the firmware versions on the device's own magic is
            // as good as the ack we asked for.
            byte[] pushed = unsolicitedSettingsPb;
            if (pushed != null) {
                emitLog("using unsolicited settings push instead of the read ack (" + label + " lens)");
                return pushed;
            }
            emitLog("settings query attempt " + (attempt + 1) + " unanswered (" + label + " lens)");
        }
        return null;
    }

    private void connectArm(String address) {
        if (!bleManager.connect(address, ConnectionOptions.CONNECT_TIMEOUT_MS)) {
            throw new IllegalStateException("connect failed");
        }
        bleManager.requestConnectionPriority(address, BluetoothGatt.CONNECTION_PRIORITY_HIGH);
        bleManager.requestMtu(address, ConnectionOptions.DESIRED_MTU, ConnectionOptions.CONNECT_TIMEOUT_MS);
        if (!bleManager.discoverServices(address, ConnectionOptions.SERVICES_TIMEOUT_MS)) {
            throw new IllegalStateException("service discovery failed");
        }
        if (!bleManager.enableNotifications(address, BleProtocol.NOTIFY_CHAR_UUID, true, ConnectionOptions.DESCRIPTOR_TIMEOUT_MS)) {
            throw new IllegalStateException("could not subscribe to notifications");
        }
    }

    private byte[] writeAndAwaitAck(String address, int sid, int flag, int magic, byte[] payload, int timeoutMs)
            throws InterruptedException {
        CountDownLatch latch = new CountDownLatch(1);
        synchronized (lock) {
            awaitSid = sid;
            awaitMagic = magic;
            awaitPb = null;
            awaitLatch = latch;
        }
        int seq;
        synchronized (lock) {
            seq = nextSeq++ & 0xff;
        }
        emitLog(String.format("tx %s sid=0x%02x flag=0x%02x magic=%d seq=0x%02x len=%d",
            address, sid, flag, magic, seq, payload.length));
        List<byte[]> frames = BleProtocol.framePb(payload, sid, flag, seq);
        boolean written = bleManager.writeFrames(
            address, BleProtocol.WRITE_CHAR_UUID, frames, ConnectionOptions.WRITE_TYPE, ConnectionOptions.WRITE_TIMEOUT_MS);
        if (!written) {
            emitLog("tx write FAILED sid=0x" + Integer.toHexString(sid));
            synchronized (lock) {
                awaitLatch = null;
            }
            return null;
        }
        boolean acked = latch.await(timeoutMs, TimeUnit.MILLISECONDS);
        synchronized (lock) {
            awaitLatch = null;
            return acked ? awaitPb : null;
        }
    }

    @Override
    public void onNotification(String address, String characteristicUuid, byte[] data) {
        if (!BleProtocol.NOTIFY_CHAR_UUID.equalsIgnoreCase(characteristicUuid)) {
            return;
        }
        // One notification value can carry several envelope frames back to
        // back; reading only the first would silently drop the rest.
        List<byte[]> frames = BleProtocol.splitFrames(data);
        if (frames.size() > 1) {
            emitLog("rx " + address + " value carries " + frames.size() + " frames (raw " + data.length + " bytes)");
        }
        for (byte[] buf : frames) {
            handleFrame(address, buf, data.length);
        }
    }

    private void handleFrame(String address, byte[] buf, int rawValueLength) {
        BleProtocol.ParsedFrame frame = BleProtocol.parseFrame(buf);
        if (!frame.ok) {
            emitLog("rx " + address + " unparseable frame len=" + buf.length + " (raw value " + rawValueLength + ")"
                + " head=" + FaceclawFirmwareUtil.bytesToHex(java.util.Arrays.copyOf(buf, Math.min(16, buf.length))));
            return;
        }
        // Log every control frame while diagnosing 2.2.9: sid/flag/type/magic
        // plus a payload prefix is enough to reconstruct what the lens said.
        int declared = buf.length > 3 ? buf[3] & 0xff : 0;
        String truncated = buf.length < 8 + declared ? " TRUNCATED(declared=" + declared + ")" : "";
        emitLog(String.format("rx %s sid=0x%02x flag=0x%02x type=%d magic=%d frag=%d/%d len=%d%s pb=%s",
            address, frame.sid, frame.flag, frame.msgType, frame.msgSeq,
            buf.length > 5 ? buf[5] & 0xff : 0, buf.length > 4 ? buf[4] & 0xff : 0, frame.pb.length, truncated,
            FaceclawFirmwareUtil.bytesToHex(java.util.Arrays.copyOf(frame.pb, Math.min(48, frame.pb.length)))));
        if (frame.sid == BleProtocol.SID_UI_SETTING
                && BleProtocol.parseSettingsFirmwareInfo(frame.pb) != null) {
            // Any settings frame carrying firmware versions answers the probe's
            // question, whether or not it matches the magic we asked with.
            unsolicitedSettingsPb = frame.pb;
        }
        if (frame.flag == BleProtocol.FLAG_NOTIFY || frame.flag == BleProtocol.FLAG_NOTIFY_ALT) {
            // Async event, not an ack. This includes the lens's own periodic
            // sid-0x80 notifies (device-chosen magic, non-empty result).
            return;
        }
        if (frame.sid == BleProtocol.SID_SECURITY_AUTH) {
            boolean success = false;
            boolean ours = false;
            synchronized (lock) {
                if (authLatch != null) {
                    ours = authMagics.contains(frame.msgSeq);
                    for (int magic : authMagics) {
                        if (BleProtocol.isAuthenticationSuccess(frame.pb, magic)) {
                            success = true;
                            authLatch.countDown();
                            break;
                        }
                    }
                }
            }
            if (ours && !success) {
                // Expected before the link is encrypted: the firmware answers
                // the request straight away with a non-success result and
                // sends the real success once pairing/encryption completes.
                emitLog("auth reply for magic " + frame.msgSeq + " is not the success result; still waiting");
            }
            return;
        }
        synchronized (lock) {
            if (awaitLatch != null && frame.sid == awaitSid && frame.msgSeq == awaitMagic) {
                awaitPb = frame.pb;
                awaitLatch.countDown();
            }
        }
    }

    @Override
    public void onConnectionStateChange(String address, boolean connected) {
        if (!connected) {
            Log.i(TAG, "disconnected: " + address);
        }
    }

    private int allocMagic() {
        synchronized (lock) {
            int magic = nextMagic;
            nextMagic = nextMagic >= 255 ? 100 : nextMagic + 1;
            return magic;
        }
    }

    private void emitLog(String line) {
        Log.i(TAG, line);
        mainHandler.post(() -> {
            FaceclawDeviceInfoProbeListener current = listener;
            if (current != null) {
                current.onLog(line);
            }
        });
    }

    private void emitState(String state, String detail) {
        final String safeDetail = detail == null ? "" : detail;
        mainHandler.post(() -> {
            FaceclawDeviceInfoProbeListener current = listener;
            if (current != null) {
                current.onState(state, safeDetail);
            }
        });
    }

    private void emitResult(String left, String right, String extension) {
        mainHandler.post(() -> {
            FaceclawDeviceInfoProbeListener current = listener;
            if (current != null) {
                current.onResult(left, right, extension);
            }
        });
    }

    private void emitError(String message) {
        final String safeMessage = message == null ? "" : message;
        mainHandler.post(() -> {
            FaceclawDeviceInfoProbeListener current = listener;
            if (current != null) {
                current.onError(safeMessage);
            }
        });
    }
}
