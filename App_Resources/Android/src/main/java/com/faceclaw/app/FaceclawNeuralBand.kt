package com.faceclaw.app

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import dev.lumen.band.BandLink
import dev.lumen.band.Bridge
import dev.lumen.band.GestureDevice
import dev.lumen.band.Identity
import dev.lumen.band.Phase
import org.json.JSONObject
import kotlin.concurrent.thread

/** Owns a single BandLink in the same Android process as the glasses connection. */
object FaceclawNeuralBand {
    fun interface ActionListener {
        fun onAction(action: String)
    }

    fun interface PointerListener {
        fun onPointer(records: DoubleArray)
    }

    fun interface HandwritingListener {
        fun onHandwriting(json: String)
    }

    internal enum class Wrist(val setting: String) {
        AUTO("band"), LEFT("left"), RIGHT("right"),
    }

    internal enum class DialSensitivity(val multiplier: Double) {
        SLOW(0.5), MEDIUM(0.75), FAST(1.0),
    }

    private const val PREFS = "faceclaw_neural_band"
    private const val ENABLED = "enabled"
    private const val WRIST = "wrist"
    private const val DIAL_SENSITIVITY = "dial_sensitivity"
    private const val SHORTCUT_PREFIX = "shortcut."
    private const val MAX_BUNDLE_BYTES = 16 * 1024
    private val actionNames = NeuralBandShortcuts.nativeActions
    // The app owns hold edges, and writing keeps a dedicated exit
    // independent of the normal middle pinch assignment.
    private const val BASE_GESTURE_MAPPING = "index_hold=;middle_hold=;writing_exit=back"
    private val main = Handler(Looper.getMainLooper())
    private val observers = mutableSetOf<() -> Unit>()
    private var listener: ActionListener? = null
    private var pointerListener: PointerListener? = null
    private var handwritingListener: HandwritingListener? = null
    private var link: BandLink? = null
    private var foreground = false
    private var generation = 0
    private var phase = Phase.STOPPED
    private var failed = false
    private var importing = false
    private var importFailed = false
    private var identityPresent: Boolean? = null
    private var lastAction: String? = null
    private var observedWrist: Wrist? = null

    @JvmStatic
    fun setActionListener(value: ActionListener?) {
        if (Looper.myLooper() == Looper.getMainLooper()) listener = value
        else main.post { listener = value }
    }

    @JvmStatic
    fun setPointerListener(value: PointerListener?) {
        if (Looper.myLooper() == Looper.getMainLooper()) pointerListener = value
        else main.post { pointerListener = value }
    }

    @JvmStatic
    fun setHandwritingListener(value: HandwritingListener?) {
        if (Looper.myLooper() == Looper.getMainLooper()) handwritingListener = value
        else main.post { handwritingListener = value }
    }

    @JvmStatic
    fun setPointerEnabled(enabled: Boolean): Boolean =
        phase == Phase.CONNECTED && link?.setPointer(enabled) == true

    @JvmStatic
    fun setHandwritingEnabled(enabled: Boolean): Boolean =
        phase == Phase.CONNECTED && link?.setHandwriting(enabled) == true

    @JvmStatic
    fun resetHandwritingText(text: String) {
        if (phase == Phase.CONNECTED) link?.resetHandwritingText(text)
    }

    @JvmStatic
    fun openSettings(activity: Activity) {
        if (isAvailable()) activity.startActivity(Intent(activity, FaceclawNeuralBandActivity::class.java))
    }

    @JvmStatic
    fun isAvailable(): Boolean = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && Bridge.available

    internal val supported: Boolean
        get() = isAvailable()

    internal fun permitted(context: Context): Boolean =
        supported && permissions.all {
            context.checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED
        }

    internal val permissions = arrayOf(Manifest.permission.BLUETOOTH_CONNECT)

    internal fun wrist(context: Context): Wrist {
        val saved = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(WRIST, null)
        return Wrist.entries.firstOrNull { it.setting == saved } ?: Wrist.AUTO
    }

