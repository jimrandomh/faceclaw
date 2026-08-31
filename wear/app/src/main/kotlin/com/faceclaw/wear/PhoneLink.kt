package com.faceclaw.wear

import android.content.Context
import android.net.Uri
import android.util.Log
import com.google.android.gms.common.api.ApiException
import com.google.android.gms.wearable.CapabilityClient
import com.google.android.gms.wearable.CapabilityInfo
import com.google.android.gms.wearable.DataClient
import com.google.android.gms.wearable.DataEvent
import com.google.android.gms.wearable.DataEventBuffer
import com.google.android.gms.wearable.DataItem
import com.google.android.gms.wearable.DataMapItem
import com.google.android.gms.wearable.MessageClient
import com.google.android.gms.wearable.MessageEvent
import com.google.android.gms.wearable.Node
import com.google.android.gms.wearable.Wearable
import com.google.android.gms.wearable.WearableStatusCodes
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

/** What we know about the phone and the Faceclaw app on it. */
data class LinkStatus(
    /** A phone is connected to the watch at all (any node). */
    val phoneReachable: Boolean = false,
    /** That phone has Faceclaw installed (advertises the capability). */
    val phoneAppInstalled: Boolean = false,
    val phoneNodeId: String? = null,
    val phoneName: String = "",
    /**
     * Whether the phone app's dashboard (the JS side) answered our last
     * message; null until we have heard anything. False means Faceclaw is
     * installed but not running, so the user has to open it.
     */
    val appRunning: Boolean? = null,
    val lastError: String? = null,
)

/** The assistant overlay as mirrored from the glasses. */
data class AssistantMirror(
    /** idle | thinking | streaming | done | error */
    val phase: String = "idle",
    val text: String = "",
    val updatedAt: Long = 0,
)

/** A transient message for the UI (ack failures, confirmations). */
data class Notice(val text: String, val isError: Boolean, val id: Long)

/**
 * The watch's end of the Wearable Data Layer conversation with the phone:
 * sends gestures/commands/text as messages, receives acks and events, and
 * mirrors the phone's state item. Lives for the activity's lifetime
 * (start()/stop() from onStart/onStop).
 */
