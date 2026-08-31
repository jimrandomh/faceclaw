package com.faceclaw.wear.ui

import android.text.format.DateFormat
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.focusable
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.rotary.onRotaryScrollEvent
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.wear.compose.foundation.ExperimentalWearFoundationApi
import androidx.wear.compose.foundation.rememberActiveFocusRequester
import androidx.wear.compose.material.Button
import androidx.wear.compose.material.ButtonDefaults
import androidx.wear.compose.material.Icon
import androidx.wear.compose.material.MaterialTheme
import androidx.wear.compose.material.Text
import com.faceclaw.wear.Command
import com.faceclaw.wear.FingerTapDetector
import com.faceclaw.wear.Gesture
import com.faceclaw.wear.Haptics
import com.faceclaw.wear.OnBodyMonitor
import com.faceclaw.wear.PhoneLink
import com.faceclaw.wear.Prefs
import com.faceclaw.wear.R
import com.faceclaw.wear.SwipeAction
import com.faceclaw.wear.WristTwistDetector
import kotlinx.coroutines.delay
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.math.abs

/** A two-finger swipe scrolls this many steps: a "page". */
private const val TWO_FINGER_SWIPE_STEPS = 3
private val EDGE_REVEAL_ZONE = 24.dp
private val BUTTON_TRAY_HEIGHT = 62.dp

/**
 * The touchpad. The whole screen is the pad: tap = select, double-tap =
 * back, hold = long press (released when the finger lifts), two-finger tap =
 * the hold menu ("right click"), swipes in four directions = spatial
 * navigation (crown and two-finger vertical swipes = plain scrolling, a page
 * at a time for the latter). Fingertip pinch-taps from the motion sensors
 * select / go back, and two quick wrist twists go back. An upward swipe that
 * begins at the bottom edge reveals the otherwise-hidden action buttons.
 */
