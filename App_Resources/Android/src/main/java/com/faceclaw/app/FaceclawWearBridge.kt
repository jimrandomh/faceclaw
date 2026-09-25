package com.faceclaw.app

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log

import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import com.google.android.gms.wearable.CapabilityClient
import com.google.android.gms.wearable.CapabilityInfo
import com.google.android.gms.wearable.DataMap
import com.google.android.gms.wearable.MessageEvent
import com.google.android.gms.wearable.Node
import com.google.android.gms.wearable.PutDataMapRequest
import com.google.android.gms.wearable.PutDataRequest
import com.google.android.gms.wearable.Wearable

import org.json.JSONException
import org.json.JSONObject

import java.nio.charset.StandardCharsets
import java.util.ArrayDeque
import java.util.ArrayList
import java.util.Collections

/**
 * Phone side of the Wear OS integration: the single place that talks to the
 * Wearable Data Layer (Google Play services), so the JS side only ever sees
 * JSON strings and never touches Play services types.
 *
 * Inbound: FaceclawWearListenerService hands every watch message to
 * [handleMessage]; it is forwarded to the JS listener on the thread
 * that registered it (the main isolate), mirroring FaceclawSettings. Messages
 * that arrive before a listener exists (the watch poked a phone whose JS
 * dashboard is not up yet) are acked with jsReady=false so the watch can say
 * "open Faceclaw on your phone"; only idempotent state requests are kept for
 * replay on registration — the watch already reported gestures and commands
 * as failed, and executing them tens of seconds later would act on whatever
 * the glasses happen to show by then.
 *
 * Outbound: [publishState] mirrors the dashboard state into a Data
 * Layer item (delivered even if the watch is out of range right now, and
 * available to the watch app the moment it opens), while [sendToWatch]
 * sends fire-and-forget messages (acks, assistant text) to every reachable
 * watch that advertises the Faceclaw watch-app capability.
 *
 * Everything is a no-op on phones without Google Play services.
 */
class FaceclawWearBridge private constructor(context: Context) {
    companion object {
        private const val TAG = "FaceclawWear"

        /** Advertised by the watch app (wear/app/src/main/res/values/wear.xml). */
        const val CAPABILITY_WATCH = "faceclaw_watch"
        /** Advertised by this app (res/values/wear.xml) so the watch can find the phone. */
        const val CAPABILITY_PHONE = "faceclaw_phone"

        const val PATH_PREFIX = "/faceclaw"
        const val PATH_STATE = "/faceclaw/state"
        const val PATH_STATE_REQUEST = "/faceclaw/state/request"
        /** Watch -> phone: the watch's own battery; carries no seq and is never acked. */
        const val PATH_WATCH_BATTERY = "/faceclaw/battery"
        /** Phone -> watch: answered with PATH_WATCH_BATTERY even while the watch app is closed. */
        const val PATH_WATCH_BATTERY_REQUEST = "/faceclaw/battery/request"
        const val PATH_ACK = "/faceclaw/ack"
        const val PATH_EVENT = "/faceclaw/event"

        private const val STATE_KEY_JSON = "json"
        private const val STATE_KEY_UPDATED_AT = "updatedAt"

        /** Messages kept for a listener that is not registered yet. */
        private const val PENDING_LIMIT = 16
        private const val PENDING_MAX_AGE_MS = 30_000L

        @Volatile
        private var instance: FaceclawWearBridge? = null

        /** Initialize (idempotent) and return the singleton. */
        @JvmStatic
        fun getInstance(context: Context): FaceclawWearBridge {
            if (instance == null) {
                synchronized(FaceclawWearBridge::class.java) {
                    if (instance == null) {
                        instance = FaceclawWearBridge(context)
                    }
                }
            }
            return instance!!
        }

        private fun sameNodeIds(a: List<Node>, b: List<Node>): Boolean {
            if (a.size != b.size) return false
            for (i in a.indices) {
                if (a[i].id != b[i].id) return false
            }
            return true
        }

        private fun readSeq(json: String): Long {
            try {
                return JSONObject(json).optLong("seq", 0)
            } catch (error: JSONException) {
                return 0
            }
        }
    }

    private val context: Context
    private val available: Boolean
    private val lock = Any()
    private var listener: FaceclawWearListener? = null
    private var listenerHandler: Handler? = null
    private val pending = ArrayDeque<PendingMessage>()
    private val watchNodes: MutableList<Node> = ArrayList()
    private var lastPublishedState: String? = null

    private class PendingMessage(
        val path: String,
        val json: String,
        val nodeId: String?,
        val receivedAt: Long,
    )

