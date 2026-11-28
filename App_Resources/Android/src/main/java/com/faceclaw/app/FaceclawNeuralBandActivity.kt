package com.faceclaw.app

import android.app.Activity
import android.app.AlertDialog
import android.bluetooth.BluetoothManager
import android.content.Intent
import android.os.Bundle
import android.widget.LinearLayout
import com.faceclaw.app.FaceclawNeuralBand.DialSensitivity
import com.faceclaw.app.FaceclawNeuralBand.Wrist

@Suppress("DEPRECATION")
class FaceclawNeuralBandActivity : Activity() {
    private lateinit var ui: NeuralBandSetupUi
    private lateinit var setup: LinearLayout
    private lateinit var controls: LinearLayout
    private val observer: () -> Unit = { render() }
    private var lastDisplay: Display? = null

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        ui = NeuralBandSetupUi(this)
        val page = ui.page(getString(R.string.neural_band_title))
        setup = ui.card().also { page.addView(it) }
        controls = ui.card().also { page.addView(it) }
        render()
    }

    override fun onStart() {
        super.onStart()
        FaceclawNeuralBand.observe(observer)
        FaceclawNeuralBand.refresh(this)
    }

    override fun onResume() {
        super.onResume()
        render()
    }

    override fun onStop() {
        FaceclawNeuralBand.unobserve(observer)
        super.onStop()
    }

    private fun importIdentity() {
        val pick = {
            startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT).setType("*/*")
                .addCategory(Intent.CATEGORY_OPENABLE), PICK_BUNDLE)
        }
        if (FaceclawNeuralBand.hasIdentity(this)) {
            ui.confirm(getString(R.string.neural_band_owner_key), getString(R.string.neural_band_import_replace),
                getString(R.string.neural_band_import), getString(android.R.string.cancel), pick)
        } else pick()
    }

    @Deprecated("Platform Activity result for the document picker")
    override fun onActivityResult(request: Int, result: Int, data: Intent?) {
        super.onActivityResult(request, result, data)
        if (request == PICK_BUNDLE && result == RESULT_OK) {
            data?.data?.let { FaceclawNeuralBand.importIdentity(this, it) }
        }
    }

    private fun connect() {
        if (!FaceclawNeuralBand.permitted(this)) {
            requestPermissions(FaceclawNeuralBand.permissions, REQUEST_BLUETOOTH)
        } else FaceclawNeuralBand.setEnabled(this, true)
    }

    override fun onRequestPermissionsResult(request: Int, permissions: Array<out String>, results: IntArray) {
        super.onRequestPermissionsResult(request, permissions, results)
        if (request == REQUEST_BLUETOOTH && FaceclawNeuralBand.permitted(this)) {
            FaceclawNeuralBand.setEnabled(this, true)
        }
        render()
    }

    private fun confirmForget() {
        ui.confirm(getString(R.string.neural_band_forget), getString(R.string.neural_band_forget_message),
            getString(R.string.neural_band_remove), getString(android.R.string.cancel)) {
            FaceclawNeuralBand.forget(this)
        }
    }

    private fun bluetoothOn() = FaceclawNeuralBand.permitted(this) &&
        runCatching { getSystemService(BluetoothManager::class.java)?.adapter?.isEnabled == true }.getOrDefault(false)

    private fun render() {
        val display = Display(
            FaceclawNeuralBand.supported, bluetoothOn(), FaceclawNeuralBand.hasIdentity(this),
            FaceclawNeuralBand.hasActiveLink(), FaceclawNeuralBand.busy(), FaceclawNeuralBand.status(this),
            FaceclawNeuralBand.lastAction(), FaceclawNeuralBand.wrist(this), FaceclawNeuralBand.reportedWrist(),
            FaceclawNeuralBand.dialSensitivity(this),
        )
        if (display == lastDisplay) return
        lastDisplay = display
        setup.removeAllViews()
        controls.removeAllViews()
        renderSetup(display)
        renderControls(display)
    }

    private fun renderSetup(display: Display) {
        ui.step(
            setup, getString(R.string.neural_band_owner_key),
            getString(if (display.present) R.string.neural_band_key_saved else R.string.neural_band_instructions),
            display.present, getString(R.string.neural_band_import), display.supported && !display.busy, ::importIdentity,
        )
        ui.step(
            setup, getString(R.string.neural_band_bluetooth),
            getString(if (display.bluetooth) R.string.neural_band_bluetooth_on else R.string.neural_band_pairing_bluetooth),
            display.bluetooth,
        )
        if (display.present) {
            ui.step(setup, getString(R.string.neural_band_forget), getString(R.string.neural_band_forget_detail),
                true, getString(R.string.neural_band_remove), !display.busy, ::confirmForget)
        }
    }

    private fun renderControls(display: Display) {
        val available = display.supported && !display.busy
        ui.step(controls, getString(R.string.neural_band_connection), getString(display.status),
            display.status == R.string.neural_band_connected,
            getString(if (display.link) R.string.neural_band_disconnect else R.string.neural_band_connect),
            available && display.present) {
            if (FaceclawNeuralBand.hasActiveLink()) FaceclawNeuralBand.setEnabled(this, false) else connect()
        }
        val wrist = wristLabel(display.wrist)
        val reported = display.reportedWrist
        val wristSummary = if (reported == null || reported == display.wrist) wrist
        else getString(R.string.neural_band_wrist_reported, wrist, wristLabel(reported))
        ui.step(controls, getString(R.string.neural_band_wrist), wristSummary, true,
            getString(R.string.neural_band_wrist_change), available, ::openWristSettings)
        ui.step(controls, getString(R.string.neural_band_dial_sensitivity), dialSensitivityLabel(display.dialSensitivity), true,
            getString(R.string.neural_band_dial_change), available, ::openDialSettings)
        ui.step(controls, getString(R.string.neural_band_guide_title), getString(R.string.neural_band_guide_quick),
            true, getString(R.string.neural_band_guide_open)) { NeuralBandTutorial.show(this) }
        ui.step(controls, getString(R.string.neural_band_shortcuts_title), getString(R.string.neural_band_shortcuts_summary),
            true, getString(R.string.neural_band_shortcuts_open), available, ::openShortcutSettings)
        renderLastGesture(display.gesture)
    }

    private fun wristLabel(wrist: Wrist) = getString(when (wrist) {
        Wrist.AUTO -> R.string.neural_band_wrist_auto
        Wrist.LEFT -> R.string.neural_band_wrist_left
        Wrist.RIGHT -> R.string.neural_band_wrist_right
    })

    private fun openWristSettings() {
        val options = Wrist.entries
        AlertDialog.Builder(this)
            .setTitle(R.string.neural_band_wrist)
            .setSingleChoiceItems(options.map(::wristLabel).toTypedArray(), options.indexOf(FaceclawNeuralBand.wrist(this))) { dialog, index ->
                FaceclawNeuralBand.setWrist(this, options[index])
                dialog.dismiss()
                render()
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    private fun dialSensitivityLabel(value: DialSensitivity) = getString(when (value) {
        DialSensitivity.SLOW -> R.string.neural_band_dial_slow
        DialSensitivity.MEDIUM -> R.string.neural_band_dial_medium
        DialSensitivity.FAST -> R.string.neural_band_dial_fast
    })

    private fun openDialSettings() {
        val options = DialSensitivity.entries
        AlertDialog.Builder(this)
            .setTitle(R.string.neural_band_dial_sensitivity)
            .setSingleChoiceItems(
                options.map(::dialSensitivityLabel).toTypedArray(),
                options.indexOf(FaceclawNeuralBand.dialSensitivity(this)),
            ) { dialog, index ->
                FaceclawNeuralBand.setDialSensitivity(this, options[index])
                dialog.dismiss()
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    private fun openShortcutSettings() {
        val slots = GestureShortcut.entries
        val bindings = FaceclawNeuralBand.shortcutActions(this)
        val labels = slots.map { slot ->
            getString(R.string.neural_band_shortcuts_row, getString(slot.labelRes), getString(bindings.getValue(slot).labelRes))
        }
        AlertDialog.Builder(this)
            .setTitle(R.string.neural_band_shortcuts_title)
            .setItems(labels.toTypedArray()) { _, index ->
                val slot = slots[index]
                openShortcutChoice(slot, bindings.getValue(slot))
            }
            .setNeutralButton(R.string.neural_band_shortcuts_reset) { _, _ ->
                if (FaceclawNeuralBand.resetShortcutActions(this)) openShortcutSettings()
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    private fun openShortcutChoice(slot: GestureShortcut, current: ShortcutAction) {
        val choices = slot.choices
        AlertDialog.Builder(this)
            .setTitle(slot.labelRes)
            .setSingleChoiceItems(choices.map { getString(it.labelRes) }.toTypedArray(), choices.indexOf(current)) { dialog, index ->
                val saved = FaceclawNeuralBand.setShortcutAction(this, slot, choices[index])
                dialog.dismiss()
                if (saved) openShortcutSettings()
            }
            .setNegativeButton(android.R.string.cancel) { _, _ -> openShortcutSettings() }
            .show()
    }

    private fun renderLastGesture(gesture: String?) {
        val action = when (gesture) {
            "scroll-up" -> R.string.neural_band_gesture_up
            "scroll-down" -> R.string.neural_band_gesture_down
            "select" -> R.string.neural_band_gesture_select
            "back" -> R.string.neural_band_gesture_back
            "swipe-left" -> R.string.neural_band_gesture_left
            "swipe-right" -> R.string.neural_band_gesture_right
            "index-double" -> ShortcutAction.POINTER.labelRes
            "middle-double" -> ShortcutAction.SWITCHER.labelRes
            "index-triple" -> ShortcutAction.WRITING.labelRes
            "middle-triple" -> ShortcutAction.LAUNCHER.labelRes
            "index-hold-start" -> ShortcutAction.DICTATION.labelRes
            "middle-hold-start" -> ShortcutAction.SYSTEM_MENU.labelRes
            "screen-toggle" -> ShortcutAction.SCREEN_TOGGLE.labelRes
            "double-click" -> ShortcutAction.DOUBLE_TAP.labelRes
            "short-then-long-press" -> ShortcutAction.CONTEXT_MENU.labelRes
            "index-hold-end", "middle-hold-end" -> R.string.neural_band_gesture_release
            "index-hold-cancel", "middle-hold-cancel" -> R.string.neural_band_gesture_cancel
            "dial-up" -> R.string.neural_band_gesture_dial_up
            "dial-down" -> R.string.neural_band_gesture_dial_down
            else -> null
        }
        if (action != null) {
            ui.step(controls, getString(R.string.neural_band_gesture_title), getString(action), true)
        }
    }

    private data class Display(
        val supported: Boolean,
        val bluetooth: Boolean,
        val present: Boolean,
        val link: Boolean,
        val busy: Boolean,
        val status: Int,
        val gesture: String?,
        val wrist: Wrist,
        val reportedWrist: Wrist?,
        val dialSensitivity: DialSensitivity,
    )

    private companion object {
        const val PICK_BUNDLE = 641
        const val REQUEST_BLUETOOTH = 642
    }
}

internal val GestureShortcut.labelRes: Int
    get() = when (this) {
        GestureShortcut.INDEX_SINGLE -> R.string.neural_band_shortcut_index_single
        GestureShortcut.MIDDLE_SINGLE -> R.string.neural_band_shortcut_middle_single
        GestureShortcut.INDEX_DOUBLE -> R.string.neural_band_shortcut_index_double
        GestureShortcut.MIDDLE_DOUBLE -> R.string.neural_band_shortcut_middle_double
        GestureShortcut.INDEX_TRIPLE -> R.string.neural_band_shortcut_index_triple
        GestureShortcut.MIDDLE_TRIPLE -> R.string.neural_band_shortcut_middle_triple
        GestureShortcut.INDEX_HOLD -> R.string.neural_band_shortcut_index_hold
        GestureShortcut.MIDDLE_HOLD -> R.string.neural_band_shortcut_middle_hold
        GestureShortcut.SWIPE_UP -> R.string.neural_band_shortcut_swipe_up
        GestureShortcut.SWIPE_DOWN -> R.string.neural_band_shortcut_swipe_down
        GestureShortcut.SWIPE_LEFT -> R.string.neural_band_shortcut_swipe_left
        GestureShortcut.SWIPE_RIGHT -> R.string.neural_band_shortcut_swipe_right
        GestureShortcut.DIAL_UP -> R.string.neural_band_shortcut_dial_up
        GestureShortcut.DIAL_DOWN -> R.string.neural_band_shortcut_dial_down
    }

internal val ShortcutAction.labelRes: Int
    get() = when (this) {
        ShortcutAction.NONE -> R.string.neural_band_shortcut_action_none
        ShortcutAction.SELECT -> R.string.neural_band_shortcut_action_select
        ShortcutAction.BACK -> R.string.neural_band_shortcut_action_back
        ShortcutAction.DOUBLE_TAP -> R.string.neural_band_shortcut_action_double_tap
        ShortcutAction.SCROLL_UP -> R.string.neural_band_shortcut_action_scroll_up
        ShortcutAction.SCROLL_DOWN -> R.string.neural_band_shortcut_action_scroll_down
        ShortcutAction.POINTER -> R.string.neural_band_shortcut_action_pointer
        ShortcutAction.WRITING -> R.string.neural_band_shortcut_action_writing
        ShortcutAction.SWITCHER -> R.string.neural_band_shortcut_action_switcher
        ShortcutAction.LAUNCHER -> R.string.neural_band_shortcut_action_launcher
        ShortcutAction.SYSTEM_MENU -> R.string.neural_band_shortcut_action_system_menu
        ShortcutAction.CONTEXT_MENU -> R.string.neural_band_shortcut_action_context_menu
        ShortcutAction.DICTATION -> R.string.neural_band_shortcut_action_dictation
        ShortcutAction.SCREEN_TOGGLE -> R.string.neural_band_shortcut_action_screen_toggle
    }