// rememberActiveFocusRequester (rotary focus) is still experimental in Wear Compose 1.4.
@OptIn(ExperimentalWearFoundationApi::class)
@Composable
fun RemoteScreen(
    link: PhoneLink,
    prefs: Prefs,
    haptics: Haptics,
    onOpenApps: () -> Unit,
    onOpenAssistant: () -> Unit,
    onOpenStatus: () -> Unit,
) {
    val state by link.state.collectAsStateWithLifecycle()
    val linkStatus by link.link.collectAsStateWithLifecycle()
    val notice by link.notice.collectAsStateWithLifecycle()
    val currentPrefs by rememberUpdatedState(prefs)
    val currentState by rememberUpdatedState(state)
    val view = LocalView.current
    val density = LocalDensity.current
    val edgeRevealPx = remember(density) { with(density) { EDGE_REVEAL_ZONE.toPx() } }
    val buttonTrayHeightPx = remember(density) { with(density) { BUTTON_TRAY_HEIGHT.toPx() } }
    var controlsVisible by remember { mutableStateOf(false) }
    var longPressSent by remember { mutableStateOf(false) }
    // Rotary (crown) events are only delivered to a focused node.
    // rememberActiveFocusRequester requests focus through the hierarchical
    // focus machinery; the resume observer below takes it back after every
    // excursion that steals it (the keyboard activity, ambient, screen off).
    val focusRequester = rememberActiveFocusRequester()
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner, focusRequester) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) focusRequester.requestFocus()
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }
    var crownAccumulator by remember { mutableStateOf(0f) }
    // Pad height in px, for the tap zones; written by onSizeChanged, read by
    // the gesture callbacks (plain holder: the callbacks are remembered once).
    val padHeight = remember { floatArrayOf(1f) }

    val keyboardToApp = rememberKeyboardLauncher(
        label = stringResource(R.string.keyboard_label_app),
        onResult = { text -> haptics.click(); link.sendText(text) },
        onUnavailable = { haptics.error() },
    )

    fun glassesScreenIsOff(): Boolean = currentState?.connected == true && currentState?.screenOn == false

    fun gestureAllowed(gesture: Gesture): Boolean =
        !glassesScreenIsOff() || gesture == Gesture.DOUBLE_CLICK

    fun scroll(gesture: Gesture, steps: Int) {
        if (!gestureAllowed(gesture)) return
        haptics.tick()
        link.sendGesture(gesture, steps)
    }

    fun click() {
        if (!gestureAllowed(Gesture.CLICK)) return
        haptics.click()
        link.sendGesture(Gesture.CLICK)
    }

    fun doubleClick() {
        haptics.doubleClick()
        link.sendGesture(Gesture.DOUBLE_CLICK)
    }

    /** Run a horizontal-swipe action; `left` says which way the finger went. */
    fun perform(action: SwipeAction, left: Boolean) {
        when (action) {
            SwipeAction.NAVIGATE -> {
                val gesture = if (left) Gesture.SWIPE_LEFT else Gesture.SWIPE_RIGHT
                if (gestureAllowed(gesture)) { haptics.click(); link.sendGesture(gesture) }
            }
            SwipeAction.SIDEBAR -> if (!glassesScreenIsOff()) {
                haptics.click()
                link.sendCommand(Command.SIDEBAR, "source" to "gesture")
            }
            SwipeAction.DOUBLE_CLICK -> doubleClick()
            SwipeAction.CLICK -> click()
            SwipeAction.LONG_PRESS -> if (!glassesScreenIsOff()) { haptics.heavy(); link.sendGesture(Gesture.LONG_PRESS) }
            SwipeAction.WAKEWORD -> if (!glassesScreenIsOff()) { haptics.click(); link.sendGesture(Gesture.WAKEWORD) }
            SwipeAction.NONE -> Unit
        }
    }

    /** Whether a vertical swipe means "up", honouring the natural-scroll preference. */
    fun swipeIsUp(dy: Float): Boolean {
        // Ring convention: swiping up means up. "Natural" flips it so the
        // content follows the finger like a touch screen.
        return if (currentPrefs.naturalScroll) dy > 0 else dy < 0
    }

    val callbacks = remember(link, haptics) {
        TouchpadCallbacks(
            onTap = { position ->
                if (currentPrefs.tapZones) {
                    // Top third scrolls up, bottom third down, the middle clicks.
                    val zone = position.y / padHeight[0].coerceAtLeast(1f)
                    when {
                        zone < 1f / 3f -> scroll(Gesture.SCROLL_UP, 1)
                        zone > 2f / 3f -> scroll(Gesture.SCROLL_DOWN, 1)
                        else -> click()
                    }
                } else {
                    click()
                }
            },
            onDoubleTap = { _ -> doubleClick() },
            // Two fingers = back as well: easier than timing a double-tap.
            onTwoFingerTap = { doubleClick() },
            onTwoFingerSwipe = { dx, dy ->
                if (abs(dy) >= abs(dx)) {
                    scroll(if (swipeIsUp(dy)) Gesture.SCROLL_UP else Gesture.SCROLL_DOWN, TWO_FINGER_SWIPE_STEPS)
                } else {
                    perform(if (dx < 0) currentPrefs.swipeLeft else currentPrefs.swipeRight, left = dx < 0)
                }
            },
            onLongPressStart = {
                longPressSent = !glassesScreenIsOff()
                if (longPressSent) {
                    haptics.heavy()
                    link.sendGesture(Gesture.LONG_PRESS_START)
                }
            },
            onLongPressEnd = {
                if (longPressSent) {
                    longPressSent = false
                    haptics.click()
                    link.sendGesture(Gesture.LONG_PRESS_RELEASE)
                }
            },
            onSwipe = { start, dx, dy, _ ->
                val vertical = abs(dy) >= abs(dx)
                val padBottom = padHeight[0]
                when {
                    vertical && !controlsVisible && dy < 0 && start.y >= padBottom - edgeRevealPx -> {
                        controlsVisible = true
                        haptics.click()
                    }
                    vertical && controlsVisible && dy > 0 && start.y >= padBottom - buttonTrayHeightPx -> {
                        controlsVisible = false
                        haptics.click()
                    }
                    vertical -> {
                        // One step per swipe, regardless of length: the glasses
                        // repaint per step, and multi-step swipes overshot lists
                        // whenever the display lagged the finger. Fast repeated
                        // swiping, the crown, or a two-finger page swipe cover
                        // long distances instead.
                        val up = swipeIsUp(dy)
                        scroll(if (up) Gesture.SWIPE_UP else Gesture.SWIPE_DOWN, 1)
                    }
                    else -> perform(if (dx < 0) currentPrefs.swipeLeft else currentPrefs.swipeRight, left = dx < 0)
                }
            },
        )
    }

    // Motion-sensor gestures only count on a wrist (see OnBodyMonitor).
    val onBody = remember { OnBodyMonitor(view.context) }
    WhileStartedEffect(onBody, start = onBody::start, stop = onBody::stop)

    // Fingertip (pinch) taps from the motion sensors, only while the pad is up.
    val fingerTapsEnabled = prefs.fingerTaps
    val fingerTapDetector = remember(fingerTapsEnabled, link, haptics) {
        if (!fingerTapsEnabled) null else FingerTapDetector(
            context = view.context,
            sensitivity = { currentPrefs.tapSensitivity },
            quietUntil = { haptics.quietUntil() },
            onBody = { onBody.onBody },
            onTap = { click() },
            onDoubleTap = { doubleClick() },
        )
    }
    WhileStartedEffect(fingerTapDetector, start = { fingerTapDetector?.start() }, stop = { fingerTapDetector?.stop() })
    // Two quick wrist twists = back, from the gyroscope, only while the pad is up.
    val wristTwistEnabled = prefs.wristTwist
    val wristTwistDetector = remember(wristTwistEnabled, link, haptics) {
        if (!wristTwistEnabled) null else WristTwistDetector(
            context = view.context,
            sensitivity = { currentPrefs.twistSensitivity },
            quietUntil = { haptics.quietUntil() },
            onBody = { onBody.onBody },
            onDoubleTwist = { doubleClick() },
        )
    }
    WhileStartedEffect(wristTwistDetector, start = { wristTwistDetector?.start() }, stop = { wristTwistDetector?.stop() })

    // A refused or unanswered gesture gets a distinct buzz, so the wrist knows
    // without looking (the notice pill says why).
    LaunchedEffect(notice?.id) {
        if (notice?.isError == true) haptics.error()
    }


    Box(
        modifier = Modifier
            .fillMaxSize()
            .onRotaryScrollEvent { event ->
                crownAccumulator += event.verticalScrollPixels
                val threshold = currentPrefs.crownSensitivity.pixelsPerStep
                var steps = 0
                while (crownAccumulator >= threshold) { crownAccumulator -= threshold; steps++ }
                while (crownAccumulator <= -threshold) { crownAccumulator += threshold; steps-- }
                // Capped low: a fast twirl otherwise outruns the display.
                val clockwise = if (currentState?.crownClockwiseNext == true) Gesture.SCROLL_DOWN else Gesture.SCROLL_UP
                val counterClockwise = if (currentState?.crownClockwiseNext == true) Gesture.SCROLL_UP else Gesture.SCROLL_DOWN
                if (steps > 0) scroll(clockwise, steps.coerceAtMost(2))
                if (steps < 0) scroll(counterClockwise, (-steps).coerceAtMost(2))
                true
            }
            .focusRequester(focusRequester)
            .focusable()
            .onSizeChanged { padHeight[0] = it.height.toFloat() }
            .pointerInput(callbacks) { detectTouchpadGestures(callbacks) },
    ) {
        StraightTime(modifier = Modifier.align(Alignment.Center))

        AnimatedVisibility(
            visible = !controlsVisible,
            enter = fadeIn(),
            exit = fadeOut(),
            modifier = Modifier.align(Alignment.Center).offset(y = 46.dp),
        ) {
            val pad = padLine(state, linkStatus)
            Text(
                text = pad.text,
                style = MaterialTheme.typography.title3,
                color = if (pad.tone == StatusTone.GOOD) MaterialTheme.colors.onSurface else pad.tone.color(),
                textAlign = TextAlign.Center,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(horizontal = 42.dp),
            )
        }

        AnimatedVisibility(
            visible = controlsVisible,
            enter = slideInVertically(initialOffsetY = { it }),
            exit = slideOutVertically(targetOffsetY = { it }),
            modifier = Modifier.align(Alignment.BottomCenter),
        ) {
            Row(
                // Four 36dp buttons need 144dp; at this height the round
                // display's chord is ~186dp wide, so 36dp margins keep every
                // button inside the glass.
                modifier = Modifier
                    .fillMaxWidth()
                    .height(BUTTON_TRAY_HEIGHT)
                    .pointerInput(Unit) {
                        detectTrayDismiss {
                            controlsVisible = false
                            haptics.click()
                        }
                    }
                    .padding(horizontal = 36.dp)
                    .padding(bottom = 26.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                PadButton(icon = R.drawable.ic_assistant, description = "Assistant", onClick = onOpenAssistant)
                PadButton(icon = R.drawable.ic_keyboard, description = "Type into app", onClick = keyboardToApp)
                PadButton(icon = R.drawable.ic_apps, description = "Apps", onClick = onOpenApps)
                PadButton(icon = R.drawable.ic_more, description = "Status and settings", onClick = onOpenStatus)
            }
        }

        NoticeOverlay(notice)
    }
}

