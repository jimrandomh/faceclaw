package com.faceclaw.app

import android.app.Activity
import android.app.AlertDialog
import android.app.Dialog
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.view.Window
import android.widget.Button
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView

/** Read-only guide to the gestures mapped by Faceclaw's Neural Band connection. */
internal class NeuralBandTutorial private constructor(private val activity: Activity) {
    private data class Step(
        val title: Int,
        val how: Int,
        val result: Int,
        val panelImage: Int,
        val chapter: Int = R.string.neural_tutorial_navigation,
        val shortcuts: List<GestureShortcut> = emptyList(),
    )

    private val steps = listOf(
        Step(R.string.neural_tutorial_scroll, R.string.neural_tutorial_scroll_how,
            R.string.neural_tutorial_scroll_result, R.drawable.neural_tutorial_panel_launcher,
            shortcuts = listOf(GestureShortcut.SWIPE_UP, GestureShortcut.SWIPE_DOWN)),
        Step(R.string.neural_tutorial_select, R.string.neural_tutorial_select_how,
            R.string.neural_tutorial_select_result, R.drawable.neural_tutorial_panel_launcher, shortcuts = listOf(GestureShortcut.INDEX_SINGLE)),
        Step(R.string.neural_tutorial_back, R.string.neural_tutorial_back_how,
            R.string.neural_tutorial_back_result, R.drawable.neural_tutorial_panel_chat, shortcuts = listOf(GestureShortcut.MIDDLE_SINGLE)),
        Step(R.string.neural_tutorial_across, R.string.neural_tutorial_across_how,
            R.string.neural_tutorial_across_result, R.drawable.neural_tutorial_panel_launcher,
            shortcuts = listOf(GestureShortcut.SWIPE_LEFT, GestureShortcut.SWIPE_RIGHT)),
        Step(R.string.neural_tutorial_sidebar, R.string.neural_tutorial_sidebar_how,
            R.string.neural_tutorial_sidebar_result, R.drawable.neural_tutorial_panel_launcher, R.string.neural_tutorial_shortcuts,
            listOf(GestureShortcut.MIDDLE_DOUBLE)),
        Step(R.string.neural_tutorial_launcher, R.string.neural_tutorial_launcher_how,
            R.string.neural_tutorial_launcher_result, R.drawable.neural_tutorial_panel_launcher, R.string.neural_tutorial_shortcuts,
            listOf(GestureShortcut.MIDDLE_TRIPLE)),
        Step(R.string.neural_tutorial_menu, R.string.neural_tutorial_menu_how,
            R.string.neural_tutorial_menu_result, R.drawable.neural_tutorial_panel_menu, R.string.neural_tutorial_shortcuts,
            listOf(GestureShortcut.MIDDLE_HOLD)),
        Step(R.string.neural_tutorial_dictate, R.string.neural_tutorial_dictate_how,
            R.string.neural_tutorial_dictate_result, R.drawable.neural_tutorial_panel_chat, R.string.neural_tutorial_shortcuts,
            listOf(GestureShortcut.INDEX_HOLD)),
        Step(R.string.neural_tutorial_pointer, R.string.neural_tutorial_pointer_how,
            R.string.neural_tutorial_pointer_result, R.drawable.neural_tutorial_panel_pointer, R.string.neural_tutorial_extra_controls,
            listOf(GestureShortcut.INDEX_TRIPLE)),
        Step(R.string.neural_tutorial_double_tap, R.string.neural_tutorial_double_tap_how,
            R.string.neural_tutorial_double_tap_result, R.drawable.neural_tutorial_panel_launcher, R.string.neural_tutorial_extra_controls,
            listOf(GestureShortcut.INDEX_DOUBLE)),
        Step(R.string.neural_tutorial_dial, R.string.neural_tutorial_dial_how,
            R.string.neural_tutorial_dial_result, R.drawable.neural_tutorial_panel_chat, R.string.neural_tutorial_extra_controls,
            listOf(GestureShortcut.DIAL_UP, GestureShortcut.DIAL_DOWN)),
    )
    private val ui = NeuralBandSetupUi(activity)
    private val dialog = Dialog(activity, android.R.style.Theme_Material_Light_NoActionBar)
    private val counter = label(13f, MUTED_INK)
    private val progress = ProgressBar(activity, null, android.R.attr.progressBarStyleHorizontal)
    private val content = column()
    private val scroll = ScrollView(activity)
    private val previous = button(R.string.neural_tutorial_previous) { moveTo(index - 1) }
    private val next = button(R.string.neural_tutorial_next) {
        if (index == steps.lastIndex) dialog.dismiss() else moveTo(index + 1)
    }
    private var index = 0
    private var wrist: FaceclawNeuralBand.Wrist? = null
    private var usingBandWrist = false
    private var presentedWrist = false
    private val observeWrist: () -> Unit = {
        val selected = FaceclawNeuralBand.wrist(activity)
        val automatic = selected == FaceclawNeuralBand.Wrist.AUTO
        val hand = if (automatic) FaceclawNeuralBand.reportedWrist() else selected
        if (!presentedWrist || hand != wrist || automatic != usingBandWrist) {
            presentedWrist = true
            wrist = hand
            usingBandWrist = automatic
            render()
        }
    }

