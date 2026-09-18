package com.faceclaw.app;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.CountDownLatch;

public final class RingHealthTransferTest implements AutoCloseable {
    private final Object lock = new Object();
    private final ArrayDeque<byte[]> ringOutbound = new ArrayDeque<>();
    private final ScheduledExecutorService callbacks = Executors.newSingleThreadScheduledExecutor();
    private final List<String> writes = new ArrayList<>();
    private volatile boolean running = true;
    private boolean ringConnected = true;
    private boolean ringNotificationsReady = true;
    private boolean ringHealthRspSeen;
    private int ringHealthPageCounter;
    private int seq;
    private boolean failAck;
    private boolean answer = true;
    private boolean delayRsp;
    private boolean pullRequested = true;
    private final CountDownLatch requestStarted = new CountDownLatch(1);
    private final String ringAddress = "ring";
    private long ringReconnectAfterMs;
    private static class ConnectionOptions { static final int RING_RECONNECT_DELAY_MS = 1000; }
    private static class BleManager { void disconnect(String address) {} }
    private final BleManager bleManager = new BleManager();
    private static String safeMessage(Throwable t) { return t.getMessage(); }
    private boolean shouldAttemptRingConnect() { return false; }
    private void tryConnectRing(String reason) { throw new AssertionError("unexpected connect"); }
    private void runRequestedRingHealthPull() {
        if (pullRequested) { pullRequested = false; requestRingHealth(); }
    }
    private void resumeAbortedRingHealthPull() {}
    private static final long RING_HEALTH_RSP_TIMEOUT_MS = 500;
    private static final long RING_HEALTH_DATA_IDLE_MS = 100;
    private static final int[] RING_DEVICE_PING_CMD_LO = {10, 1, 2, 11};

    private static class SystemClock {
        static long elapsedRealtime() { return System.nanoTime() / 1_000_000; }
    }

    private int nextRingSeqLocked() { return ++seq; }
    private int nextRingNonceLocked() { return seq; }
    private void logLine(String message) {}
    private void sendRingDevicePing(int command) {}

    private void page(int id) {
        synchronized (lock) {
            ringOutbound.add(new byte[] {(byte) id});
            ringHealthPageCounter++;
            lock.notifyAll();
        }
    }

    private boolean writeRingFrame(byte[] frame, String what) {
        if (Thread.holdsLock(lock)) throw new AssertionError("GATT write under session lock");
        if (what.equals("page ack")) {
            if (failAck) return false;
            int pageId = frame[0] & 0xff;
            writes.add("ack:" + pageId);
            // Exercise a write longer than the idle timeout. Page two arrives
            // only after page one's ACK has actually completed.
            try { Thread.sleep(130); } catch (InterruptedException e) { throw new AssertionError(e); }
            if (pageId % 10 == 1) callbacks.schedule(() -> page(pageId + 1), 5, TimeUnit.MILLISECONDS);
        } else {
            requestStarted.countDown();
            int command = RingProtocol.parse(frame).cmdHi;
            writes.add("req:" + command);
            if (answer) {
                page(command * 10 + 1);
                if (delayRsp) {
                    callbacks.schedule(() -> {
                        synchronized (lock) { ringHealthRspSeen = true; lock.notifyAll(); }
                    }, 20, TimeUnit.MILLISECONDS);
                } else {
                    synchronized (lock) { ringHealthRspSeen = true; lock.notifyAll(); }
                }
            }
        }
        return true;
    }

    // TRANSFER_METHODS

    @Override public void close() { callbacks.shutdownNow(); }

    public static void main(String[] args) throws Exception {
        try (RingHealthTransferTest transfer = new RingHealthTransferTest()) {
            transfer.answer = false;
            Thread worker = new Thread(transfer::runRingWorker);
            worker.start();
            if (!transfer.requestStarted.await(1, TimeUnit.SECONDS)) throw new AssertionError("no request");
            // The glasses sender can still take the session lock while the
            // ring is waiting on its RSP. Shutdown must cancel that wait too.
            long start = SystemClock.elapsedRealtime();
            synchronized (transfer.lock) { transfer.running = false; transfer.lock.notifyAll(); }
            worker.interrupt();
            worker.join(300);
            if (worker.isAlive()) throw new AssertionError("ring worker did not stop");
            if (SystemClock.elapsedRealtime() - start >= 300) throw new AssertionError("session lock blocked");
        }
        try (RingHealthTransferTest transfer = new RingHealthTransferTest()) {
            transfer.delayRsp = true;
            if (!transfer.requestRingHealth()) throw new AssertionError("pull failed");
            List<String> expected = new ArrayList<>();
            for (int command : RingProtocol.HEALTH_COMMANDS) {
                expected.add("req:" + command);
                expected.add("ack:" + (command * 10 + 1));
                expected.add("ack:" + (command * 10 + 2));
            }
            if (!transfer.writes.equals(expected)) throw new AssertionError("premature next type: " + transfer.writes);
        }
        try (RingHealthTransferTest transfer = new RingHealthTransferTest()) {
            transfer.failAck = true;
            if (transfer.requestRingHealth()) throw new AssertionError("failed ACK completed pull");
            if (transfer.writes.size() != 1) throw new AssertionError("advanced after failed ACK");
            if (transfer.ringOutbound.size() != 1) throw new AssertionError("failed ACK was discarded");
            transfer.failAck = false;
            if (!transfer.awaitRingHealthDataIdle(RING_HEALTH_DATA_IDLE_MS)) throw new AssertionError("retry failed");
            if (!transfer.ringOutbound.isEmpty()) throw new AssertionError("retry did not drain ACKs");
        }
        try (RingHealthTransferTest transfer = new RingHealthTransferTest()) {
            transfer.answer = false;
            if (transfer.requestRingHealth()) throw new AssertionError("missing RSP completed pull");
            if (transfer.writes.size() != 1) throw new AssertionError("advanced without RSP");
        }
        try (RingHealthTransferTest transfer = new RingHealthTransferTest()) {
            transfer.ringConnected = false;
            if (transfer.awaitRingHealthDataIdle(100)) throw new AssertionError("disconnect completed transfer");
        }
    }
}
