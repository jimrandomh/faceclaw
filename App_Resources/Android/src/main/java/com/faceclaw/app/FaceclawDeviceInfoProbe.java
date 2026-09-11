package com.faceclaw.app;

import android.bluetooth.BluetoothGatt;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import java.util.List;
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

            byte[] ack = probeArm(rightAddress, "right");
            // The right lens is the documented control endpoint, but a silent
            // right lens has been observed on stock 2.2.9 even after a
            // successful security auth — run the same probe against the left
            // lens rather than giving up, and log which lens answered.
            if (ack == null && !cancelled && !leftAddress.trim().isEmpty()
                    && !leftAddress.equalsIgnoreCase(rightAddress)) {
                emitLog("right lens did not answer the settings query; probing the left lens");
                try {
                    ack = probeArm(leftAddress, "left");
                } catch (Exception e) {
                    emitLog("left-lens probe failed: " + (e.getMessage() == null ? e.toString() : e.getMessage()));
                }
            }
            if (cancelled) {
                emitError("Cancelled.");
                return;
            }
            if (ack == null) {
                throw new IllegalStateException(
                    "no response to the device-info query on either lens — check `adb logcat -s "
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
     * Connect + authenticate + prelude + settings read on one lens. Returns the
     * settings ack protobuf, an unsolicited settings push that carried firmware
     * versions, or null when the lens never answered the read. Throws on
     * connect or prelude failure; the caller wraps the fallback lens's attempt
     * so its failure cannot mask the primary lens's outcome.
     */
    private byte[] probeArm(String address, String label) throws InterruptedException {
        emitState("connecting", label);
        connectArm(address);
        if (cancelled) {
            return null;
        }

        // Firmware 2.2.9 answers no queries until the security-auth exchange
        // completes over an encrypted link; on a phone with no existing bond
        // this is also what triggers SMP pairing (and its OS prompt), so it
        // must come before the prelude and query. Soft: this probe also runs
        // against the custom firmware, whose response to the exchange is not
        // yet hardware-verified, so an unconfirmed auth falls through.
        emitState("authenticating", label);
        boolean authenticated = authenticate(address);
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

    private boolean authenticate(String address) throws InterruptedException {
        int magic = allocMagic();
        byte[] ack = writeAndAwaitAck(address, BleProtocol.SID_SECURITY_AUTH, BleProtocol.FLAG_SECURITY_AUTH,
            magic, BleProtocol.buildAuthenticationRequest(magic), ConnectionOptions.SECURITY_AUTH_TIMEOUT_MS);
        boolean success = ack != null && BleProtocol.isAuthenticationSuccess(ack, magic);
        emitLog(success ? "security auth complete: " + address : "security auth unconfirmed: " + address);
        return success;
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
            return; // async event, not an ack
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
