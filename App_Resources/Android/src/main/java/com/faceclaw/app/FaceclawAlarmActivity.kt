package com.faceclaw.app

import android.app.Activity
import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView

import java.text.DateFormat
import java.util.Date

/**
 * The phone's ringing screen: shown over the lock screen by the alarm
 * notification's full-screen intent (or by tapping the notification). Pure
 * Java, so it works with the JavaScript side asleep or gone. Snooze and
 * Dismiss go to the service, which journals them for the engine.
 */
class FaceclawAlarmActivity : Activity() {
    private val handler = Handler(Looper.getMainLooper())
    private var titleView: TextView? = null
    private var textView: TextView? = null
    private var timeView: TextView? = null
    private var snoozeButton: Button? = null
    private var itemId: Long = 0

    private val poll: Runnable = object : Runnable {
        override fun run() {
            val items = FaceclawAlarmService.snapshot()
            if (items.isEmpty()) {
                finish()
                return
            }
            var shown: FaceclawAlarmService.Ringing? = null
            for (item in items) {
                if (item.id == itemId) {
                    shown = item
                }
            }
            if (shown == null) {
                shown = items[0]
                itemId = shown.id
            }
            render(shown, items.size)
            handler.postDelayed(this, 1000)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        showOverLockScreen()
        itemId = if (intent == null) 0 else intent.getLongExtra(FaceclawAlarms.EXTRA_ID, 0)
        setContentView(buildLayout())
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        setIntent(intent)
        itemId = if (intent == null) 0 else intent.getLongExtra(FaceclawAlarms.EXTRA_ID, 0)
    }

    override fun onResume() {
        super.onResume()
        handler.post(poll)
    }

    override fun onPause() {
        handler.removeCallbacks(poll)
        super.onPause()
    }

    private fun showOverLockScreen() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
            val keyguard = getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager?
            keyguard?.requestDismissKeyguard(this, null)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
                or WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD)
        }
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }

    private fun buildLayout(): View {
        val root = LinearLayout(this)
        root.orientation = LinearLayout.VERTICAL
        root.gravity = Gravity.CENTER
        root.setBackgroundColor(Color.BLACK)
        val pad = dp(32)
        root.setPadding(pad, pad, pad, pad)

        val time = TextView(this)
        time.setTextColor(Color.WHITE)
        time.setTextSize(TypedValue.COMPLEX_UNIT_SP, 64f)
        time.typeface = Typeface.DEFAULT_BOLD
        time.gravity = Gravity.CENTER
        root.addView(time, wrap())
        timeView = time

        val title = TextView(this)
        title.setTextColor(Color.WHITE)
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 28f)
        title.gravity = Gravity.CENTER
        title.setPadding(0, dp(16), 0, 0)
        root.addView(title, wrap())
        titleView = title

        val text = TextView(this)
        text.setTextColor(Color.LTGRAY)
        text.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18f)
        text.gravity = Gravity.CENTER
        text.setPadding(0, dp(8), 0, dp(40))
        root.addView(text, wrap())
        textView = text

        val snooze = Button(this)
        snooze.setTextSize(TypedValue.COMPLEX_UNIT_SP, 20f)
        snooze.setOnClickListener { act(FaceclawAlarmService.ACTION_SNOOZE) }
        root.addView(snooze, button())
        snoozeButton = snooze

        val dismissButton = Button(this)
        dismissButton.text = "Dismiss"
        dismissButton.setTextSize(TypedValue.COMPLEX_UNIT_SP, 20f)
        dismissButton.setOnClickListener { act(FaceclawAlarmService.ACTION_DISMISS) }
        root.addView(dismissButton, button())
        return root
    }

    private fun render(item: FaceclawAlarmService.Ringing, count: Int) {
        timeView!!.text = DateFormat.getTimeInstance(DateFormat.SHORT).format(Date())
        titleView!!.text = if (count > 1) item.title + " (+" + (count - 1) + " more)" else item.title
        val status = if (item.silenced) "Not answered" else if (item.escalated) "" else "Ringing on the glasses"
        textView!!.text = if (item.text.isEmpty()) status else if (status.isEmpty()) item.text else item.text + "\n" + status
        snoozeButton!!.text = if (FaceclawAlarms.KIND_TIMER == item.kind)
            "+" + item.snoozeMinutes + " min"
        else
            "Snooze " + item.snoozeMinutes + " min"
    }

    /** Apply the action to every ringing item (one tap silences the phone). */
    private fun act(action: String) {
        for (item in FaceclawAlarmService.snapshot()) {
            val intent = Intent(this, FaceclawAlarmService::class.java)
                .setAction(action)
                .putExtra(FaceclawAlarms.EXTRA_ID, item.id)
            startService(intent)
        }
        finish()
    }

    private fun wrap(): LinearLayout.LayoutParams {
        return LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
    }

    private fun button(): LinearLayout.LayoutParams {
        val params = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(64))
        params.topMargin = dp(12)
        return params
    }

    private fun dp(value: Int): Int {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value.toFloat(), resources.displayMetrics))
    }
}
