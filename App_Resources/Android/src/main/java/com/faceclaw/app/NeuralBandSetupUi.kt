/*
 * Adapted from Air Gestures Android v0.9.31 (Ui.kt, Neu.kt, SetupActivity.kt).
 * Copyright (c) 2026 896kb. MIT license, see native/neural-band/LICENSE-air-gestures.
 */
package com.faceclaw.app

import android.app.Activity
import android.app.Dialog
import android.content.res.ColorStateList
import android.graphics.BlurMaskFilter
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ColorFilter
import android.graphics.Paint
import android.graphics.PixelFormat
import android.graphics.RectF
import android.graphics.Typeface
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.os.Build
import android.text.TextUtils
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.Window
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.widget.Button
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

private const val PAGE = 0xFFF1F1F3.toInt()
private const val INK = 0xFF111214.toInt()
private const val MUTED_INK = 0xFF5C5E63.toInt()
private const val HAIRLINE = 0x21111214
private const val CONTROL_DURATION_MS = 140L

/** Native Air Gestures setup cards for the Faceclaw Band activity. */
internal class NeuralBandSetupUi(private val activity: Activity) {
    private val regular by lazy { Typeface.create("sans-serif", Typeface.NORMAL) }
    private val medium by lazy { Typeface.create("sans-serif-medium", Typeface.NORMAL) }
    private val semibold by lazy { Typeface.create("sans-serif-medium", Typeface.NORMAL) }
    private val bold by lazy { Typeface.create("sans-serif", Typeface.BOLD) }