    private fun show() {
        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE)
        val header = LinearLayout(activity).apply {
            gravity = Gravity.CENTER_VERTICAL
            addView(ImageButton(activity).apply {
                setImageResource(R.drawable.faceclaw_neural_band_arrow_left)
                setBackgroundResource(android.R.drawable.btn_default_small)
                setPadding(dp(10), dp(10), dp(10), dp(10))
                scaleType = ImageView.ScaleType.FIT_CENTER
                contentDescription = activity.getText(R.string.neural_tutorial_close)
                setOnClickListener { dialog.dismiss() }
            }, LinearLayout.LayoutParams(dp(44), dp(44)))
            addView(label(22f, strong = true).apply { setText(R.string.neural_tutorial_title) },
                LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f).apply { marginStart = dp(10) })
            addView(button(R.string.neural_tutorial_all, ::showAllGestures),
                LinearLayout.LayoutParams(WRAP_CONTENT, dp(48)))
        }
        scroll.isFillViewport = false
        scroll.addView(content, FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
        val controls = LinearLayout(activity).apply {
            addView(previous, LinearLayout.LayoutParams(0, dp(50), 1f).apply { marginEnd = dp(6) })
            addView(next, LinearLayout.LayoutParams(0, dp(50), 1f).apply { marginStart = dp(6) })
        }
        dialog.setContentView(column().apply {
            setBackgroundColor(PAGE)
            setPadding(dp(16), dp(12), dp(16), dp(12))
            addView(header, rowParams(0))
            addView(counter, rowParams(4))
            addView(progress.apply {
                max = steps.size
                importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
            }, LinearLayout.LayoutParams(MATCH_PARENT, dp(8)).apply { topMargin = dp(5) })
            addView(scroll, LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f).apply { topMargin = dp(12) })
            addView(controls, rowParams(8))
        })
        dialog.setOnDismissListener { FaceclawNeuralBand.unobserve(observeWrist) }
        dialog.show()
        dialog.window?.setLayout(MATCH_PARENT, MATCH_PARENT)
        FaceclawNeuralBand.observe(observeWrist)
    }

    private fun moveTo(page: Int) {
        index = page.coerceIn(0, steps.lastIndex)
        render()
        scroll.scrollTo(0, 0)
    }

    private fun render() {
        val step = steps[index]
        val actions = FaceclawNeuralBand.shortcutActions(activity)
        val customized = step.shortcuts.any { actions[it] != it.defaultAction }
        val title = if (customized) step.shortcuts.joinToString(" / ") { activity.getString(it.labelRes) }
            else activity.getString(step.title)
        counter.text = activity.getString(R.string.neural_tutorial_progress, activity.getString(step.chapter), index + 1, steps.size)
        progress.progress = index + 1
        previous.isEnabled = index > 0
        next.setText(if (index == steps.lastIndex) R.string.neural_tutorial_done else R.string.neural_tutorial_next)

        content.removeAllViews()
        val instruction = ui.card().apply {
            addView(label(21f, strong = true).apply { text = title })
            addView(label(13f, MUTED_INK).apply { setText(wristLabel()) })
            addView(label(16f).apply { setText(step.how) })
            addView(label(15f, strong = true).apply {
                text = if (customized) gestureAssignments(step.shortcuts, actions) else activity.getString(step.result)
            })
        }
        content.addView(instruction, rowParams(0))
        val panel = ui.card()
        panel.addView(label(15f, strong = true).apply { setText(R.string.neural_tutorial_example) })
        val example = if (customized) when (actions[step.shortcuts.singleOrNull()]) {
            ShortcutAction.POINTER -> R.drawable.neural_tutorial_panel_pointer
            ShortcutAction.DICTATION, ShortcutAction.WRITING -> R.drawable.neural_tutorial_panel_chat
            ShortcutAction.SYSTEM_MENU, ShortcutAction.CONTEXT_MENU -> R.drawable.neural_tutorial_panel_menu
            ShortcutAction.SWITCHER, ShortcutAction.LAUNCHER -> R.drawable.neural_tutorial_panel_launcher
            else -> null
        } else step.panelImage
        if (example != null) {
            addImage(panel, example, R.string.neural_tutorial_example, 170)
            content.addView(panel, rowParams(12))
        }
        content.setPadding(0, 0, 0, dp(8))
    }

    private fun wristLabel(): Int = when (wrist) {
        FaceclawNeuralBand.Wrist.LEFT -> if (usingBandWrist) R.string.neural_tutorial_auto_left else R.string.neural_tutorial_left
        FaceclawNeuralBand.Wrist.RIGHT -> if (usingBandWrist) R.string.neural_tutorial_auto_right else R.string.neural_tutorial_right
        else -> R.string.neural_tutorial_auto_unknown
    }

    private fun addImage(parent: LinearLayout, resource: Int, description: Int, height: Int) {
        parent.addView(ImageView(activity).apply {
            setImageResource(resource)
            adjustViewBounds = true
            maxHeight = dp(height)
            scaleType = ImageView.ScaleType.FIT_CENTER
            contentDescription = activity.getText(description)
            background = GradientDrawable().apply {
                cornerRadius = dp(10).toFloat()
                setColor(IMAGE_BACKGROUND)
            }
            clipToOutline = true
        }, rowParams(0))
    }

    private fun showAllGestures() {
        val assignments = gestureAssignments(GestureShortcut.entries, FaceclawNeuralBand.shortcutActions(activity))
        AlertDialog.Builder(activity)
            .setTitle(R.string.neural_tutorial_all)
            .setMessage(assignments)
            .setPositiveButton(android.R.string.ok, null)
            .show()
    }

    private fun gestureAssignments(shortcuts: List<GestureShortcut>, actions: Map<GestureShortcut, ShortcutAction>) =
        shortcuts.joinToString("\n\n") { shortcut ->
            val action = actions[shortcut] ?: shortcut.defaultAction
            activity.getString(R.string.neural_tutorial_assignment, activity.getString(shortcut.labelRes),
                activity.getString(action.labelRes))
        }

    private fun column() = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }

    private fun label(size: Float, color: Int = INK, strong: Boolean = false) = TextView(activity).apply {
        textSize = size
        setTextColor(color)
        typeface = if (strong) Typeface.create("sans-serif-medium", Typeface.NORMAL) else Typeface.DEFAULT
        setLineSpacing(0f, 1.12f)
    }

    private fun button(label: Int, action: () -> Unit) = Button(activity).apply {
        setText(label)
        isAllCaps = false
        minWidth = 0
        setOnClickListener { action() }
    }

    private fun rowParams(marginDp: Int) = LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply {
        topMargin = dp(marginDp)
    }

    private fun dp(value: Int) = (value * activity.resources.displayMetrics.density).toInt()

    companion object {
        private const val PAGE = 0xFFF1F1F3.toInt()
        private const val INK = 0xFF111214.toInt()
        private const val MUTED_INK = 0xFF5C5E63.toInt()
        private const val IMAGE_BACKGROUND = 0xFFE8E8EB.toInt()

        fun show(activity: Activity) {
            NeuralBandTutorial(activity).show()
        }
    }
}
