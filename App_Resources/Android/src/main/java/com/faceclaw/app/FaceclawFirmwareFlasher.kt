package com.faceclaw.app

import android.bluetooth.BluetoothGatt
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log

import java.io.ByteArrayOutputStream
import java.io.FileInputStream
import java.io.IOException
import java.nio.charset.StandardCharsets
import java.util.ArrayList
import java.util.Arrays
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

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
class FaceclawFirmwareFlasher(context: Context, rightAddress: String?, leftAddress: String?, firmwarePath: String?) : FaceclawBleListener {
    companion object {
        private const val TAG = "FaceclawFlasher"

        // OTA message types (envelope sid byte) and control opcodes.
        private const val SID_CTRL = 0xc0
        private const val SID_DATA = 0xc1
        private const val FLAG_OTA = 0x00
        private const val OP_BEGIN = 0x00
        private const val OP_FILE_CHECK = 0x01
        private const val OP_BLOCK = 0x02
        private const val OP_END = 0x03

        private const val BLOCK_SIZE = 4096
        private const val BLOCK_ACK_TIMEOUT_MS = 4_000
        private const val CTRL_ACK_TIMEOUT_MS = 8_000
        private const val BLOCK_NAK_RETRIES = 3
        private const val COMPONENT_RETRIES = 3

        // Reconnect windows. The first lens connects from an idle device; the second
        // must ride out the post-first-lens reboot of both lenses.
        private const val FIRST_LENS_CONNECT_WINDOW_MS = 30_000
        private const val SECOND_LENS_CONNECT_WINDOW_MS = 120_000
        private const val REBOOT_SETTLE_MS = 5_000
        private const val NOTIFY_SETTLE_MS = 2_500
        private const val RETRY_DELAY_MS = 2_500

        // END ack statuses that mean "component accepted": SUCCESS, UPDATING, SYS_RESTART.
        private val END_OK = intArrayOf(0, 8, 9)

        // Firmware layout expectations (mirrors g2flash.py). Firmware 2.2.4 has 5
        // components; 2.2.6 has 6.
        private const val MIN_SEGMENTS = 5
        private const val MAX_SEGMENTS = 6
        private const val REQUIRED_SEGMENT = "ota/s200_firmware_ota.bin"
        private const val APP_LOAD_ADDR = 0x00438000L
        private const val APP_MAX_END = 0x007F0000L
        private const val APP_PREAMBLE = 0x20

        // ---- firmware container parsing / validation -----------------------------

        private val EMPTY = ByteArray(0)

        // ---- helpers -------------------------------------------------------------

        private fun isEndOk(status: Int): Boolean {
            for (ok in END_OK) {
                if (ok == status) {
                    return true
                }
            }
            return false
        }

        private fun readFile(path: String): ByteArray {
            try {
                FileInputStream(path).use { fis ->
                    val out = ByteArrayOutputStream()
                    val buf = ByteArray(65536)
                    var read: Int
                    while (fis.read(buf).also { read = it } >= 0) {
                        out.write(buf, 0, read)
                    }
                    return out.toByteArray()
                }
            } catch (e: IOException) {
                throw IllegalStateException("could not read firmware: " + e.message, e)
            }
        }

        private fun readU32(buf: ByteArray, offset: Int): Long {
            return (buf[offset].toLong() and 0xffL) or
                ((buf[offset + 1].toLong() and 0xffL) shl 8) or
                ((buf[offset + 2].toLong() and 0xffL) shl 16) or
                ((buf[offset + 3].toLong() and 0xffL) shl 24)
        }

        private fun readCString(buf: ByteArray, offset: Int, maxLen: Int): String {
            var end = offset
            val limit = Math.min(buf.size, offset + maxLen)
            while (end < limit && buf[end].toInt() != 0) {
                end++
            }
            return String(buf, offset, end - offset, StandardCharsets.ISO_8859_1)
        }

        private val CRC32C_TABLE: IntArray = buildCrc32cTable()

        private fun buildCrc32cTable(): IntArray {
            val table = IntArray(256)
            for (b in 0 until 256) {
                var c = b shl 24
                for (i in 0 until 8) {
                    c = if ((c and 0x80000000.toInt()) != 0) (c shl 1) xor 0x1edc6f41 else c shl 1
                }
                table[b] = c
            }
            return table
        }

        /** CRC-32C, MSB-first, init 0, no final xor (matches g2flash.py crc32c_msb). */
        private fun crc32cMsb(data: ByteArray): Int {
            var crc = 0
            for (value in data) {
                crc = (crc shl 8) xor CRC32C_TABLE[((crc ushr 24) xor (value.toInt() and 0xff)) and 0xff]
            }
            return crc
        }
    }