class PhoneLink(context: Context) :
    MessageClient.OnMessageReceivedListener,
    DataClient.OnDataChangedListener,
    CapabilityClient.OnCapabilityChangedListener {

    private val appContext = context.applicationContext
    private val messageClient = Wearable.getMessageClient(appContext)
    private val dataClient = Wearable.getDataClient(appContext)
    private val capabilityClient = Wearable.getCapabilityClient(appContext)
    private val nodeClient = Wearable.getNodeClient(appContext)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val nextSeq = AtomicLong(1)
    private val pendingAcks = ConcurrentHashMap<Long, Job>()
    private var noticeJob: Job? = null
    private var started = false

    private val _state = MutableStateFlow<PhoneState?>(null)
    val state: StateFlow<PhoneState?> = _state.asStateFlow()

    private val _link = MutableStateFlow(LinkStatus())
    val link: StateFlow<LinkStatus> = _link.asStateFlow()

    private val _assistant = MutableStateFlow(AssistantMirror())
    val assistant: StateFlow<AssistantMirror> = _assistant.asStateFlow()

    private val _events = MutableSharedFlow<PhoneEvent>(extraBufferCapacity = 32)
    val events: SharedFlow<PhoneEvent> = _events.asSharedFlow()

    private val _notice = MutableStateFlow<Notice?>(null)
    val notice: StateFlow<Notice?> = _notice.asStateFlow()

    fun start() {
        if (started) return
        started = true
        messageClient.addListener(this)
        dataClient.addListener(this)
        capabilityClient.addListener(this, Protocol.CAPABILITY_PHONE)
        refresh()
    }

    fun stop() {
        if (!started) return
        started = false
        messageClient.removeListener(this)
        dataClient.removeListener(this)
        capabilityClient.removeListener(this, Protocol.CAPABILITY_PHONE)
    }

    /** Re-discover the phone, reload the cached state item, and ask for a fresh one. */
    fun refresh() {
        scope.launch {
            findPhone()
            loadStateItem()
            if (_link.value.phoneAppInstalled) requestState()
        }
    }

    // ---- outbound -----------------------------------------------------

    fun sendGesture(gesture: Gesture, steps: Int = 1) {
        send(Protocol.PATH_INPUT, JSONObject().put("gesture", gesture.wire).put("steps", steps))
    }

    fun sendCommand(command: String, vararg extras: Pair<String, String>) {
        val body = JSONObject().put("command", command)
        for ((key, value) in extras) body.put(key, value)
        send(Protocol.PATH_COMMAND, body)
    }

    fun sendAssistantQuery(text: String) {
        _assistant.value = AssistantMirror(phase = "thinking", text = "", updatedAt = System.currentTimeMillis())
        send(Protocol.PATH_ASSISTANT, JSONObject().put("text", text))
    }

    fun sendText(text: String) {
        send(Protocol.PATH_TEXT, JSONObject().put("text", text))
    }

    fun requestState() {
        send(Protocol.PATH_STATE_REQUEST, JSONObject(), quiet = true)
    }

    fun clearAssistant() {
        _assistant.value = AssistantMirror()
    }

    private fun send(path: String, body: JSONObject, quiet: Boolean = false) {
        val seq = nextSeq.getAndIncrement()
        body.put("seq", seq)
        Log.d(TAG, "send $path $body")
        val payload = body.toString().toByteArray(Charsets.UTF_8)
        scope.launch {
            var nodeId = _link.value.phoneNodeId
            if (nodeId == null) {
                findPhone()
                nodeId = _link.value.phoneNodeId
            }
            if (nodeId == null) {
                if (!quiet) showNotice("No phone connected.", isError = true)
                return@launch
            }
            if (!_link.value.phoneAppInstalled) {
                if (!quiet) showNotice("Faceclaw isn't installed on the phone.", isError = true)
                return@launch
            }
            try {
                val requestId = messageClient.sendMessage(nodeId, path, payload).await()
                Log.d(TAG, "sent seq=$seq requestId=$requestId")
                // The phone acks every message; silence means the app
                // process never received it (or Play services dropped it).
                val timeout = scope.launch {
                    delay(ACK_TIMEOUT_MS)
                    if (pendingAcks.remove(seq) != null) {
                        _link.update { it.copy(appRunning = it.appRunning ?: false) }
                        if (!quiet) showNotice("No reply from the phone.", isError = true)
                    }
                }
                pendingAcks[seq] = timeout
            } catch (error: ApiException) {
                Log.w(TAG, "send $path failed: ${error.statusCode}", error)
                val message = when (error.statusCode) {
                    WearableStatusCodes.TARGET_NODE_NOT_CONNECTED -> "The phone is out of range."
                    else -> "Couldn't reach the phone (${error.statusCode})."
                }
                _link.update { it.copy(lastError = message) }
                if (!quiet) showNotice(message, isError = true)
                scope.launch { findPhone() }
            } catch (error: Exception) {
                Log.w(TAG, "send $path failed", error)
                if (!quiet) showNotice("Couldn't reach the phone.", isError = true)
            }
        }
    }

    // ---- inbound ------------------------------------------------------

    override fun onMessageReceived(event: MessageEvent) {
        val json = String(event.data, Charsets.UTF_8)
        Log.d(TAG, "recv ${event.path} $json")
        when (event.path) {
            Protocol.PATH_ACK -> Ack.parse(json)?.let { handleAck(it) }
            Protocol.PATH_EVENT -> PhoneEvent.parse(json)?.let { handleEvent(it) }
        }
    }

    private fun handleAck(ack: Ack) {
        pendingAcks.remove(ack.seq)?.cancel()
        _link.update { it.copy(appRunning = ack.jsReady, lastError = null) }
        if (!ack.ok) {
            showNotice(ack.message.ifBlank { "The phone refused that." }, isError = true)
        } else if (ack.message.isNotBlank()) {
            showNotice(ack.message, isError = false)
        }
    }

    private fun handleEvent(event: PhoneEvent) {
        when (event) {
            is PhoneEvent.Assistant -> {
                _assistant.update { current ->
                    when (event.phase) {
                        "thinking" -> AssistantMirror("thinking", "", System.currentTimeMillis())
                        "streaming" -> AssistantMirror("streaming", event.text, System.currentTimeMillis())
                        "done" -> AssistantMirror("done", event.text.ifBlank { current.text }, System.currentTimeMillis())
                        "error" -> AssistantMirror("error", event.text, System.currentTimeMillis())
                        "closed" -> AssistantMirror("idle", current.text, System.currentTimeMillis())
                        else -> current
                    }
                }
            }
            is PhoneEvent.Alert -> showNotice(event.text, isError = false)
        }
        _events.tryEmit(event)
    }

    override fun onDataChanged(buffer: DataEventBuffer) {
        for (event in buffer) {
            if (event.type != DataEvent.TYPE_CHANGED) continue
            val item = event.dataItem
            if (item.uri.path == Protocol.PATH_STATE) applyStateItem(item)
        }
    }

    override fun onCapabilityChanged(info: CapabilityInfo) {
        scope.launch { findPhone() }
    }

    private fun applyStateItem(item: DataItem) {
        val map = DataMapItem.fromDataItem(item).dataMap
        val json = map.getString(Protocol.STATE_KEY_JSON) ?: return
        val updatedAt = map.getLong(Protocol.STATE_KEY_UPDATED_AT, 0)
        PhoneState.parse(json, updatedAt)?.let { parsed ->
            _state.value = parsed
            // A state item is only ever written by the running dashboard.
            _link.update { it.copy(appRunning = true) }
        }
    }

    private suspend fun loadStateItem() {
        try {
            // The item lives under the phone node's authority
            // (wear://<nodeId>/faceclaw/state); the "*" host matches any node,
            // where a hostless Uri would match nothing.
            val uri = Uri.parse("wear://*${Protocol.PATH_STATE}")
            val items = dataClient.getDataItems(uri).await()
            try {
                for (item in items) applyStateItem(item)
            } finally {
                items.release()
            }
        } catch (error: Exception) {
            Log.w(TAG, "state item load failed", error)
        }
    }

    private suspend fun findPhone() {
        try {
            val info = capabilityClient
                .getCapability(Protocol.CAPABILITY_PHONE, CapabilityClient.FILTER_REACHABLE)
                .await()
            val phone = pickNode(info.nodes)
            if (phone != null) {
                _link.update {
                    it.copy(
                        phoneReachable = true,
                        phoneAppInstalled = true,
                        phoneNodeId = phone.id,
                        phoneName = phone.displayName,
                        lastError = null,
                    )
                }
                return
            }
            val connected = nodeClient.connectedNodes.await()
            val any = pickNode(connected.toSet())
            _link.update {
                it.copy(
                    phoneReachable = any != null,
                    phoneAppInstalled = false,
                    phoneNodeId = null,
                    phoneName = any?.displayName ?: "",
                    appRunning = null,
                )
            }
        } catch (error: Exception) {
            Log.w(TAG, "phone lookup failed", error)
            _link.update { it.copy(lastError = error.message) }
        }
    }

    private fun pickNode(nodes: Set<Node>): Node? =
        nodes.firstOrNull { it.isNearby } ?: nodes.firstOrNull()

    private fun showNotice(text: String, isError: Boolean) {
        noticeJob?.cancel()
        _notice.value = Notice(text, isError, System.nanoTime())
        noticeJob = scope.launch {
            delay(if (isError) NOTICE_ERROR_MS else NOTICE_INFO_MS)
            _notice.value = null
        }
    }

    companion object {
        private const val TAG = "FaceclawWear"
        private const val ACK_TIMEOUT_MS = 3000L
        private const val NOTICE_INFO_MS = 1800L
        private const val NOTICE_ERROR_MS = 3200L
    }
}
