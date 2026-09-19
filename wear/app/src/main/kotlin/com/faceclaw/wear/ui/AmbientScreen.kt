package com.faceclaw.wear.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.wear.compose.material.MaterialTheme
import androidx.wear.compose.material.Text
import com.faceclaw.wear.AmbientMode
import com.faceclaw.wear.PhoneLink
import java.util.Date
import kotlin.random.Random

/** Burn-in protection shifts the content by up to this many pixels each way. */
private const val BURN_IN_SHIFT_PX = 8

/**
 * The always-on face: the pad's clock and its status line on black, nothing
 * else and nothing moving. Redraws when [AmbientMode.tick] changes (the
 * system's once-a-minute ambient update) and when the phone's state does.
 */
@Composable
fun AmbientScreen(link: PhoneLink, ambient: AmbientMode) {
    val state by link.state.collectAsStateWithLifecycle()
    val linkStatus by link.link.collectAsStateWithLifecycle()
    val formatter = rememberClockFormatter()
    val time = remember(ambient.tick, formatter) { formatter.format(Date()) }
    val shift = remember(ambient.tick, ambient.burnInProtectionRequired) {
        if (!ambient.burnInProtectionRequired) IntOffset.Zero else {
            val random = Random(ambient.tick)
            IntOffset(
                random.nextInt(-BURN_IN_SHIFT_PX, BURN_IN_SHIFT_PX + 1),
                random.nextInt(-BURN_IN_SHIFT_PX, BURN_IN_SHIFT_PX + 1),
            )
        }
    }
    // A 1-bit panel renders grey as noise: everything white there.
    val statusColor = if (ambient.lowBit) Color.White else Color(0xFF8A8A8A)

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color.Black)
            .offset { shift },
    ) {
        Text(
            text = time,
            color = Color.White,
            fontSize = 42.sp,
            textAlign = TextAlign.Center,
            maxLines = 1,
            modifier = Modifier.align(Alignment.Center),
        )
        Text(
            text = padLine(state, linkStatus).text,
            style = MaterialTheme.typography.title3,
            color = statusColor,
            textAlign = TextAlign.Center,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier
                .align(Alignment.Center)
                .offset(y = 46.dp)
                .padding(horizontal = 42.dp),
        )
    }
}