    internal fun setWrist(context: Context, value: Wrist) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        prefs.edit().putString(WRIST, value.setting).apply()
        link?.setMapping(gestureMapping(context))
        changed()
    }

    internal fun reportedWrist(): Wrist? = observedWrist

    internal fun dialSensitivity(context: Context): DialSensitivity {
        val saved = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(DIAL_SENSITIVITY, null)
        return DialSensitivity.entries.firstOrNull { it.name == saved } ?: DialSensitivity.MEDIUM
    }

    internal fun setDialSensitivity(context: Context, value: DialSensitivity) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        prefs.edit().putString(DIAL_SENSITIVITY, value.name).apply()
        link?.setMapping(gestureMapping(context))
        changed()
    }

    internal fun shortcutActions(context: Context): Map<GestureShortcut, ShortcutAction> {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        return NeuralBandShortcuts.read { prefs.getString(SHORTCUT_PREFIX + it.nativeSlot, null) }
    }

    internal fun setShortcutAction(context: Context, slot: GestureShortcut, action: ShortcutAction): Boolean {
        val current = shortcutActions(context)
        val next = NeuralBandShortcuts.assign(current, slot, action) ?: return false
        return saveShortcutActions(context, current, next)
    }

    internal fun resetShortcutActions(context: Context): Boolean =
        saveShortcutActions(context, shortcutActions(context), NeuralBandShortcuts.defaults)

    private fun saveShortcutActions(
        context: Context,
        current: Map<GestureShortcut, ShortcutAction>,
        next: Map<GestureShortcut, ShortcutAction>,
    ): Boolean {
        if (busy()) return false
        val editor = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
        for ((slot, action) in next) {
            val key = SHORTCUT_PREFIX + slot.nativeSlot
            if (action == slot.defaultAction) editor.remove(key) else editor.putString(key, action.name)
        }
        editor.apply()
        if (current != next) {
            if (NeuralBandShortcuts.pointerShortcut(current) != NeuralBandShortcuts.pointerShortcut(next)) {
                link?.setPointer(false)
                listener?.onAction("pointer-off")
            }
            // The native mapping change cancels any old hold before using the new edges.
            link?.setMapping(gestureMapping(context))
            changed()
        }
        return true
    }

    private fun gestureMapping(context: Context) =
        "$BASE_GESTURE_MAPPING;${NeuralBandShortcuts.nativeMapping(shortcutActions(context))};" +
            "hand=${wrist(context).setting};dial_sensitivity=${dialSensitivity(context).multiplier}"

    internal fun enabled(context: Context): Boolean =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(ENABLED, false)

    internal fun hasIdentity(context: Context): Boolean =
        identityPresent ?: Identity.present(context).also { identityPresent = it }

    internal fun observe(observer: () -> Unit) {
        observers.add(observer)
        observer()
    }

    internal fun unobserve(observer: () -> Unit) {
        observers.remove(observer)
    }

    internal fun setEnabled(activity: Activity, value: Boolean) {
        if (value && (!permitted(activity) || !hasIdentity(activity))) {
            return
        }
        activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(ENABLED, value).apply()
        failed = false
        if (value && !foreground) {
            val intent = Intent(activity, FaceclawForegroundService::class.java)
                .setAction(FaceclawForegroundService.ACTION_NEURAL_BAND)
            try {
                activity.startForegroundService(intent)
            } catch (_: IllegalStateException) {
                failed = true
            } catch (_: SecurityException) {
                failed = true
            }
        } else {
            refresh(activity)
            if (!value && foreground) {
                activity.startService(Intent(activity, FaceclawForegroundService::class.java)
                    .setAction(FaceclawForegroundService.ACTION_NEURAL_BAND_DISABLED))
            }
        }
        changed()
    }

    internal fun importIdentity(context: Context, uri: Uri) {
        if (!supported || busy() || uri.scheme != "content") return
        val app = context.applicationContext
        importing = true
        importFailed = false
        failed = false
        stopLink()
        changed()

        thread(name = "faceclaw-band-import") {
            val imported = try {
                app.contentResolver.openInputStream(uri)?.use { stream ->
                    val buffer = ByteArray(MAX_BUNDLE_BYTES + 1)
                    try {
                        var size = 0
                        while (size < buffer.size) {
                            val count = stream.read(buffer, size, buffer.size - size)
                            if (count <= 0) break
                            size += count
                        }
                        if (size !in 1..MAX_BUNDLE_BYTES) false
                        else {
                            val bytes = buffer.copyOf(size)
                            try {
                                Identity.importBundle(app, bytes)
                            } finally {
                                bytes.fill(0)
                            }
                        }
                    } finally {
                        buffer.fill(0)
                    }
                } ?: false
            } catch (_: Exception) {
                false
            } catch (_: LinkageError) {
                false
            }
            main.post {
                importing = false
                importFailed = !imported
                if (imported) identityPresent = true
                refresh(app)
            }
        }
    }

    internal fun forget(activity: Activity) {
        if (busy()) return
        setEnabled(activity, false)
        importFailed = !Identity.forgetLocal(activity)
        if (!importFailed) identityPresent = false
        changed()
    }

    internal fun foregroundStarted(context: Context) {
        foreground = true
        refresh(context)
    }

    internal fun foregroundStopped() {
        foreground = false
        stopLink()
        changed()
    }

    internal fun shouldRun(context: Context): Boolean =
        permitted(context) && enabled(context) && hasIdentity(context)

    internal fun refresh(context: Context) {
        if (foreground && !importing && shouldRun(context)) {
            if (link == null && !failed) connect(context.applicationContext)
        } else {
            stopLink()
        }
        changed()
    }

    private fun connect(context: Context) {
        val attempt = ++generation
        val config = object : BandLink.Config {
            override fun paused() = false
            override fun mapping() = gestureMapping(context)
        }
        val callbacks = object : GestureDevice.Listener {
            private var lastReportedWrist: Wrist? = null

            override fun onPhase(phase: Phase, band: String?) {
                if (phase != Phase.CONNECTED) lastReportedWrist = null
                main.post {
                    if (attempt != generation) return@post
                    val ended = this@FaceclawNeuralBand.phase == Phase.CONNECTED && phase != Phase.CONNECTED
                    this@FaceclawNeuralBand.phase = phase
                    if (phase != Phase.CONNECTED) observedWrist = null
                    if (phase == Phase.STOPPED) {
                        link = null
                        generation++
                        failed = true
                    }
                    if (ended) listener?.onAction("session-ended")
                    changed()
                }
            }

            override fun onActions(actions: List<String>) {
                main.post {
                    if (attempt != generation || !foreground || phase != Phase.CONNECTED) return@post
                    for (nativeAction in actions) {
                        if (nativeAction == "pointer.off") {
                            listener?.onAction("pointer-off")
                            continue
                        }
                        if (nativeAction !in actionNames) continue
                        val action = if (nativeAction == "pc.pointer") "index-double" else nativeAction
                        lastAction = action
                        listener?.onAction(action)
                    }
                    changed()
                }
            }

            override fun onStatus(status: JSONObject) {
                val hand = if (status.optBoolean("connected")) status.optString("hand") else ""
                val wrist = when (hand) {
                    Wrist.LEFT.setting -> Wrist.LEFT
                    Wrist.RIGHT.setting -> Wrist.RIGHT
                    else -> null
                }
                if (wrist == lastReportedWrist) return
                lastReportedWrist = wrist
                main.post {
                    if (attempt != generation || phase != Phase.CONNECTED || wrist == observedWrist) return@post
                    observedWrist = wrist
                    changed()
                }
            }
            override fun onLog(line: String) = Unit

            override fun onPointer(records: DoubleArray) {
                if (attempt == generation && foreground && phase == Phase.CONNECTED) {
                    pointerListener?.onPointer(records)
                }
            }

            override fun onHandwriting(event: JSONObject) {
                if (attempt == generation && foreground && phase == Phase.CONNECTED) {
                    handwritingListener?.onHandwriting(event.toString())
                }
            }
        }
        try {
            link = BandLink(context, callbacks, config)
            phase = Phase.SEARCHING
            link?.start()
        } catch (_: Exception) {
            stopLink()
            failed = true
        } catch (_: LinkageError) {
            stopLink()
            failed = true
        }
    }

    private fun stopLink() {
        val previousLink = link ?: return
        val ended = phase == Phase.CONNECTED
        generation++
        link = null
        phase = Phase.STOPPED
        lastAction = null
        observedWrist = null
        runCatching { previousLink.stop() }
        if (ended) listener?.onAction("session-ended")
    }

    internal fun busy() = importing
    internal fun hasActiveLink() = link != null
    internal fun lastAction() = lastAction
    internal fun status(context: Context) = when {
        Build.VERSION.SDK_INT < Build.VERSION_CODES.S -> R.string.neural_band_requires_android_12
        !supported -> R.string.neural_band_native_unavailable
        importing -> R.string.neural_band_importing
        importFailed -> R.string.neural_band_import_failed
        !hasIdentity(context) -> R.string.neural_band_import_required
        !enabled(context) -> R.string.neural_band_disabled
        !permitted(context) -> R.string.neural_band_permission
        failed -> R.string.neural_band_start_failed
        !foreground -> R.string.neural_band_disconnected
        phase == Phase.CONNECTED -> R.string.neural_band_connected
        phase == Phase.CONNECTING -> R.string.neural_band_connecting
        else -> R.string.neural_band_searching
    }

    private fun changed() {
        observers.toList().forEach { it() }
    }
}
