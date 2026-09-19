package com.faceclaw.app;

import android.bluetooth.BluetoothGatt;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.FileInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * Ports g2flash.py's OTA flash procedure to Android. Streams the EVENOTA
 * firmware container to each lens over the firmware-data service using the
 * aa21 envelope (BleProtocol.framePb) and the c0/c1 control/data protocol.
 *
 * Each lens connection completes the sid-0x80 security-auth exchange before
 * OTA BEGIN — firmware 2.2.9 closes unauthenticated links ~30 s in, killing
 * the transfer mid-component. No control-channel traffic is injected during
 * the transfer itself: official OTA captures show none between BEGIN and the
 * final END, heartbeats demonstrably do not satisfy the 2.2.9 deadline, and a
 * concurrent control writer would interleave with the marker/data
 * transactions. (See ../notes/ble-connections-2.2.9.md.)
 *
 * Lenses are flashed one at a time (left, then right). Finishing either lens
 * reboots BOTH lenses, so the second lens is briefly unreachable — the reconnect
 * for it uses a generous window rather than failing fast.
 *
 * Separate from FaceclawBleCommunicator on purpose: this speaks the stock OTA
 * protocol and must run before the custom firmware exists. It reuses the GATT
 * wrapper (FaceclawBleManager) and framing (BleProtocol).
 */
public class FaceclawFirmwareFlasher implements FaceclawBleListener {
    private static final String TAG = "FaceclawFlasher";

    // OTA message types (envelope sid byte) and control opcodes.
    private static final int SID_CTRL = 0xc0;
    private static final int SID_DATA = 0xc1;
    private static final int FLAG_OTA = 0x00;
    private static final int OP_BEGIN = 0x00;
    private static final int OP_FILE_CHECK = 0x01;
    private static final int OP_BLOCK = 0x02;
    private static final int OP_END = 0x03;

    private static final int BLOCK_SIZE = 4096;
    private static final int BLOCK_ACK_TIMEOUT_MS = 4_000;
    private static final int CTRL_ACK_TIMEOUT_MS = 8_000;
    private static final int BLOCK_NAK_RETRIES = 3;
    private static final int COMPONENT_RETRIES = 3;

    // Reconnect windows. The first lens connects from an idle device; the second
    // must ride out the post-first-lens reboot of both lenses.
    private static final int FIRST_LENS_CONNECT_WINDOW_MS = 30_000;
    private static final int SECOND_LENS_CONNECT_WINDOW_MS = 120_000;
    private static final int REBOOT_SETTLE_MS = 5_000;
    private static final int NOTIFY_SETTLE_MS = 2_500;
    private static final int RETRY_DELAY_MS = 2_500;

    // END ack statuses that mean "component accepted": SUCCESS, UPDATING, SYS_RESTART.
    private static final int[] END_OK = new int[] {0, 8, 9};

    // Firmware layout expectations (mirrors g2flash.py). Firmware 2.2.4 has 5
    // components; 2.2.6 has 6.
    private static final int MIN_SEGMENTS = 5;
    private static final int MAX_SEGMENTS = 6;
    private static final String REQUIRED_SEGMENT = "ota/s200_firmware_ota.bin";
    private static final long APP_LOAD_ADDR = 0x00438000L;
    private static final long APP_MAX_END = 0x007F0000L;
    private static final int APP_PREAMBLE = 0x20;

    private final Context context;
    private final String leftAddress;
    private final String rightAddress;
    private final String firmwarePath;
    private final FaceclawBleManager bleManager;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private final Object lock = new Object();
    private final LinkedBlockingQueue<byte[]> dataAcks = new LinkedBlockingQueue<>();

    private volatile FaceclawFirmwareFlasherListener listener;
    private volatile Thread worker;
    private volatile boolean cancelled = false;

    private int nextSeq = 0;
    private int nextAuthMagic = 0x60;
    private int pendingAuthMagic = -1;
    private CountDownLatch authLatch;
    private byte[] authAckPb;

    public FaceclawFirmwareFlasher(Context context, String rightAddress, String leftAddress, String firmwarePath) {
        this.context = context.getApplicationContext();
        this.rightAddress = rightAddress == null ? "" : rightAddress;
        this.leftAddress = leftAddress == null ? "" : leftAddress;
        this.firmwarePath = firmwarePath == null ? "" : firmwarePath;
        this.bleManager = new FaceclawBleManager(this.context);
        this.bleManager.setListener(this);
    }