    private val context: Context
    private val leftAddress: String
    private val rightAddress: String
    private val firmwarePath: String
    private val bleManager: FaceclawBleManager
    private val mainHandler = Handler(Looper.getMainLooper())

    private val lock = Any()
    private val dataAcks = LinkedBlockingQueue<ByteArray>()

    @Volatile
    private var listener: FaceclawFirmwareFlasherListener? = null
    @Volatile
    private var worker: Thread? = null
    @Volatile
    private var cancelled = false

    private var nextSeq = 0
    private var nextAuthMagic = 0x60
    private var pendingAuthMagic = -1
    private var authLatch: CountDownLatch? = null
    private var authAckPb: ByteArray? = null

    init {
        this.context = context.applicationContext
        this.rightAddress = rightAddress ?: ""
        this.leftAddress = leftAddress ?: ""
        this.firmwarePath = firmwarePath ?: ""
        this.bleManager = FaceclawBleManager(this.context)
        this.bleManager.setListener(this)
    }

    fun setListener(listener: FaceclawFirmwareFlasherListener?) {
        this.listener = listener
    }

    fun start() {
        synchronized(lock) {
            if (worker != null) {
                return
            }
            val w = Thread({ run() }, "faceclaw-flasher")
            worker = w
            w.start()
        }
    }

    fun cancel() {
        cancelled = true
        val w = worker
        if (w != null) {
            w.interrupt()
        }
    }

    fun close() {
        cancel()
        try {
            bleManager.close()
        } catch (ignored: Exception) {
        }
    }

    private fun run() {
        try {
            if (leftAddress.trim().isEmpty() || rightAddress.trim().isEmpty()) {
                throw IllegalStateException("Both lens addresses are required to flash.")
            }

            emitState("validating", "")
            val img = readFile(firmwarePath)
            val segs = validate(img)
            emitLog("firmware validated: " + segs.size + " components, " + img.size + " bytes")

            flashLens("left", leftAddress, img, segs, FIRST_LENS_CONNECT_WINDOW_MS)
            if (cancelled) {
                emitState("error", "Cancelled.")
                emitComplete(false, "Cancelled after the left lens.")
                return
            }

            emitState("rebooting", "Left lens done. Both lenses reboot briefly; reconnecting for the right lens.")
            sleepInterruptibly(REBOOT_SETTLE_MS)
            flashLens("right", rightAddress, img, segs, SECOND_LENS_CONNECT_WINDOW_MS)

            emitState("done", "")
            emitComplete(true, "Both lenses flashed. The glasses are rebooting into the custom firmware.")
        } catch (e: Exception) {
            var message = if (e.message == null) e.toString() else e.message
            if (cancelled) {
                message = "Cancelled."
            }
            emitState("error", message)
            emitComplete(false, message)
        } finally {
            teardown()
        }
    }

    @Throws(TimeoutException::class)
    private fun flashLens(lens: String, address: String, img: ByteArray, segs: List<Segment>, connectWindowMs: Int) {
        emitState("connecting", lens)
        connectLensResilient(lens, address, connectWindowMs)
        sleepInterruptibly(NOTIFY_SETTLE_MS)
        drainAcks()
        // Fresh envelope counter for the OTA stream (the auth exchange during
        // bring-up used its own); mirrors the stock sequence.
        resetSeq()

        emitState("flashing", lens)
        val beginStatus = sendCtrlAndWait(address, OP_BEGIN, EMPTY, CTRL_ACK_TIMEOUT_MS)
        if (!isEndOk(beginStatus)) {
            emitLog("warning: unexpected begin status $beginStatus; continuing")
        }
        // Progress is reported in bytes across the whole image: the segments
        // are one large firmware blob plus several small ones, so a bar
        // stepped per segment would sit still through the big one and then
        // sprint through the rest.
        var totalBytes = 0L
        for (seg in segs) {
            totalBytes += seg.ps
        }
        var bytesBefore = 0L
        for (i in segs.indices) {
            if (cancelled) {
                throw IllegalStateException("Cancelled.")
            }
            flashComponentWithRetry(lens, address, i, segs.size, segs[i], img, bytesBefore, totalBytes)
            bytesBefore += segs[i].ps
        }
        emitLog("$lens lens: all components verified")
        try {
            bleManager.disconnect(address)
        } catch (ignored: Exception) {
        }
    }

