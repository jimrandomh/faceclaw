package com.faceclaw.wear

import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.KeyEvent
import android.view.WindowManager
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import com.faceclaw.wear.ui.FaceclawWearApp

class MainActivity : ComponentActivity() {
    private lateinit var link: PhoneLink
    private lateinit var prefs: WatchPrefs
    private lateinit var haptics: Haptics

    // Side (stem) buttons: button 1 is click / hold, 2 double-click, 3 "Hey Even".
    private val stemHandler = Handler(Looper.getMainLooper())
    private var stemHoldRunnable: Runnable? = null
    private var stemHoldSent = false
    private var stemOneIgnored = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        link = PhoneLink(this)
        prefs = WatchPrefs(this)
        haptics = Haptics(this) { prefs.prefs.value.haptics }
        setContent {
            FaceclawWearApp(link = link, prefsStore = prefs, haptics = haptics)
        }
        // A remote that dozes mid-gesture is no remote: hold the display while
        // the app is in front (every screen, not just the pad), unless the
        // user turned "Keep screen on" off.
        lifecycleScope.launch {
            prefs.prefs.collect { current ->
                if (current.keepScreenOn) {
                    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                } else {
                    window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                }
            }
        }
    }

    override fun onStart() {
        super.onStart()
        link.start()
    }

    override fun onStop() {
        cancelStemHold()
        // A stopped activity never sees the key-up, and the phone keeps the
        // hold (and its escape-menu countdown) running until it hears the
        // release — so end an in-progress hold before dropping the link.
        if (stemHoldSent) {
            stemHoldSent = false
            link.sendGesture(Gesture.LONG_PRESS_RELEASE)
        }
        link.stop()
        super.onStop()
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        when (keyCode) {
            KeyEvent.KEYCODE_STEM_1 -> {
                if (event.repeatCount == 0) {
                    cancelStemHold()
                    stemHoldSent = false
                    stemOneIgnored = glassesScreenIsOff()
                    if (stemOneIgnored) return true
                    val runnable = Runnable {
                        if (glassesScreenIsOff()) {
                            stemOneIgnored = true
                        } else {
                            stemHoldSent = true
                            haptics.heavy()
                            link.sendGesture(Gesture.LONG_PRESS_START)
                        }
                    }
                    stemHoldRunnable = runnable
                    stemHandler.postDelayed(runnable, STEM_HOLD_MS)
                }
                return true
            }
            KeyEvent.KEYCODE_STEM_2 -> {
                if (event.repeatCount == 0) {
                    haptics.doubleClick()
                    link.sendGesture(Gesture.DOUBLE_CLICK)
                }
                return true
            }
            KeyEvent.KEYCODE_STEM_3 -> {
                if (event.repeatCount == 0 && !glassesScreenIsOff()) {
                    haptics.click()
                    link.sendGesture(Gesture.WAKEWORD)
                }
                return true
            }
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onKeyUp(keyCode: Int, event: KeyEvent): Boolean {
        if (keyCode == KeyEvent.KEYCODE_STEM_1) {
            cancelStemHold()
            if (stemOneIgnored) {
                stemOneIgnored = false
                return true
            }
            if (stemHoldSent) {
                stemHoldSent = false
                haptics.click()
                link.sendGesture(Gesture.LONG_PRESS_RELEASE)
            } else if (!glassesScreenIsOff()) {
                haptics.click()
                link.sendGesture(Gesture.CLICK)
            }
            return true
        }
        if (keyCode == KeyEvent.KEYCODE_STEM_2 || keyCode == KeyEvent.KEYCODE_STEM_3) return true
        return super.onKeyUp(keyCode, event)
    }

    private fun cancelStemHold() {
        stemHoldRunnable?.let { stemHandler.removeCallbacks(it) }
        stemHoldRunnable = null
    }

    private fun glassesScreenIsOff(): Boolean =
        link.state.value?.let { it.connected && !it.screenOn } == true

    private companion object {
        const val STEM_HOLD_MS = 450L
    }
}