    public void setListener(FaceclawFirmwareFlasherListener listener) {
        this.listener = listener;
    }

    public void start() {
        synchronized (lock) {
            if (worker != null) {
                return;
            }
            worker = new Thread(this::run, "faceclaw-flasher");
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
            if (leftAddress.trim().isEmpty() || rightAddress.trim().isEmpty()) {
                throw new IllegalStateException("Both lens addresses are required to flash.");
            }

            emitState("validating", "");
            byte[] img = readFile(firmwarePath);
            List<Segment> segs = validate(img);
            emitLog("firmware validated: " + segs.size() + " components, " + img.length + " bytes");

            flashLens("left", leftAddress, img, segs, FIRST_LENS_CONNECT_WINDOW_MS);
            if (cancelled) {
                emitState("error", "Cancelled.");
                emitComplete(false, "Cancelled after the left lens.");
                return;
            }

            emitState("rebooting", "Left lens done. Both lenses reboot briefly; reconnecting for the right lens.");
            sleepInterruptibly(REBOOT_SETTLE_MS);
            flashLens("right", rightAddress, img, segs, SECOND_LENS_CONNECT_WINDOW_MS);

            emitState("done", "");
            emitComplete(true, "Both lenses flashed. The glasses are rebooting into the custom firmware.");
        } catch (Exception e) {
            String message = e.getMessage() == null ? e.toString() : e.getMessage();
            if (cancelled) {
                message = "Cancelled.";
            }
            emitState("error", message);
            emitComplete(false, message);
        } finally {
            teardown();
        }
    }

    private void flashLens(String lens, String address, byte[] img, List<Segment> segs, int connectWindowMs)
            throws TimeoutException {
        emitState("connecting", lens);
        connectLensResilient(lens, address, connectWindowMs);
        sleepInterruptibly(NOTIFY_SETTLE_MS);
        drainAcks();
        // Fresh envelope counter for the OTA stream (the auth exchange during
        // bring-up used its own); mirrors the stock sequence.
        resetSeq();

        emitState("flashing", lens);
        int beginStatus = sendCtrlAndWait(address, OP_BEGIN, EMPTY, CTRL_ACK_TIMEOUT_MS);
        if (!isEndOk(beginStatus)) {
            emitLog("warning: unexpected begin status " + beginStatus + "; continuing");
        }
        // Progress is reported in bytes across the whole image: the segments
        // are one large firmware blob plus several small ones, so a bar
        // stepped per segment would sit still through the big one and then
        // sprint through the rest.
        long totalBytes = 0;
        for (Segment seg : segs) {
            totalBytes += seg.ps;
        }
        long bytesBefore = 0;
        for (int i = 0; i < segs.size(); i++) {
            if (cancelled) {
                throw new IllegalStateException("Cancelled.");
            }
            flashComponentWithRetry(lens, address, i, segs.size(), segs.get(i), img, bytesBefore, totalBytes);
            bytesBefore += segs.get(i).ps;
        }
        emitLog(lens + " lens: all components verified");
        try {
            bleManager.disconnect(address);
        } catch (Exception ignored) {
        }
    }

    private void flashComponentWithRetry(String lens, String address, int index, int count, Segment seg, byte[] img,
            long bytesBefore, long totalBytes) {
        for (int attempt = 0; attempt < COMPONENT_RETRIES; attempt++) {
            if (attempt > 0) {
                emitLog(seg.name + ": re-flash attempt " + (attempt + 1) + "/" + COMPONENT_RETRIES);
            }
            int endStatus;
            try {
                endStatus = flashComponent(lens, address, index, count, seg, img, bytesBefore, totalBytes);
            } catch (TimeoutException | RuntimeException e) {
                emitLog(seg.name + ": block phase failed: " + e.getMessage());
                endStatus = -1;
            }
            if (isEndOk(endStatus)) {
                emitLog(seg.name + ": END verify OK (status " + endStatus + ")");
                return;
            }
            if (endStatus >= 0) {
                emitLog(seg.name + ": END verify FAILED (status " + endStatus + ")");
            }
            drainAcks();
            sleepInterruptibly(1_500);
        }
        throw new IllegalStateException("component " + seg.name + " failed after " + COMPONENT_RETRIES + " attempts");
    }