    @Suppress("DEPRECATION")
    fun page(title: CharSequence): LinearLayout {
        val content = layout(LinearLayout.VERTICAL, 20f)
        val body = layout(LinearLayout.VERTICAL, 20f).apply {
            setPadding(dp(20f), dp(16f), dp(20f), dp(24f))
            addView(titleRow(title))
            addView(content)
        }
        val scroll = ScrollView(activity).apply {
            setBackgroundColor(PAGE)
            isFillViewport = true
            addView(body)
        }
        val window = activity.window
        window.decorView.setBackgroundColor(PAGE)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.setDecorFitsSystemWindows(false)
            window.statusBarColor = Color.TRANSPARENT
            window.navigationBarColor = Color.TRANSPARENT
            val lightBars = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or
                WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
            window.insetsController?.setSystemBarsAppearance(lightBars, lightBars)
            scroll.setOnApplyWindowInsetsListener { _, insets ->
                val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
                scroll.setPadding(bars.left, bars.top, bars.right, bars.bottom)
                insets
            }
        }
        activity.setContentView(scroll)
        scroll.requestApplyInsets()
        return content
    }

    fun card(): LinearLayout = layout(LinearLayout.VERTICAL, 14f).apply {
        background = GradientDrawable().apply {
            cornerRadius = dp(14f).toFloat()
            setStroke(maxOf(1, dp(.75f)), HAIRLINE)
            setColor(Color.TRANSPARENT)
        }
        setPadding(dp(16f), dp(14f), dp(16f), dp(16f))
    }

    fun step(
        card: LinearLayout,
        title: CharSequence,
        detail: CharSequence,
        done: Boolean,
        action: CharSequence? = null,
        enabled: Boolean = true,
        onAction: (() -> Unit)? = null,
    ) {
        card.addView(layout(LinearLayout.HORIZONTAL, 12f).apply {
            val glyph = if (done) R.drawable.faceclaw_neural_band_shield_check else R.drawable.faceclaw_neural_band_circle_alert
            addView(ImageView(activity).apply {
                setImageResource(glyph)
                imageTintList = ColorStateList.valueOf(if (done) INK else MUTED_INK)
                importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
            }, LinearLayout.LayoutParams(dp(16f), dp(16f)))
            addView(layout(LinearLayout.VERTICAL, 3f).apply {
                addView(label(title, 14f, medium, INK))
                if (detail.isNotEmpty()) addView(label(detail, 12f, regular, MUTED_INK))
            }, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
            if (action != null) addView(pill(action, enabled, onAction))
        })
    }

    fun confirm(
        title: CharSequence,
        detail: CharSequence,
        action: CharSequence,
        cancel: CharSequence,
        onConfirm: () -> Unit,
    ) {
        val dialog = Dialog(activity)
        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE)
        dialog.setTitle(title)
        val windowWidth = activity.window.decorView.width.takeIf { it > 0 } ?: activity.resources.displayMetrics.widthPixels
        val sheetWidth = minOf(windowWidth - dp(32f), dp(520f))
        val maxButtonWidth = (sheetWidth - dp(56f)) / 2
        val sheet = layout(LinearLayout.VERTICAL, 14f).apply {
            setPadding(dp(22f), dp(20f), dp(22f), dp(18f))
            addView(label(title, 22f, semibold, INK).apply {
                letterSpacing = -.02f
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) isAccessibilityHeading = true
            })
            addView(label(detail, 14f, regular, MUTED_INK).apply { setLineSpacing(0f, 1.3f) })
            addView(layout(LinearLayout.HORIZONTAL, 12f).apply {
                gravity = Gravity.END or Gravity.CENTER_VERTICAL
                addView(pill(cancel, true, dialog::dismiss).apply { maxWidth = minOf(maxWidth, maxButtonWidth) })
                addView(pill(action, true) {
                    dialog.dismiss()
                    onConfirm()
                }.apply { maxWidth = minOf(maxWidth, maxButtonWidth) })
            })
        }
        dialog.setContentView(ScrollView(activity).apply { addView(sheet) })
        dialog.setCanceledOnTouchOutside(true)
        dialog.show()
        dialog.window?.apply {
            setBackgroundDrawable(GradientDrawable().apply {
                cornerRadius = dp(20f).toFloat()
                setColor(PAGE)
            })
            setDimAmount(.55f)
            setLayout(sheetWidth, LinearLayout.LayoutParams.WRAP_CONTENT)
        }
    }

    private fun titleRow(title: CharSequence): LinearLayout = layout(LinearLayout.HORIZONTAL, 8f).apply {
        addView(ImageButton(activity, null, 0).apply {
            setImageResource(R.drawable.faceclaw_neural_band_arrow_left)
            imageTintList = ColorStateList.valueOf(INK)
            scaleType = ImageView.ScaleType.FIT_CENTER
            contentDescription = activity.getString(R.string.neural_band_back)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) tooltipText = contentDescription
            background = RippleDrawable(ColorStateList.valueOf(0x14111214), null, GradientDrawable().apply {
                cornerRadius = dp(24f).toFloat()
                setColor(Color.WHITE)
            })
            setPadding(dp(14f), dp(14f), dp(14f), dp(14f))
            setOnClickListener { activity.finish() }
        }, LinearLayout.LayoutParams(dp(48f), dp(48f)))
        addView(label(title, 24f, bold, INK).apply {
            letterSpacing = -.03f
            maxLines = 2
            ellipsize = TextUtils.TruncateAt.END
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) isAccessibilityHeading = true
        }, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
    }

    @android.annotation.SuppressLint("ClickableViewAccessibility")
    private fun pill(label: CharSequence, enabled: Boolean, onAction: (() -> Unit)?): Button {
        val density = activity.resources.displayMetrics.density
        val shape = SetupPillDrawable(density)
        return Button(activity, null, 0).apply {
            text = label
            textSize = 14f
            typeface = medium
            letterSpacing = -.005f
            isAllCaps = false
            includeFontPadding = false
            setTextColor(INK)
            gravity = Gravity.CENTER
            backgroundTintList = null
            background = shape
            setLayerType(View.LAYER_TYPE_SOFTWARE, null)
            minWidth = 0
            minHeight = dp(48f)
            maxWidth = minOf(dp(152f), resources.displayMetrics.widthPixels * 2 / 5)
            val horizontal = shape.margin + dp(16f)
            val vertical = shape.margin + dp(9f)
            setPadding(horizontal, vertical, horizontal, vertical)
            setOnClickListener { onAction?.invoke() }
            isEnabled = enabled && onAction != null
            alpha = if (isEnabled) 1f else .45f
            setOnTouchListener { view, event ->
                when (event.actionMasked) {
                    MotionEvent.ACTION_DOWN -> view.animate().scaleX(.985f).scaleY(.985f).setDuration(CONTROL_DURATION_MS).start()
                    MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL ->
                        view.animate().scaleX(1f).scaleY(1f).setDuration(CONTROL_DURATION_MS).start()
                }
                false
            }
        }
    }

    private fun layout(direction: Int, gap: Float): LinearLayout = LinearLayout(activity).apply {
        orientation = direction
        if (direction == LinearLayout.HORIZONTAL) gravity = Gravity.CENTER_VERTICAL
        showDividers = LinearLayout.SHOW_DIVIDER_MIDDLE
        dividerDrawable = GradientDrawable().apply { setSize(dp(gap), dp(gap)) }
    }

    private fun label(value: CharSequence, size: Float, font: Typeface, ink: Int): TextView = TextView(activity).apply {
        text = value
        textSize = size
        typeface = font
        setTextColor(ink)
        includeFontPadding = false
    }

    private fun dp(value: Float): Int = (value * activity.resources.displayMetrics.density).toInt()
}

/** Raised pill from Air Gestures, using its compact shadow and highlight. */
private class SetupPillDrawable(private val density: Float) : Drawable() {
    val margin = (8 * density).toInt()
    private val shape = RectF()
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = PAGE }
    private val highlight = shadow(0xC7FFFFFF.toInt(), 2f)
    private val drop = shadow(0x33111214, 3f)

    override fun draw(canvas: Canvas) {
        shape.set(bounds)
        shape.inset(margin.toFloat(), margin.toFloat())
        val radius = shape.height() / 2
        drawOffset(canvas, radius, -density, -density, highlight)
        drawOffset(canvas, radius, 1.5f * density, 2f * density, drop)
        canvas.drawRoundRect(shape, radius, radius, fill)
    }

    private fun shadow(shade: Int, blurDp: Float) = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = shade
        maskFilter = BlurMaskFilter(maxOf(.5f, blurDp * density * .85f), BlurMaskFilter.Blur.NORMAL)
    }

    private fun drawOffset(canvas: Canvas, radius: Float, dx: Float, dy: Float, paint: Paint) {
        canvas.save()
        canvas.translate(dx, dy)
        canvas.drawRoundRect(shape, radius, radius, paint)
        canvas.restore()
    }

    override fun setAlpha(alpha: Int) = Unit
    override fun setColorFilter(colorFilter: ColorFilter?) = Unit
    @Deprecated("Deprecated in Java")
    override fun getOpacity(): Int = PixelFormat.TRANSLUCENT
}