    init {
        this.context = context.applicationContext
        var playServices: Boolean
        try {
            playServices = GoogleApiAvailability.getInstance()
                .isGooglePlayServicesAvailable(this.context) == ConnectionResult.SUCCESS
        } catch (error: Throwable) {
            Log.w(TAG, "Play services availability check failed", error)
            playServices = false
        }
        this.available = playServices
        if (!available) {
            Log.i(TAG, "Google Play services unavailable; watch integration disabled")
        }
    }

    /** Whether the Wearable Data Layer can be used on this phone at all. */
    fun isAvailable(): Boolean {
        return available
    }

    /**
     * Register the JS listener. Must be called from the thread whose isolate
     * owns it; that thread's Looper is captured for dispatch. Replays any
     * recently queued watch messages and refreshes the reachable-watch set.
     */
    fun setListener(newListener: FaceclawWearListener?) {
        val looper = Looper.myLooper()
        if (looper == null) {
            Log.w(TAG, "wear listener registered from a Looper-less thread; it will never be notified")
        }
        val replay: List<PendingMessage>
        synchronized(lock) {
            listener = newListener
            listenerHandler = if (looper != null) Handler(looper) else null
            replay = ArrayList(pending)
            pending.clear()
        }
        val now = System.currentTimeMillis()
        for (message in replay) {
            if (now - message.receivedAt <= PENDING_MAX_AGE_MS) {
                dispatchMessage(message.path, message.json, message.nodeId)
            }
        }
        refreshWatchNodes()
    }

    fun clearListener() {
        synchronized(lock) {
            listener = null
            listenerHandler = null
        }
    }

    fun isWatchReachable(): Boolean {
        synchronized(lock) {
            return !watchNodes.isEmpty()
        }
    }

    /** Display name of a reachable watch ("" if none). */
    fun getWatchName(): String {
        synchronized(lock) {
            return if (watchNodes.isEmpty()) "" else watchNodes[0].displayName
        }
    }

    /** Re-query which watches advertise the Faceclaw watch-app capability. */
    fun refreshWatchNodes() {
        if (!available) return
        try {
            Wearable.getCapabilityClient(context)
                .getCapability(CAPABILITY_WATCH, CapabilityClient.FILTER_REACHABLE)
                .addOnSuccessListener { info -> updateWatchNodes(info) }
                .addOnFailureListener { error -> Log.w(TAG, "capability query failed", error) }
        } catch (error: Throwable) {
            Log.w(TAG, "capability query failed", error)
        }
    }

    /**
     * Mirror the dashboard state to the watch. Identical consecutive states
     * are not re-sent (the Data Layer would drop them anyway).
     */
    fun publishState(json: String?) {
        publishState(json, false)
    }

    /** As [publishState]; `force` re-sends an unchanged state. */
    fun publishState(json: String?, force: Boolean) {
        if (!available || json == null) return
        synchronized(lock) {
            if (!force && json == lastPublishedState) return
            lastPublishedState = json
        }
        try {
            val request = PutDataMapRequest.create(PATH_STATE)
            val map: DataMap = request.dataMap
            map.putString(STATE_KEY_JSON, json)
            map.putLong(STATE_KEY_UPDATED_AT, System.currentTimeMillis())
            val put: PutDataRequest = request.asPutDataRequest().setUrgent()
            Wearable.getDataClient(context)
                .putDataItem(put)
                .addOnFailureListener { error -> Log.w(TAG, "state publish failed", error) }
        } catch (error: Throwable) {
            Log.w(TAG, "state publish failed", error)
        }
    }

    /** Send a message to every reachable watch running the Faceclaw watch app. */
    fun sendToWatch(path: String, json: String?) {
        if (!available) return
        val targets: List<Node>
        synchronized(lock) {
            targets = ArrayList(watchNodes)
        }
        if (targets.isEmpty()) {
            // Nothing known yet (first message after boot): look the watch up, then send.
            try {
                Wearable.getCapabilityClient(context)
                    .getCapability(CAPABILITY_WATCH, CapabilityClient.FILTER_REACHABLE)
                    .addOnSuccessListener { info ->
                        updateWatchNodes(info)
                        for (node in info.nodes) {
                            sendToNode(node.id, path, json)
                        }
                    }
                    .addOnFailureListener { error -> Log.w(TAG, "capability query failed", error) }
            } catch (error: Throwable) {
                Log.w(TAG, "capability query failed", error)
            }
            return
        }
        for (node in targets) {
            sendToNode(node.id, path, json)
        }
    }