    private int flashComponent(String lens, String address, int index, int count, Segment seg, byte[] img,
            long bytesBefore, long totalBytes) throws TimeoutException {
        byte[] sub = Arrays.copyOfRange(img, seg.off, seg.off + 128);
        int ps = seg.ps;
        int payloadStart = seg.off + 128;

        int checkStatus = sendCtrlAndWait(address, OP_FILE_CHECK, sub, CTRL_ACK_TIMEOUT_MS);
        if (checkStatus != 0) {
            throw new IllegalStateException("FILE_CHECK rejected status=" + checkStatus);
        }

        int blockCount = (ps + BLOCK_SIZE - 1) / BLOCK_SIZE;
        for (int b = 0; b < blockCount; b++) {
            if (cancelled) {
                throw new IllegalStateException("Cancelled.");
            }
            int start = payloadStart + b * BLOCK_SIZE;
            int end = Math.min(start + BLOCK_SIZE, payloadStart + ps);
            byte[] block = Arrays.copyOfRange(img, start, end);

            boolean accepted = false;
            for (int tries = 0; tries < BLOCK_NAK_RETRIES; tries++) {
                int status = sendBlock(address, block); // throws TimeoutException -> component re-flash
                if (status == 0) {
                    accepted = true;
                    break;
                }
                emitLog(seg.name + ": block " + b + "/" + blockCount + " NAK=" + status
                    + " resend " + (tries + 1) + "/" + BLOCK_NAK_RETRIES);
            }
            if (!accepted) {
                throw new IllegalStateException("block " + b + " NAK'd " + BLOCK_NAK_RETRIES + " times");
            }
            if (b % 20 == 0 || b == blockCount - 1) {
                long bytesSent = bytesBefore + Math.min((long) (b + 1) * BLOCK_SIZE, (long) ps);
                emitProgress(lens, index + 1, count, b + 1, blockCount, bytesSent, totalBytes);
            }
        }
        emitLog(seg.name + ": data phase done; sending END");
        return sendCtrlAndWait(address, OP_END, EMPTY, CTRL_ACK_TIMEOUT_MS);
    }

    /** Send one 4 KB block as a marker + data pair sharing one envelope seq. */
    private int sendBlock(String address, byte[] block) throws TimeoutException {
        int seq = nextSeq();
        drainAcks();
        writeOta(address, BleProtocol.OTA_DATA_WRITE_UUID, SID_CTRL, new byte[] {(byte) OP_BLOCK}, seq);
        writeOta(address, BleProtocol.OTA_DATA_WRITE_UUID, SID_DATA, block, seq);
        return waitAck(OP_BLOCK, BLOCK_ACK_TIMEOUT_MS);
    }

    private int sendCtrlAndWait(String address, int op, byte[] data, int timeoutMs) throws TimeoutException {
        int seq = nextSeq();
        drainAcks();
        byte[] payload = new byte[1 + data.length];
        payload[0] = (byte) op;
        System.arraycopy(data, 0, payload, 1, data.length);
        writeOta(address, BleProtocol.OTA_DATA_WRITE_UUID, SID_CTRL, payload, seq);
        return waitAck(op, timeoutMs);
    }

    private boolean writeOta(String address, String writeChar, int sid, byte[] payload, int seq) {
        List<byte[]> frames = BleProtocol.framePb(payload, sid, FLAG_OTA, seq);
        return bleManager.writeFrames(
            address, writeChar, frames, AndroidProtocolPlatform.writeType(ConnectionOptions.WRITE_MODE), ConnectionOptions.WRITE_TIMEOUT_MS);
    }