/**
 * Run start/stop with the composition AND the activity lifecycle: started on
 * ON_START (or immediately if already started), stopped on ON_STOP and on
 * leaving the composition. A plain DisposableEffect keeps sensors registered
 * while the activity sits stopped-but-cached (palmed screen, back on the watch
 * face), which at gyroscope/accelerometer rates is a real battery drain.
 */
@Composable
private fun WhileStartedEffect(key: Any?, start: () -> Unit, stop: () -> Unit) {
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner, key) {
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_START -> start()
                Lifecycle.Event.ON_STOP -> stop()
                else -> Unit
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose {
            lifecycleOwner.lifecycle.removeObserver(observer)
            stop()
        }
    }
}

/** A large, straight clock fixed on the vertical centre of the touchpad. */
@Composable
private fun StraightTime(modifier: Modifier = Modifier) {
    val context = LocalContext.current
    var now by remember { mutableStateOf(System.currentTimeMillis()) }
    val pattern = remember(context) { if (DateFormat.is24HourFormat(context)) "HH:mm" else "h:mm" }
    val formatter = remember(pattern) { SimpleDateFormat(pattern, Locale.getDefault()) }
    LaunchedEffect(Unit) {
        while (true) {
            val current = System.currentTimeMillis()
            now = current
            delay(60_000L - current % 60_000L)
        }
    }
    Text(
        text = formatter.format(Date(now)),
        color = MaterialTheme.colors.onSurface,
        fontSize = 42.sp,
        textAlign = TextAlign.Center,
        maxLines = 1,
        modifier = modifier,
    )
}

@Composable
private fun PadButton(icon: Int, description: String, onClick: () -> Unit) {
    Button(
        onClick = onClick,
        modifier = Modifier.size(36.dp),
        colors = ButtonDefaults.secondaryButtonColors(),
    ) {
        Icon(
            painter = painterResource(icon),
            contentDescription = description,
            modifier = Modifier.size(20.dp),
        )
    }
}
