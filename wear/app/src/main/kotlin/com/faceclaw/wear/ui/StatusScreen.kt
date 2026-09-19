package com.faceclaw.wear.ui

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.rememberScalingLazyListState
import androidx.wear.compose.material.Chip
import androidx.wear.compose.material.ChipDefaults
import androidx.wear.compose.material.Icon
import androidx.wear.compose.material.ListHeader
import androidx.wear.compose.material.PositionIndicator
import androidx.wear.compose.material.Scaffold
import androidx.wear.compose.material.Text
import androidx.wear.compose.material.TimeText
import com.faceclaw.wear.Command
import com.faceclaw.wear.DisplayMode
import com.faceclaw.wear.Haptics
import com.faceclaw.wear.PhoneLink
import com.faceclaw.wear.R

/** Glasses and phone status, with the connection / display / lock switches. */
@Composable
fun StatusScreen(link: PhoneLink, haptics: Haptics, onOpenSettings: () -> Unit) {
    val state by link.state.collectAsStateWithLifecycle()
    val linkStatus by link.link.collectAsStateWithLifecycle()
    val notice by link.notice.collectAsStateWithLifecycle()
    val listState = rememberScalingLazyListState()
    val connected = state?.connected == true

    Scaffold(
        timeText = { TimeText() },
        positionIndicator = { PositionIndicator(scalingLazyListState = listState) },
    ) {
        ScalingLazyColumn(state = listState, modifier = Modifier.fillMaxSize()) {
            item { ListHeader { Text("Glasses") } }
            item {
                // Ordinarily the glasses' own top bar shows battery. While
                // charging that screen is inside the case, so show it here.
                val phaseLabel = when {
                    state == null -> "No status yet"
                    state?.charging == true || state?.phase == "charging" ->
                        state?.battery?.let { "Charging · G2 $it%" } ?: "Charging"
                    connected -> "Connected"
                    state?.phase == "connecting" -> "Connecting…"
                    state?.phase == "disconnecting" -> "Disconnecting…"
                    else -> "Disconnected"
                }
                Chip(
                    onClick = {
                        haptics.click()
                        link.sendCommand(if (connected) Command.DISCONNECT else Command.CONNECT)
                    },
                    label = { Text(phaseLabel, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                    secondaryLabel = { Text(if (connected) "tap to disconnect" else "tap to connect") },
                    colors = if (connected) ChipDefaults.primaryChipColors() else ChipDefaults.secondaryChipColors(),
                    modifier = Modifier.fillMaxWidth(),
                    enabled = linkStatus.appRunning != false,
                )
            }
            item {
                val on = state?.screenOn == true
                Chip(
                    onClick = {
                        haptics.click()
                        link.sendCommand(if (on) Command.SLEEP else Command.WAKE)
                    },
                    label = { Text(if (on) "Display on" else "Display off") },
                    secondaryLabel = { Text(if (on) "tap to turn off" else "tap to wake") },
                    colors = ChipDefaults.secondaryChipColors(),
                    modifier = Modifier.fillMaxWidth(),
                    enabled = connected && state?.locked != true,
                )
            }
            item {
                val locked = state?.locked == true
                Chip(
                    onClick = {
                        haptics.click()
                        link.sendCommand(if (locked) Command.UNLOCK else Command.LOCK)
                    },
                    label = { Text(if (locked) "Locked" else "Unlocked") },
                    secondaryLabel = {
                        Text(
                            when {
                                locked && state?.canUnlock == false -> "unlock from the phone"
                                locked -> "tap to unlock"
                                else -> "tap to lock"
                            },
                        )
                    },
                    colors = ChipDefaults.secondaryChipColors(),
                    modifier = Modifier.fillMaxWidth(),
                    enabled = connected && !(locked && state?.canUnlock == false),
                )
            }
            item {
                val mode = DisplayMode.fromWire(state?.displayMode ?: "") ?: DisplayMode.BAND
                Chip(
                    onClick = {
                        haptics.click()
                        link.sendCommand(Command.DISPLAY_MODE, "value" to mode.next().wire)
                    },
                    label = { Text("Display mode") },
                    secondaryLabel = { Text(mode.label) },
                    colors = ChipDefaults.secondaryChipColors(),
                    modifier = Modifier.fillMaxWidth(),
                    enabled = connected,
                )
            }
            state?.foreground?.let { foreground ->
                item {
                    Chip(
                        onClick = { haptics.click(); link.sendCommand(Command.SIDEBAR) },
                        label = { Text("On screen: ${foreground.title}", maxLines = 1, overflow = TextOverflow.Ellipsis) },
                        secondaryLabel = { Text("tap to open the sidebar") },
                        colors = ChipDefaults.secondaryChipColors(),
                        modifier = Modifier.fillMaxWidth(),
                        enabled = connected,
                    )
                }
            }

            item { ListHeader { Text("Phone") } }
            item {
                val phoneLabel = when {
                    !linkStatus.phoneReachable -> "No phone connected"
                    !linkStatus.phoneAppInstalled -> "Faceclaw not installed"
                    linkStatus.appRunning == false -> "Faceclaw not running"
                    else -> linkStatus.phoneName.ifBlank { "Phone" }
                }
                val detail = when {
                    !linkStatus.phoneReachable -> "check Bluetooth"
                    !linkStatus.phoneAppInstalled -> "install it on the phone"
                    linkStatus.appRunning == false -> "open it on the phone"
                    state?.version?.isNotBlank() == true -> "Faceclaw v${state?.version}"
                    else -> "tap to refresh"
                }
                Chip(
                    onClick = { haptics.click(); link.refresh() },
                    label = { Text(phoneLabel, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                    secondaryLabel = { Text(detail) },
                    icon = { Icon(painterResource(R.drawable.ic_refresh), contentDescription = null, modifier = Modifier.size(20.dp)) },
                    colors = ChipDefaults.secondaryChipColors(),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            if (state?.remoteEnabled == false) {
                item {
                    Text(
                        "Watch control is turned off in Faceclaw's Settings > Watch.",
                        style = androidx.wear.compose.material.MaterialTheme.typography.caption2,
                    )
                }
            }
            item {
                Chip(
                    onClick = onOpenSettings,
                    label = { Text("Watch settings") },
                    icon = { Icon(painterResource(R.drawable.ic_settings), contentDescription = null, modifier = Modifier.size(20.dp)) },
                    colors = ChipDefaults.secondaryChipColors(),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
        NoticeOverlay(notice)
    }
}
