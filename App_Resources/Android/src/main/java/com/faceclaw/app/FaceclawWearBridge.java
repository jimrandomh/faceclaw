package com.faceclaw.app;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import com.google.android.gms.common.ConnectionResult;
import com.google.android.gms.common.GoogleApiAvailability;
import com.google.android.gms.wearable.CapabilityClient;
import com.google.android.gms.wearable.CapabilityInfo;
import com.google.android.gms.wearable.DataMap;
import com.google.android.gms.wearable.MessageEvent;
import com.google.android.gms.wearable.Node;
import com.google.android.gms.wearable.PutDataMapRequest;
import com.google.android.gms.wearable.PutDataRequest;
import com.google.android.gms.wearable.Wearable;

import org.json.JSONException;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Set;

/**
 * Phone side of the Wear OS integration: the single place that talks to the
 * Wearable Data Layer (Google Play services), so the JS side only ever sees
 * JSON strings and never touches Play services types.
 *
 * Inbound: FaceclawWearListenerService hands every watch message to
 * {@link #handleMessage}; it is forwarded to the JS listener on the thread
 * that registered it (the main isolate), mirroring FaceclawSettings. Messages
 * that arrive before a listener exists (the watch poked a phone whose JS
 * dashboard is not up yet) are acked with jsReady=false so the watch can say
 * "open Faceclaw on your phone"; only idempotent state requests are kept for
 * replay on registration — the watch already reported gestures and commands
 * as failed, and executing them tens of seconds later would act on whatever
 * the glasses happen to show by then.
 *
 * Outbound: {@link #publishState} mirrors the dashboard state into a Data
 * Layer item (delivered even if the watch is out of range right now, and
 * available to the watch app the moment it opens), while {@link #sendToWatch}
 * sends fire-and-forget messages (acks, assistant text) to every reachable
 * watch that advertises the Faceclaw watch-app capability.
 *
 * Everything is a no-op on phones without Google Play services.
 */
public final class FaceclawWearBridge {
    private static final String TAG = "FaceclawWear";

    /** Advertised by the watch app (wear/app/src/main/res/values/wear.xml). */
    public static final String CAPABILITY_WATCH = "faceclaw_watch";
    /** Advertised by this app (res/values/wear.xml) so the watch can find the phone. */
    public static final String CAPABILITY_PHONE = "faceclaw_phone";

    public static final String PATH_PREFIX = "/faceclaw";
    public static final String PATH_STATE = "/faceclaw/state";
    public static final String PATH_STATE_REQUEST = "/faceclaw/state/request";
    public static final String PATH_ACK = "/faceclaw/ack";
    public static final String PATH_EVENT = "/faceclaw/event";

    private static final String STATE_KEY_JSON = "json";
    private static final String STATE_KEY_UPDATED_AT = "updatedAt";

    /** Messages kept for a listener that is not registered yet. */
    private static final int PENDING_LIMIT = 16;
    private static final long PENDING_MAX_AGE_MS = 30_000;

    private static volatile FaceclawWearBridge instance;

    private final Context context;
    private final boolean available;
    private final Object lock = new Object();
    private FaceclawWearListener listener;
    private Handler listenerHandler;
    private final ArrayDeque<PendingMessage> pending = new ArrayDeque<>();
    private final List<Node> watchNodes = new ArrayList<>();
    private String lastPublishedState = null;

    private static final class PendingMessage {
        final String path;
        final String json;
        final String nodeId;
        final long receivedAt;

        PendingMessage(String path, String json, String nodeId, long receivedAt) {
            this.path = path;
            this.json = json;
            this.nodeId = nodeId;
            this.receivedAt = receivedAt;
        }
    }

    private FaceclawWearBridge(Context context) {
        this.context = context.getApplicationContext();
        boolean playServices;
        try {
            playServices = GoogleApiAvailability.getInstance()
                    .isGooglePlayServicesAvailable(this.context) == ConnectionResult.SUCCESS;
        } catch (Throwable error) {
            Log.w(TAG, "Play services availability check failed", error);
            playServices = false;
        }
        this.available = playServices;
        if (!available) {
            Log.i(TAG, "Google Play services unavailable; watch integration disabled");
        }
    }

    /** Initialize (idempotent) and return the singleton. */
    public static FaceclawWearBridge getInstance(Context context) {
        if (instance == null) {
            synchronized (FaceclawWearBridge.class) {
                if (instance == null) {
                    instance = new FaceclawWearBridge(context);
                }
            }
        }
        return instance;
    }

    /** Whether the Wearable Data Layer can be used on this phone at all. */
    public boolean isAvailable() {
        return available;
    }

