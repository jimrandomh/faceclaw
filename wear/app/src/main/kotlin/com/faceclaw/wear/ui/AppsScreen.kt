package com.faceclaw.wear.ui

import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.items
import androidx.wear.compose.foundation.lazy.rememberScalingLazyListState
import androidx.wear.compose.material.Button
import androidx.wear.compose.material.ButtonDefaults
import androidx.wear.compose.material.Chip
import androidx.wear.compose.material.ChipDefaults
import androidx.wear.compose.material.Icon
import androidx.wear.compose.material.ListHeader
import androidx.wear.compose.material.PositionIndicator
import androidx.wear.compose.material.Scaffold
import androidx.wear.compose.material.Text
import androidx.wear.compose.material.TimeText
import com.faceclaw.wear.Command
import com.faceclaw.wear.Haptics
import com.faceclaw.wear.PhoneLink
import com.faceclaw.wear.R
import com.faceclaw.wear.WindowEntry

/**
 * The glasses' sidebar and launcher, on the wrist: open windows first (tap to
 * bring one to the front, × to close it), then every launchable app.
 */
@Composable
fun AppsScreen(link: PhoneLink, haptics: Haptics, onDone: () -> Unit) {
    val state by link.state.collectAsStateWithLifecycle()
    val notice by link.notice.collectAsStateWithLifecycle()
    val listState = rememberScalingLazyListState()
    val windows = state?.windows ?: emptyList()
    val apps = state?.apps ?: emptyList()

    Scaffold(
        timeText = { TimeText() },
        positionIndicator = { PositionIndicator(scalingLazyListState = listState) },
    ) {
        ScalingLazyColumn(
            state = listState,
            modifier = Modifier.fillMaxSize(),
        ) {
            val onScreen = windows.filter { it.focused }
            val others = windows.filter { !it.focused }
            if (onScreen.isNotEmpty()) {
                item { ListHeader { Text("On screen") } }
                items(onScreen, key = { "w:" + it.windowId }) { window -> WindowRow(window, link, haptics, onDone) }
            }
            if (others.isNotEmpty()) {
                item { ListHeader { Text("Also open") } }
                items(others, key = { "w:" + it.windowId }) { window -> WindowRow(window, link, haptics, onDone) }
            }
            item { ListHeader { Text(if (apps.isEmpty()) "No app list yet" else "Launch") } }
            items(apps, key = { "a:" + it.appId }) { app ->
                Chip(
                    onClick = {
                        haptics.click()
                        link.sendCommand(Command.LAUNCH_APP, "appId" to app.appId)
                        onDone()
                    },
                    label = { Text(app.title, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                    colors = ChipDefaults.secondaryChipColors(),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            if (apps.isEmpty()) {
                item {
                    Text(
                        "Open Faceclaw on the phone and connect the glasses.",
                        textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                        style = androidx.wear.compose.material.MaterialTheme.typography.caption2,
                    )
                }
            }
        }
        NoticeOverlay(notice)
    }
}

/** One open window: tap to bring it to the front, × to close it. */
@Composable
private fun WindowRow(window: WindowEntry, link: PhoneLink, haptics: Haptics, onDone: () -> Unit) {
    Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Chip(
            onClick = {
                haptics.click()
                link.sendCommand(Command.FOCUS_WINDOW, "windowId" to window.windowId)
                onDone()
            },
            // The launcher's window is titled "Apps" on the glasses; here that
            // would read as this very screen.
            label = { Text(if (window.appId == "launcher") "Launcher" else window.title, maxLines = 1, overflow = TextOverflow.Ellipsis) },
            secondaryLabel = if (window.acceptsText) ({ Text("takes typed text") }) else null,
            colors = if (window.focused) ChipDefaults.primaryChipColors() else ChipDefaults.secondaryChipColors(),
            modifier = Modifier.weight(1f),
        )
        if (window.closeable) {
            Spacer(modifier = Modifier.width(4.dp))
            Button(
                onClick = {
                    haptics.click()
                    link.sendCommand(Command.CLOSE_WINDOW, "windowId" to window.windowId)
                },
                modifier = Modifier.size(32.dp),
                colors = ButtonDefaults.secondaryButtonColors(),
            ) {
                Icon(
                    painter = painterResource(R.drawable.ic_close),
                    contentDescription = "Close ${window.title}",
                    modifier = Modifier.size(16.dp),
                )
            }
        }
    }
}