    private fun flashComponentWithRetry(lens: String, address: String, index: Int, count: Int, seg: Segment, img: ByteArray,
            bytesBefore: Long, totalBytes: Long) {
        for (attempt in 0 until COMPONENT_RETRIES) {
            if (attempt > 0) {
                emitLog(seg.name + ": re-flash attempt " + (attempt + 1) + "/" + COMPONENT_RETRIES)
            }
            var endStatus: Int
            try {
                endStatus = flashComponent(lens, address, index, count, seg, img, bytesBefore, totalBytes)
            } catch (e: TimeoutException) {
                emitLog(seg.name + ": block phase failed: " + e.message)
                endStatus = -1
            } catch (e: RuntimeException) {
                emitLog(seg.name + ": block phase failed: " + e.message)
                endStatus = -1
            }
            if (isEndOk(endStatus)) {
                emitLog(seg.name + ": END verify OK (status " + endStatus + ")")
                return
            }
            if (endStatus >= 0) {
                emitLog(seg.name + ": END verify FAILED (status " + endStatus + ")")
            }
            drainAcks()
            sleepInterruptibly(1_500)
        }
        throw IllegalStateException("component " + seg.name + " failed after " + COMPONENT_RETRIES + " attempts")
    }

    @Throws(TimeoutException::class)
    private fun flashComponent(lens: String, address: String, index: Int, count: Int, seg: Segment, img: ByteArray,
            bytesBefore: Long, totalBytes: Long): Int {
        val sub = Arrays.copyOfRange(img, seg.off, seg.off + 128)
        val ps = seg.ps
        val payloadStart = seg.off + 128

        val checkStatus = sendCtrlAndWait(address, OP_FILE_CHECK, sub, CTRL_ACK_TIMEOUT_MS)
        if (checkStatus != 0) {
            throw IllegalStateException("FILE_CHECK rejected status=$checkStatus")
        }

        val blockCount = (ps + BLOCK_SIZE - 1) / BLOCK_SIZE
        for (b in 0 until blockCount) {
            if (cancelled) {
                throw IllegalStateException("Cancelled.")
            }
            val start = payloadStart + b * BLOCK_SIZE
            val end = Math.min(start + BLOCK_SIZE, payloadStart + ps)
            val block = Arrays.copyOfRange(img, start, end)

            var accepted = false
            for (tries in 0 until BLOCK_NAK_RETRIES) {
                val status = sendBlock(address, block) // throws TimeoutException -> component re-flash
                if (status == 0) {
                    accepted = true
                    break
                }
                emitLog(seg.name + ": block " + b + "/" + blockCount + " NAK=" + status
                    + " resend " + (tries + 1) + "/" + BLOCK_NAK_RETRIES)
            }
            if (!accepted) {
                throw IllegalStateException("block " + b + " NAK'd " + BLOCK_NAK_RETRIES + " times")
            }
            if (b % 20 == 0 || b == blockCount - 1) {
                val bytesSent = bytesBefore + Math.min((b + 1).toLong() * BLOCK_SIZE, ps.toLong())
                emitProgress(lens, index + 1, count, b + 1, blockCount, bytesSent, totalBytes)
            }
        }
        emitLog(seg.name + ": data phase done; sending END")
        return sendCtrlAndWait(address, OP_END, EMPTY, CTRL_ACK_TIMEOUT_MS)
    }

    /** Send one 4 KB block as a marker + data pair sharing one envelope seq. */
    @Throws(TimeoutException::class)
    private fun sendBlock(address: String, block: ByteArray): Int {
        val seq = nextSeq()
        drainAcks()
        writeOta(address, BleProtocol.OTA_DATA_WRITE_UUID, SID_CTRL, byteArrayOf(OP_BLOCK.toByte()), seq)
        writeOta(address, BleProtocol.OTA_DATA_WRITE_UUID, SID_DATA, block, seq)
        return waitAck(OP_BLOCK, BLOCK_ACK_TIMEOUT_MS)
    }

