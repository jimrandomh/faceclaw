package com.faceclaw.wear.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.wear.compose.material.MaterialTheme
import androidx.wear.compose.material.Text
import com.faceclaw.wear.LinkStatus
import com.faceclaw.wear.Notice
import com.faceclaw.wear.PhoneState

/** A transient pill at the bottom of the screen: ack failures and confirmations. */
@Composable
fun NoticeOverlay(notice: Notice?) {
    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.BottomCenter) {
        AnimatedVisibility(visible = notice != null, enter = fadeIn(), exit = fadeOut()) {
            val current = notice ?: return@AnimatedVisibility
            Text(
                text = current.text,
                style = MaterialTheme.typography.caption2,
                color = if (current.isError) Color(0xFFFFB4A8) else MaterialTheme.colors.onSurface,
                textAlign = TextAlign.Center,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier
                    .padding(horizontal = 28.dp, vertical = 18.dp)
                    .background(
                        if (current.isError) Color(0xFF4A1F1A) else Color(0xFF2A2A2A),
                        RoundedCornerShape(14.dp),
                    )
                    .padding(horizontal = 10.dp, vertical = 5.dp),
            )
        }
    }
}

/** The pad's single indicator line, with a tone that picks its colour. */
data class StatusLine(val text: String, val tone: StatusTone)

enum class StatusTone { GOOD, BUSY, OFF, PROBLEM }

/**
 * The pad's centre indicator: what the next gesture lands on when everything
 * is connected (the foreground app, or the screen/lock state in the way of
 * it), otherwise the connection problem to fix first.
 */
fun padLine(state: PhoneState?, link: LinkStatus): StatusLine = when {
    !link.phoneReachable -> StatusLine("No phone", StatusTone.PROBLEM)
    !link.phoneAppInstalled -> StatusLine("Install Faceclaw on phone", StatusTone.PROBLEM)
    link.appRunning == false -> StatusLine("Open Faceclaw on phone", StatusTone.PROBLEM)
    state == null -> StatusLine("Waiting for phone", StatusTone.BUSY)
    state.remoteEnabled == false -> StatusLine("Watch control off", StatusTone.PROBLEM)
    state.connected -> when {
        state.charging || state.phase == "charging" -> StatusLine(chargingLine(state.battery), StatusTone.BUSY)
        state.silentMode -> StatusLine("Silent mode", StatusTone.OFF)
        state.locked -> StatusLine("Locked", StatusTone.OFF)
        !state.screenOn -> StatusLine("●● Wake", StatusTone.OFF)
        state.listening -> StatusLine("Listening…", StatusTone.BUSY)
        else -> StatusLine(state.foreground?.title ?: "Launcher", StatusTone.GOOD)
    }
    state.phase == "connecting" -> StatusLine("Connecting…", StatusTone.BUSY)
    state.phase == "disconnecting" -> StatusLine("Disconnecting…", StatusTone.BUSY)
    else -> StatusLine("Glasses disconnected", StatusTone.OFF)
}

private fun chargingLine(battery: Int?): String =
    if (battery != null) "Charging · G2 $battery%" else "Charging"

fun StatusTone.color(): Color = when (this) {
    StatusTone.GOOD -> Color(0xFF7BD88F)
    StatusTone.BUSY -> Color(0xFFF2C14E)
    StatusTone.OFF -> Color(0xFF8A8A8A)
    StatusTone.PROBLEM -> Color(0xFFFF8A80)
}
