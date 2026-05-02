package com.faceclaw.app;
import java.util.ArrayDeque;
import java.util.HashMap;
import java.util.Map;
import android.os.SystemClock;

/**
 * Protobuf messages contain a 1-byte identifier that is used to identify
 * which message is referred to in ACK messages. We keep track of which
 * identifiers are in use for inflight messages, with some metadata about
 * what the message was. We allocate identifiers with an LRU policy so that
 * if we release a message's identifier because it timed out, we can still
 * detect late ACKs if it hasn't been reused yet.
 */
public final class BleMagicPool {
    static final int MIN_MAGIC = 100;
    static final int MAX_MAGIC = 255;

    private final ArrayDeque<Integer> available = new ArrayDeque<>();
    private final boolean[] allocated = new boolean[256];
    private final Map<String, ReleaseRecord> releaseRecords = new HashMap<>();

    BleMagicPool() {
        for (int magic = MIN_MAGIC; magic <= MAX_MAGIC; magic++) {
            available.addLast(magic);
        }
    }

    synchronized int allocate() {
        Integer magic = available.pollFirst();
        if (magic == null) {
            throw new IllegalStateException("no BLE magic values available");
        }
        allocated[magic] = true;
        return magic;
    }

    synchronized void release(int sid, int magic, String label, String reason) {
        if (magic < MIN_MAGIC || magic > MAX_MAGIC) {
            return;
        }
        releaseRecords.put(key(sid, magic), new ReleaseRecord(label, reason, SystemClock.elapsedRealtime()));
        if (!allocated[magic]) {
            return;
        }
        allocated[magic] = false;
        available.addLast(magic);
    }

    synchronized ReleaseRecord getReleaseRecord(int sid, int magic) {
        return releaseRecords.get(key(sid, magic));
    }

    private static String key(int sid, int magic) {
        return sid + ":" + magic;
    }

    public static final class ReleaseRecord {
        final String label;
        final String reason;
        final long releasedAtMs;

        ReleaseRecord(String label, String reason, long releasedAtMs) {
            this.label = label == null ? "" : label;
            this.reason = reason == null ? "" : reason;
            this.releasedAtMs = releasedAtMs;
        }
    }
}