    @Throws(TimeoutException::class)
    private fun sendCtrlAndWait(address: String, op: Int, data: ByteArray, timeoutMs: Int): Int {
        val seq = nextSeq()
        drainAcks()
        val payload = ByteArray(1 + data.size)
        payload[0] = op.toByte()
        System.arraycopy(data, 0, payload, 1, data.size)
        writeOta(address, BleProtocol.OTA_DATA_WRITE_UUID, SID_CTRL, payload, seq)
        return waitAck(op, timeoutMs)
    }

    private fun writeOta(address: String, writeChar: String, sid: Int, payload: ByteArray, seq: Int): Boolean {
        val frames = BleProtocol.framePb(payload, sid, FLAG_OTA, seq)
        return bleManager.writeFrames(
            address, writeChar, frames, AndroidProtocolPlatform.writeType(ConnectionOptions.WRITE_MODE), ConnectionOptions.WRITE_TIMEOUT_MS)
    }

    @Throws(TimeoutException::class)
    private fun waitAck(wantOp: Int, timeoutMs: Int): Int {
        val deadline = SystemClock.elapsedRealtime() + timeoutMs
        while (true) {
            val remaining = deadline - SystemClock.elapsedRealtime()
            if (remaining <= 0) {
                break
            }
            val pb: ByteArray?
            try {
                pb = dataAcks.poll(remaining, TimeUnit.MILLISECONDS)
            } catch (e: InterruptedException) {
                Thread.currentThread().interrupt()
                throw TimeoutException("interrupted waiting for ack op=$wantOp")
            }
            if (pb == null) {
                break
            }
            if (pb.size >= 2 && (pb[0].toInt() and 0xff) == wantOp) {
                return pb[1].toInt() and 0xff
            }
            // Different opcode (e.g. a late ack from a prior stage) — ignore, keep waiting.
        }
        throw TimeoutException("no ack op=0x" + Integer.toHexString(wantOp) + " within " + timeoutMs + "ms")
    }

    // ---- connection ----------------------------------------------------------

    private fun connectLensResilient(lens: String, address: String, windowMs: Int) {
        val deadline = SystemClock.elapsedRealtime() + windowMs
        var lastError: String? = "unknown"
        var attempt = 0
        while (SystemClock.elapsedRealtime() < deadline && !cancelled) {
            attempt++
            try {
                if (bringUpLens(address)) {
                    emitLog("connected $lens lens (attempt $attempt)")
                    return
                }
                lastError = "connect/discover incomplete"
            } catch (e: Exception) {
                lastError = if (e.message == null) e.toString() else e.message
            }
            emitLog("$lens connect attempt $attempt failed ($lastError); retrying...")
            try {
                bleManager.disconnect(address)
            } catch (ignored: Exception) {
            }
            sleepInterruptibly(RETRY_DELAY_MS)
        }
        if (cancelled) {
            throw IllegalStateException("Cancelled.")
        }
        throw IllegalStateException("could not reach $lens lens: $lastError")
    }

    private fun bringUpLens(address: String): Boolean {
        if (!bleManager.connect(address, ConnectionOptions.CONNECT_TIMEOUT_MS)) {
            return false
        }
        bleManager.requestConnectionPriority(address, BluetoothGatt.CONNECTION_PRIORITY_HIGH)
        bleManager.requestMtu(address, ConnectionOptions.DESIRED_MTU, ConnectionOptions.CONNECT_TIMEOUT_MS)
        if (!bleManager.discoverServices(address, ConnectionOptions.SERVICES_TIMEOUT_MS)) {
            return false
        }
        // Control-channel notify carries the auth response; mandatory.
        if (!bleManager.enableNotifications(address, BleProtocol.NOTIFY_CHAR_UUID, true, ConnectionOptions.DESCRIPTOR_TIMEOUT_MS)) {
            return false
        }
        if (!bleManager.enableNotifications(address, BleProtocol.OTA_DATA_NOTIFY_UUID, true, ConnectionOptions.DESCRIPTOR_TIMEOUT_MS)) {
            return false
        }
        if (!authenticate(address)) {
            throw IllegalStateException(
                "security auth not acknowledged — if Android shows a Bluetooth pairing request, accept it")
        }
        return true
    }