    /** Send a message to one specific node (e.g. an ack back to the sender). */
    fun sendToNode(nodeId: String?, path: String, json: String?) {
        if (!available || nodeId == null || nodeId.isEmpty()) return
        try {
            val payload = (json ?: "{}").toByteArray(StandardCharsets.UTF_8)
            Wearable.getMessageClient(context)
                .sendMessage(nodeId, path, payload)
                .addOnFailureListener { error -> Log.w(TAG, "send $path to $nodeId failed", error) }
        } catch (error: Throwable) {
            Log.w(TAG, "send $path failed", error)
        }
    }

    /** Reply to a watch message; `seq` echoes the watch's sequence number. */
    fun sendAck(nodeId: String?, seq: Long, ok: Boolean, jsReady: Boolean, message: String?) {
        val ack = JSONObject()
        try {
            ack.put("seq", seq)
            ack.put("ok", ok)
            ack.put("jsReady", jsReady)
            ack.put("message", message ?: "")
        } catch (ignored: JSONException) {
            // The keys are constants; this cannot happen.
        }
        sendToNode(nodeId, PATH_ACK, ack.toString())
    }

    /** Entry point for FaceclawWearListenerService; may run on any thread. */
    internal fun handleMessage(event: MessageEvent?) {
        if (event == null) return
        val path: String? = event.path
        if (path == null || !path.startsWith(PATH_PREFIX)) return
        val data: ByteArray? = event.data
        val json = if (data != null && data.size > 0) String(data, StandardCharsets.UTF_8) else "{}"
        val nodeId: String? = event.sourceNodeId
        Log.d(TAG, "recv " + path + " seq=" + readSeq(json))

        val delivered = dispatchMessage(path, json, nodeId)
        if (delivered) return
        // A battery report answers a poll the dashboard sent; with no
        // dashboard to receive it, it is simply dropped (the dashboard polls
        // again when it starts), and the watch does not expect an ack.
        if (PATH_WATCH_BATTERY == path) return

        // No JS listener yet: tell the watch so it can explain why nothing is
        // happening. Only state requests are kept for replay (see class doc);
        // everything else is dropped after the failure ack.
        if (PATH_STATE_REQUEST == path) {
            synchronized(lock) {
                val now = System.currentTimeMillis()
                while (!pending.isEmpty() && now - pending.peekFirst().receivedAt > PENDING_MAX_AGE_MS) {
                    pending.pollFirst()
                }
                if (pending.size >= PENDING_LIMIT) {
                    pending.pollFirst()
                }
                pending.addLast(PendingMessage(path, json, nodeId, now))
            }
        }
        sendAck(nodeId, readSeq(json), false, false, "Faceclaw is not running on the phone. Open it to connect the glasses.")
    }

    /** Entry point for FaceclawWearListenerService's capability callback. */
    internal fun handleCapabilityChanged(info: CapabilityInfo?) {
        if (info == null || CAPABILITY_WATCH != info.name) return
        updateWatchNodes(info)
    }

    private fun updateWatchNodes(info: CapabilityInfo?) {
        val nodes: Set<Node> = if (info != null) info.nodes else Collections.emptySet<Node>()
        // Every reachable watch gets messages; a nearby (Bluetooth-linked)
        // one is listed first so it is the name the phone UI shows.
        val reachable: MutableList<Node> = ArrayList()
        for (node in nodes) {
            if (node.isNearby) reachable.add(0, node) else reachable.add(node)
        }
        val changed: Boolean
        val name: String
        synchronized(lock) {
            changed = !sameNodeIds(watchNodes, reachable)
            watchNodes.clear()
            watchNodes.addAll(reachable)
            name = if (watchNodes.isEmpty()) "" else watchNodes[0].displayName
        }
        if (changed) {
            Log.i(TAG, if (reachable.isEmpty()) "no Faceclaw watch reachable" else "watch reachable: $name")
            val reachableNow = !reachable.isEmpty()
            val target: FaceclawWearListener?
            val handler: Handler?
            synchronized(lock) {
                target = listener
                handler = listenerHandler
            }
            if (target != null && handler != null) {
                handler.post {
                    try {
                        target.onWatchConnection(reachableNow, name)
                    } catch (error: Exception) {
                        Log.w(TAG, "watch connection listener failed", error)
                    }
                }
            }
        }
    }

    /** Post to the JS listener; false when there is none to post to. */
    private fun dispatchMessage(path: String, json: String, nodeId: String?): Boolean {
        val target: FaceclawWearListener?
        val handler: Handler?
        synchronized(lock) {
            target = listener
            handler = listenerHandler
        }
        if (target == null || handler == null) return false
        handler.post {
            try {
                target.onMessage(path, json, nodeId)
            } catch (error: Exception) {
                Log.w(TAG, "wear message listener failed for $path", error)
            }
        }
        return true
    }
}