    /**
     * Register the JS listener. Must be called from the thread whose isolate
     * owns it; that thread's Looper is captured for dispatch. Replays any
     * recently queued watch messages and refreshes the reachable-watch set.
     */
    public void setListener(FaceclawWearListener newListener) {
        Looper looper = Looper.myLooper();
        if (looper == null) {
            Log.w(TAG, "wear listener registered from a Looper-less thread; it will never be notified");
        }
        List<PendingMessage> replay;
        synchronized (lock) {
            listener = newListener;
            listenerHandler = looper != null ? new Handler(looper) : null;
            replay = new ArrayList<>(pending);
            pending.clear();
        }
        long now = System.currentTimeMillis();
        for (PendingMessage message : replay) {
            if (now - message.receivedAt <= PENDING_MAX_AGE_MS) {
                dispatchMessage(message.path, message.json, message.nodeId);
            }
        }
        refreshWatchNodes();
    }

    public void clearListener() {
        synchronized (lock) {
            listener = null;
            listenerHandler = null;
        }
    }

    public boolean isWatchReachable() {
        synchronized (lock) {
            return !watchNodes.isEmpty();
        }
    }

    /** Display name of a reachable watch ("" if none). */
    public String getWatchName() {
        synchronized (lock) {
            return watchNodes.isEmpty() ? "" : watchNodes.get(0).getDisplayName();
        }
    }

    /** Re-query which watches advertise the Faceclaw watch-app capability. */
    public void refreshWatchNodes() {
        if (!available) return;
        try {
            Wearable.getCapabilityClient(context)
                    .getCapability(CAPABILITY_WATCH, CapabilityClient.FILTER_REACHABLE)
                    .addOnSuccessListener(this::updateWatchNodes)
                    .addOnFailureListener(error -> Log.w(TAG, "capability query failed", error));
        } catch (Throwable error) {
            Log.w(TAG, "capability query failed", error);
        }
    }

    /**
     * Mirror the dashboard state to the watch. Identical consecutive states
     * are not re-sent (the Data Layer would drop them anyway).
     */
    public void publishState(String json) {
        publishState(json, false);
    }

    /** As {@link #publishState(String)}; `force` re-sends an unchanged state. */
    public void publishState(String json, boolean force) {
        if (!available || json == null) return;
        synchronized (lock) {
            if (!force && json.equals(lastPublishedState)) return;
            lastPublishedState = json;
        }
        try {
            PutDataMapRequest request = PutDataMapRequest.create(PATH_STATE);
            DataMap map = request.getDataMap();
            map.putString(STATE_KEY_JSON, json);
            map.putLong(STATE_KEY_UPDATED_AT, System.currentTimeMillis());
            PutDataRequest put = request.asPutDataRequest().setUrgent();
            Wearable.getDataClient(context)
                    .putDataItem(put)
                    .addOnFailureListener(error -> Log.w(TAG, "state publish failed", error));
        } catch (Throwable error) {
            Log.w(TAG, "state publish failed", error);
        }
    }

    /** Send a message to every reachable watch running the Faceclaw watch app. */
    public void sendToWatch(String path, String json) {
        if (!available) return;
        List<Node> targets;
        synchronized (lock) {
            targets = new ArrayList<>(watchNodes);
        }
        if (targets.isEmpty()) {
            // Nothing known yet (first message after boot): look the watch up, then send.
            try {
                Wearable.getCapabilityClient(context)
                        .getCapability(CAPABILITY_WATCH, CapabilityClient.FILTER_REACHABLE)
                        .addOnSuccessListener(info -> {
                            updateWatchNodes(info);
                            for (Node node : info.getNodes()) {
                                sendToNode(node.getId(), path, json);
                            }
                        })
                        .addOnFailureListener(error -> Log.w(TAG, "capability query failed", error));
            } catch (Throwable error) {
                Log.w(TAG, "capability query failed", error);
            }
            return;
        }
        for (Node node : targets) {
            sendToNode(node.getId(), path, json);
        }
    }

    /** Send a message to one specific node (e.g. an ack back to the sender). */
    public void sendToNode(String nodeId, String path, String json) {
        if (!available || nodeId == null || nodeId.isEmpty()) return;
        try {
            byte[] payload = (json != null ? json : "{}").getBytes(StandardCharsets.UTF_8);
            Wearable.getMessageClient(context)
                    .sendMessage(nodeId, path, payload)
                    .addOnFailureListener(error -> Log.w(TAG, "send " + path + " to " + nodeId + " failed", error));
        } catch (Throwable error) {
            Log.w(TAG, "send " + path + " failed", error);
        }
    }