    /**
     * Complete the sid-0x80 security-auth exchange on this connection. On an
     * unbonded phone this triggers SMP pairing (possibly with an OS prompt),
     * so the wait is generous. Must succeed before any OTA traffic.
     */
    private fun authenticate(address: String): Boolean {
        val magic: Int
        val latch = CountDownLatch(1)
        synchronized(lock) {
            magic = nextAuthMagic
            nextAuthMagic = if (nextAuthMagic >= 0x7f) 0x60 else nextAuthMagic + 1
            pendingAuthMagic = magic
            authAckPb = null
            authLatch = latch
        }
        try {
            if (!writeOta(address, BleProtocol.WRITE_CHAR_UUID, BleProtocol.SID_SECURITY_AUTH,
                    BleProtocol.buildAuthenticationRequest(magic), nextSeq())) {
                emitLog("auth write failed: $address")
                return false
            }
            val signalled: Boolean
            try {
                signalled = latch.await(ConnectionOptions.SECURITY_AUTH_TIMEOUT_MS.toLong(), TimeUnit.MILLISECONDS)
            } catch (e: InterruptedException) {
                Thread.currentThread().interrupt()
                return false
            }
            val pb: ByteArray?
            synchronized(lock) {
                pb = authAckPb
            }
            if (!signalled || !BleProtocol.isAuthenticationSuccess(pb, magic)) {
                emitLog("security auth not acknowledged (" + address
                    + ") — if Android shows a Bluetooth pairing request, accept it")
                return false
            }
            emitLog("security auth complete: $address")
            return true
        } finally {
            synchronized(lock) {
                pendingAuthMagic = -1
                authLatch = null
            }
        }
    }

    // ---- firmware container parsing / validation -----------------------------

    private class Segment(
        @JvmField val off: Int,
        @JvmField val ps: Int,
        @JvmField val crc: Long,
        @JvmField val name: String
    )

    private fun parseSegments(img: ByteArray): List<Segment> {
        if (img.size < 0x40) {
            throw IllegalStateException("file is too small to be a firmware image")
        }
        val n = readU32(img, 8)
        if (n <= 0 || n > 64) {
            throw IllegalStateException("implausible component count $n (corrupt image?)")
        }
        val segs = ArrayList<Segment>()
        var i = 0
        while (i < n) {
            val base = 0x40 + i * 16
            val crc = readU32(img, base + 12)
            val off = readU32(img, base + 4).toInt()
            if (off + 128 > img.size) {
                throw IllegalStateException("segment $i subheader runs past end of file")
            }
            val ps = readU32(img, off + 8).toInt()
            val name = readCString(img, off + 48, 80)
            segs.add(Segment(off, ps, crc, name))
            i++
        }
        return segs
    }

    private fun validate(img: ByteArray): List<Segment> {
        val segs = parseSegments(img)
        if (segs.size < MIN_SEGMENTS || segs.size > MAX_SEGMENTS) {
            throw IllegalStateException(
                "expected " + MIN_SEGMENTS + "-" + MAX_SEGMENTS + " components, found " + segs.size)
        }
        var main: Segment? = null
        for (s in segs) {
            val payload = Arrays.copyOfRange(img, s.off + 128, s.off + 128 + s.ps)
            val calc = crc32cMsb(payload).toLong() and 0xffffffffL
            val subCrc = readU32(img, s.off + 12)
            if (calc != s.crc || calc != subCrc) {
                throw IllegalStateException("component " + s.name + " CRC32C is stale (image not checksum-fixed)")
            }
            if (REQUIRED_SEGMENT == s.name) {
                main = s
            }
        }
        if (main == null) {
            throw IllegalStateException("required component $REQUIRED_SEGMENT not found")
        }
        checkMainAppFitsMram(img, main)
        return segs
    }