    private int waitAck(int wantOp, int timeoutMs) throws TimeoutException {
        long deadline = SystemClock.elapsedRealtime() + timeoutMs;
        while (true) {
            long remaining = deadline - SystemClock.elapsedRealtime();
            if (remaining <= 0) {
                break;
            }
            byte[] pb;
            try {
                pb = dataAcks.poll(remaining, TimeUnit.MILLISECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new TimeoutException("interrupted waiting for ack op=" + wantOp);
            }
            if (pb == null) {
                break;
            }
            if (pb.length >= 2 && (pb[0] & 0xff) == wantOp) {
                return pb[1] & 0xff;
            }
            // Different opcode (e.g. a late ack from a prior stage) — ignore, keep waiting.
        }
        throw new TimeoutException("no ack op=0x" + Integer.toHexString(wantOp) + " within " + timeoutMs + "ms");
    }

    // ---- connection ----------------------------------------------------------

    private void connectLensResilient(String lens, String address, int windowMs) {
        long deadline = SystemClock.elapsedRealtime() + windowMs;
        String lastError = "unknown";
        int attempt = 0;
        while (SystemClock.elapsedRealtime() < deadline && !cancelled) {
            attempt++;
            try {
                if (bringUpLens(address)) {
                    emitLog("connected " + lens + " lens (attempt " + attempt + ")");
                    return;
                }
                lastError = "connect/discover incomplete";
            } catch (Exception e) {
                lastError = e.getMessage() == null ? e.toString() : e.getMessage();
            }
            emitLog(lens + " connect attempt " + attempt + " failed (" + lastError + "); retrying...");
            try {
                bleManager.disconnect(address);
            } catch (Exception ignored) {
            }
            sleepInterruptibly(RETRY_DELAY_MS);
        }
        if (cancelled) {
            throw new IllegalStateException("Cancelled.");
        }
        throw new IllegalStateException("could not reach " + lens + " lens: " + lastError);
    }

    private boolean bringUpLens(String address) {
        if (!bleManager.connect(address, ConnectionOptions.CONNECT_TIMEOUT_MS)) {
            return false;
        }
        bleManager.requestConnectionPriority(address, BluetoothGatt.CONNECTION_PRIORITY_HIGH);
        bleManager.requestMtu(address, ConnectionOptions.DESIRED_MTU, ConnectionOptions.CONNECT_TIMEOUT_MS);
        if (!bleManager.discoverServices(address, ConnectionOptions.SERVICES_TIMEOUT_MS)) {
            return false;
        }
        // Control-channel notify carries the auth response; mandatory.
        if (!bleManager.enableNotifications(address, BleProtocol.NOTIFY_CHAR_UUID, true, ConnectionOptions.DESCRIPTOR_TIMEOUT_MS)) {
            return false;
        }
        if (!bleManager.enableNotifications(address, BleProtocol.OTA_DATA_NOTIFY_UUID, true, ConnectionOptions.DESCRIPTOR_TIMEOUT_MS)) {
            return false;
        }
        if (!authenticate(address)) {
            throw new IllegalStateException(
                "security auth not acknowledged — if Android shows a Bluetooth pairing request, accept it");
        }
        return true;
    }

    /**
     * Complete the sid-0x80 security-auth exchange on this connection. On an
     * unbonded phone this triggers SMP pairing (possibly with an OS prompt),
     * so the wait is generous. Must succeed before any OTA traffic.
     */
    private boolean authenticate(String address) {
        int magic;
        CountDownLatch latch = new CountDownLatch(1);
        synchronized (lock) {
            magic = nextAuthMagic;
            nextAuthMagic = nextAuthMagic >= 0x7f ? 0x60 : nextAuthMagic + 1;
            pendingAuthMagic = magic;
            authAckPb = null;
            authLatch = latch;
        }
        try {
            if (!writeOta(address, BleProtocol.WRITE_CHAR_UUID, BleProtocol.SID_SECURITY_AUTH,
                    BleProtocol.buildAuthenticationRequest(magic), nextSeq())) {
                emitLog("auth write failed: " + address);
                return false;
            }
            boolean signalled;
            try {
                signalled = latch.await(ConnectionOptions.SECURITY_AUTH_TIMEOUT_MS, TimeUnit.MILLISECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return false;
            }
            byte[] pb;
            synchronized (lock) {
                pb = authAckPb;
            }
            if (!signalled || !BleProtocol.isAuthenticationSuccess(pb, magic)) {
                emitLog("security auth not acknowledged (" + address
                    + ") — if Android shows a Bluetooth pairing request, accept it");
                return false;
            }
            emitLog("security auth complete: " + address);
            return true;
        } finally {
            synchronized (lock) {
                pendingAuthMagic = -1;
                authLatch = null;
            }
        }
    }

    // ---- firmware container parsing / validation -----------------------------

    private static final byte[] EMPTY = new byte[0];

    private static final class Segment {
        final int off;
        final int ps;
        final long crc;
        final String name;

        Segment(int off, int ps, long crc, String name) {
            this.off = off;
            this.ps = ps;
            this.crc = crc;
            this.name = name;
        }
    }

    private List<Segment> parseSegments(byte[] img) {
        if (img.length < 0x40) {
            throw new IllegalStateException("file is too small to be a firmware image");
        }
        long n = readU32(img, 8);
        if (n <= 0 || n > 64) {
            throw new IllegalStateException("implausible component count " + n + " (corrupt image?)");
        }
        List<Segment> segs = new ArrayList<>();
        for (int i = 0; i < n; i++) {
            int base = 0x40 + i * 16;
            long crc = readU32(img, base + 12);
            int off = (int) readU32(img, base + 4);
            if (off + 128 > img.length) {
                throw new IllegalStateException("segment " + i + " subheader runs past end of file");
            }
            int ps = (int) readU32(img, off + 8);
            String name = readCString(img, off + 48, 80);
            segs.add(new Segment(off, ps, crc, name));
        }
        return segs;
    }

    private List<Segment> validate(byte[] img) {
        List<Segment> segs = parseSegments(img);
        if (segs.size() < MIN_SEGMENTS || segs.size() > MAX_SEGMENTS) {
            throw new IllegalStateException(
                "expected " + MIN_SEGMENTS + "-" + MAX_SEGMENTS + " components, found " + segs.size());
        }
        Segment main = null;
        for (Segment s : segs) {
            byte[] payload = Arrays.copyOfRange(img, s.off + 128, s.off + 128 + s.ps);
            long calc = crc32cMsb(payload) & 0xffffffffL;
            long subCrc = readU32(img, s.off + 12);
            if (calc != s.crc || calc != subCrc) {
                throw new IllegalStateException("component " + s.name + " CRC32C is stale (image not checksum-fixed)");
            }
            if (REQUIRED_SEGMENT.equals(s.name)) {
                main = s;
            }
        }
        if (main == null) {
            throw new IllegalStateException("required component " + REQUIRED_SEGMENT + " not found");
        }
        checkMainAppFitsMram(img, main);
        return segs;
    }

    private void checkMainAppFitsMram(byte[] img, Segment main) {
        if (main.ps < APP_PREAMBLE) {
            throw new IllegalStateException("main-app payload is smaller than its preamble");
        }
        long loadAddr = readU32(img, main.off + 128 + 0x14);
        long preLen = readU32(img, main.off + 128) & 0xFFFFFFL;
        if (loadAddr != APP_LOAD_ADDR) {
            throw new IllegalStateException(
                "main-app preamble load address is 0x" + Long.toHexString(loadAddr)
                    + ", expected 0x" + Long.toHexString(APP_LOAD_ADDR));
        }
        if (preLen != main.ps) {
            throw new IllegalStateException(
                "main-app preamble length (" + preLen + ") != staged payload size (" + main.ps + ")");
        }
        long progEnd = APP_LOAD_ADDR + main.ps - APP_PREAMBLE;
        if (progEnd > APP_MAX_END) {
            long over = progEnd - APP_MAX_END;
            throw new IllegalStateException(
                "main-app is too large: programmed region ends at 0x" + Long.toHexString(progEnd)
                    + ", " + over + " bytes past the safe MRAM ceiling — refusing to flash (brick risk)");
        }
    }

    // ---- listener callbacks --------------------------------------------------

    @Override
    public void onNotification(String address, String characteristicUuid, byte[] data) {
        if (BleProtocol.NOTIFY_CHAR_UUID.equalsIgnoreCase(characteristicUuid)) {
            // Control channel: only the security-auth response is awaited here.
            // A value can carry several envelope frames back to back (e.g. the
            // response packed with one of the lens's own sid-0x80 notifies).
            for (byte[] buf : BleProtocol.splitFrames(data)) {
                BleProtocol.ParsedFrame frame = BleProtocol.parseFrame(buf);
                if (frame.ok && frame.sid == BleProtocol.SID_SECURITY_AUTH) {
                    synchronized (lock) {
                        if (authLatch != null && frame.msgSeq == pendingAuthMagic) {
                            authAckPb = frame.pb;
                            authLatch.countDown();
                        }
                    }
                }
            }
            return;
        }
        if (!BleProtocol.OTA_DATA_NOTIFY_UUID.equalsIgnoreCase(characteristicUuid)) {
            return; // OTA acks arrive on the data-notify char
        }
        BleProtocol.ParsedFrame frame = BleProtocol.parseFrame(data);
        if (!frame.ok || frame.pb.length < 2) {
            return;
        }
        dataAcks.add(Arrays.copyOf(frame.pb, Math.min(frame.pb.length, 2)));
    }

    @Override
    public void onConnectionStateChange(String address, boolean connected) {
        if (!connected) {
            Log.i(TAG, "disconnected: " + address);
        }
    }

    // ---- helpers -------------------------------------------------------------

    private void teardown() {
        try {
            bleManager.close();
        } catch (Exception ignored) {
        }
    }

    private void resetSeq() {
        synchronized (lock) {
            nextSeq = 0;
        }
    }

    private int nextSeq() {
        synchronized (lock) {
            nextSeq = (nextSeq + 1) & 0xff;
            return nextSeq;
        }
    }

    private void drainAcks() {
        dataAcks.clear();
    }

    private static boolean isEndOk(int status) {
        for (int ok : END_OK) {
            if (ok == status) {
                return true;
            }
        }
        return false;
    }

    private void sleepInterruptibly(int ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    private static byte[] readFile(String path) {
        try (FileInputStream fis = new FileInputStream(path)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[65536];
            int read;
            while ((read = fis.read(buf)) >= 0) {
                out.write(buf, 0, read);
            }
            return out.toByteArray();
        } catch (IOException e) {
            throw new IllegalStateException("could not read firmware: " + e.getMessage(), e);
        }
    }

    private static long readU32(byte[] buf, int offset) {
        return (buf[offset] & 0xffL)
            | ((buf[offset + 1] & 0xffL) << 8)
            | ((buf[offset + 2] & 0xffL) << 16)
            | ((buf[offset + 3] & 0xffL) << 24);
    }

    private static String readCString(byte[] buf, int offset, int maxLen) {
        int end = offset;
        int limit = Math.min(buf.length, offset + maxLen);
        while (end < limit && buf[end] != 0) {
            end++;
        }
        return new String(buf, offset, end - offset, StandardCharsets.ISO_8859_1);
    }

    private static final int[] CRC32C_TABLE = buildCrc32cTable();

    private static int[] buildCrc32cTable() {
        int[] table = new int[256];
        for (int b = 0; b < 256; b++) {
            int c = b << 24;
            for (int i = 0; i < 8; i++) {
                c = (c & 0x80000000) != 0 ? (c << 1) ^ 0x1edc6f41 : c << 1;
            }
            table[b] = c;
        }
        return table;
    }

    /** CRC-32C, MSB-first, init 0, no final xor (matches g2flash.py crc32c_msb). */
    private static int crc32cMsb(byte[] data) {
        int crc = 0;
        for (byte value : data) {
            crc = (crc << 8) ^ CRC32C_TABLE[((crc >>> 24) ^ (value & 0xff)) & 0xff];
        }
        return crc;
    }

    private void emitLog(String line) {
        Log.i(TAG, line);
        mainHandler.post(() -> {
            FaceclawFirmwareFlasherListener current = listener;
            if (current != null) {
                current.onLog(line);
            }
        });
    }

    private void emitProgress(String lens, int componentIndex, int componentCount, int blockIndex, int blockCount,
            long bytesSent, long bytesTotal) {
        mainHandler.post(() -> {
            FaceclawFirmwareFlasherListener current = listener;
            if (current != null) {
                current.onProgress(lens, componentIndex, componentCount, blockIndex, blockCount, bytesSent, bytesTotal);
            }
        });
    }

    private void emitState(String state, String detail) {
        final String safeDetail = detail == null ? "" : detail;
        mainHandler.post(() -> {
            FaceclawFirmwareFlasherListener current = listener;
            if (current != null) {
                current.onState(state, safeDetail);
            }
        });
    }

    private void emitComplete(boolean success, String detail) {
        final String safeDetail = detail == null ? "" : detail;
        mainHandler.post(() -> {
            FaceclawFirmwareFlasherListener current = listener;
            if (current != null) {
                current.onComplete(success, safeDetail);
            }
        });
    }
}