    /** Reply to a watch message; `seq` echoes the watch's sequence number. */
    public void sendAck(String nodeId, long seq, boolean ok, boolean jsReady, String message) {
        JSONObject ack = new JSONObject();
        try {
            ack.put("seq", seq);
            ack.put("ok", ok);
            ack.put("jsReady", jsReady);
            ack.put("message", message != null ? message : "");
        } catch (JSONException ignored) {
            // The keys are constants; this cannot happen.
        }
        sendToNode(nodeId, PATH_ACK, ack.toString());
    }

    /** Entry point for FaceclawWearListenerService; may run on any thread. */
    void handleMessage(MessageEvent event) {
        if (event == null) return;
        String path = event.getPath();
        if (path == null || !path.startsWith(PATH_PREFIX)) return;
        byte[] data = event.getData();
        String json = data != null && data.length > 0 ? new String(data, StandardCharsets.UTF_8) : "{}";
        String nodeId = event.getSourceNodeId();
        Log.d(TAG, "recv " + path + " seq=" + readSeq(json));

        boolean delivered = dispatchMessage(path, json, nodeId);
        if (delivered) return;

        // No JS listener yet: tell the watch so it can explain why nothing is
        // happening. Only state requests are kept for replay (see class doc);
        // everything else is dropped after the failure ack.
        if (PATH_STATE_REQUEST.equals(path)) {
            synchronized (lock) {
                long now = System.currentTimeMillis();
                while (!pending.isEmpty() && now - pending.peekFirst().receivedAt > PENDING_MAX_AGE_MS) {
                    pending.pollFirst();
                }
                if (pending.size() >= PENDING_LIMIT) {
                    pending.pollFirst();
                }
                pending.addLast(new PendingMessage(path, json, nodeId, now));
            }
        }
        sendAck(nodeId, readSeq(json), false, false, "Faceclaw is not running on the phone. Open it to connect the glasses.");
    }

    /** Entry point for FaceclawWearListenerService's capability callback. */
    void handleCapabilityChanged(CapabilityInfo info) {
        if (info == null || !CAPABILITY_WATCH.equals(info.getName())) return;
        updateWatchNodes(info);
    }

    private void updateWatchNodes(CapabilityInfo info) {
        Set<Node> nodes = info != null ? info.getNodes() : Collections.<Node>emptySet();
        // Every reachable watch gets messages; a nearby (Bluetooth-linked)
        // one is listed first so it is the name the phone UI shows.
        List<Node> reachable = new ArrayList<>();
        for (Node node : nodes) {
            if (node.isNearby()) reachable.add(0, node); else reachable.add(node);
        }
        boolean changed;
        String name;
        synchronized (lock) {
            changed = !sameNodeIds(watchNodes, reachable);
            watchNodes.clear();
            watchNodes.addAll(reachable);
            name = watchNodes.isEmpty() ? "" : watchNodes.get(0).getDisplayName();
        }
        if (changed) {
            Log.i(TAG, reachable.isEmpty() ? "no Faceclaw watch reachable" : "watch reachable: " + name);
            boolean reachableNow = !reachable.isEmpty();
            FaceclawWearListener target;
            Handler handler;
            synchronized (lock) {
                target = listener;
                handler = listenerHandler;
            }
            if (target != null && handler != null) {
                handler.post(() -> {
                    try {
                        target.onWatchConnection(reachableNow, name);
                    } catch (Exception error) {
                        Log.w(TAG, "watch connection listener failed", error);
                    }
                });
            }
        }
    }

    private static boolean sameNodeIds(List<Node> a, List<Node> b) {
        if (a.size() != b.size()) return false;
        for (int i = 0; i < a.size(); i++) {
            if (!a.get(i).getId().equals(b.get(i).getId())) return false;
        }
        return true;
    }

    /** Post to the JS listener; false when there is none to post to. */
    private boolean dispatchMessage(String path, String json, String nodeId) {
        FaceclawWearListener target;
        Handler handler;
        synchronized (lock) {
            target = listener;
            handler = listenerHandler;
        }
        if (target == null || handler == null) return false;
        handler.post(() -> {
            try {
                target.onMessage(path, json, nodeId);
            } catch (Exception error) {
                Log.w(TAG, "wear message listener failed for " + path, error);
            }
        });
        return true;
    }

    private static long readSeq(String json) {
        try {
            return new JSONObject(json).optLong("seq", 0);
        } catch (JSONException error) {
            return 0;
        }
    }
}