    private fun checkMainAppFitsMram(img: ByteArray, main: Segment) {
        if (main.ps < APP_PREAMBLE) {
            throw IllegalStateException("main-app payload is smaller than its preamble")
        }
        val loadAddr = readU32(img, main.off + 128 + 0x14)
        val preLen = readU32(img, main.off + 128) and 0xFFFFFFL
        if (loadAddr != APP_LOAD_ADDR) {
            throw IllegalStateException(
                "main-app preamble load address is 0x" + java.lang.Long.toHexString(loadAddr)
                    + ", expected 0x" + java.lang.Long.toHexString(APP_LOAD_ADDR))
        }
        if (preLen != main.ps.toLong()) {
            throw IllegalStateException(
                "main-app preamble length (" + preLen + ") != staged payload size (" + main.ps + ")")
        }
        val progEnd = APP_LOAD_ADDR + main.ps - APP_PREAMBLE
        if (progEnd > APP_MAX_END) {
            val over = progEnd - APP_MAX_END
            throw IllegalStateException(
                "main-app is too large: programmed region ends at 0x" + java.lang.Long.toHexString(progEnd)
                    + ", " + over + " bytes past the safe MRAM ceiling — refusing to flash (brick risk)")
        }
    }

    // ---- listener callbacks --------------------------------------------------

    override fun onNotification(address: String?, characteristicUuid: String?, data: ByteArray?) {
        if (BleProtocol.NOTIFY_CHAR_UUID.equals(characteristicUuid, ignoreCase = true)) {
            // Control channel: only the security-auth response is awaited here.
            // A value can carry several envelope frames back to back (e.g. the
            // response packed with one of the lens's own sid-0x80 notifies).
            for (buf in BleProtocol.splitFrames(data)) {
                val frame = BleProtocol.parseFrame(buf)
                if (frame.ok && frame.sid == BleProtocol.SID_SECURITY_AUTH) {
                    synchronized(lock) {
                        val currentLatch = authLatch
                        if (currentLatch != null && frame.msgSeq == pendingAuthMagic) {
                            authAckPb = frame.pb
                            currentLatch.countDown()
                        }
                    }
                }
            }
            return
        }
        if (!BleProtocol.OTA_DATA_NOTIFY_UUID.equals(characteristicUuid, ignoreCase = true)) {
            return // OTA acks arrive on the data-notify char
        }
        val frame = BleProtocol.parseFrame(data)
        if (!frame.ok || frame.pb.size < 2) {
            return
        }
        dataAcks.add(Arrays.copyOf(frame.pb, Math.min(frame.pb.size, 2)))
    }

    override fun onConnectionStateChange(address: String?, connected: Boolean) {
        if (!connected) {
            Log.i(TAG, "disconnected: $address")
        }
    }

    // ---- helpers -------------------------------------------------------------

    private fun teardown() {
        try {
            bleManager.close()
        } catch (ignored: Exception) {
        }
    }

    private fun resetSeq() {
        synchronized(lock) {
            nextSeq = 0
        }
    }

    private fun nextSeq(): Int {
        synchronized(lock) {
            nextSeq = (nextSeq + 1) and 0xff
            return nextSeq
        }
    }

    private fun drainAcks() {
        dataAcks.clear()
    }

    private fun sleepInterruptibly(ms: Int) {
        try {
            Thread.sleep(ms.toLong())
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
        }
    }

    private fun emitLog(line: String) {
        Log.i(TAG, line)
        mainHandler.post {
            val current = listener
            if (current != null) {
                current.onLog(line)
            }
        }
    }

    private fun emitProgress(lens: String, componentIndex: Int, componentCount: Int, blockIndex: Int, blockCount: Int,
            bytesSent: Long, bytesTotal: Long) {
        mainHandler.post {
            val current = listener
            if (current != null) {
                current.onProgress(lens, componentIndex, componentCount, blockIndex, blockCount, bytesSent, bytesTotal)
            }
        }
    }

    private fun emitState(state: String, detail: String?) {
        val safeDetail = detail ?: ""
        mainHandler.post {
            val current = listener
            if (current != null) {
                current.onState(state, safeDetail)
            }
        }
    }

    private fun emitComplete(success: Boolean, detail: String?) {
        val safeDetail = detail ?: ""
        mainHandler.post {
            val current = listener
            if (current != null) {
                current.onComplete(success, safeDetail)
            }
        }
    }
}
