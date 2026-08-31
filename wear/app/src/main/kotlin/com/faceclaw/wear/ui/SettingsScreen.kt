package com.faceclaw.wear.ui

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.rememberScalingLazyListState
import androidx.wear.compose.material.Chip
import androidx.wear.compose.material.ChipDefaults
import androidx.wear.compose.material.ListHeader
import androidx.wear.compose.material.MaterialTheme
import androidx.wear.compose.material.PositionIndicator
import androidx.wear.compose.material.Scaffold
import androidx.wear.compose.material.Switch
import androidx.wear.compose.material.Text
import androidx.wear.compose.material.TimeText
import androidx.wear.compose.material.ToggleChip
import com.faceclaw.wear.BuildConfig
import com.faceclaw.wear.Prefs
import com.faceclaw.wear.WatchPrefs

/** Watch-local preferences: feel of the pad and crown. */
@Composable
fun SettingsScreen(prefs: Prefs, store: WatchPrefs) {
    val listState = rememberScalingLazyListState()
    Scaffold(
        timeText = { TimeText() },
        positionIndicator = { PositionIndicator(scalingLazyListState = listState) },
    ) {
        ScalingLazyColumn(state = listState, modifier = Modifier.fillMaxSize()) {
            item { ListHeader { Text("Touchpad") } }
            item {
                ToggleChip(
                    checked = prefs.haptics,
                    onCheckedChange = { on -> store.update { it.copy(haptics = on) } },
                    label = { Text("Vibrate on input") },
                    toggleControl = { Switch(checked = prefs.haptics) },
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            item {
                ToggleChip(
                    checked = prefs.keepScreenOn,
                    onCheckedChange = { on -> store.update { it.copy(keepScreenOn = on) } },
                    label = { Text("Keep screen on") },
                    secondaryLabel = { Text("while Faceclaw is in front") },
                    toggleControl = { Switch(checked = prefs.keepScreenOn) },
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            item {
                ToggleChip(
                    checked = prefs.naturalScroll,
                    onCheckedChange = { on -> store.update { it.copy(naturalScroll = on) } },
                    label = { Text("Natural swipe") },
                    secondaryLabel = { Text(if (prefs.naturalScroll) "content follows finger" else "swipe up = scroll up (ring)") },
                    toggleControl = { Switch(checked = prefs.naturalScroll) },
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            item {
                ToggleChip(
                    checked = prefs.tapZones,
                    onCheckedChange = { on -> store.update { it.copy(tapZones = on) } },
                    label = { Text("Tap zones") },
                    secondaryLabel = { Text("tap top/bottom to scroll") },
                    toggleControl = { Switch(checked = prefs.tapZones) },
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            item {
                Chip(
                    onClick = { store.update { it.copy(swipeLeft = it.swipeLeft.next()) } },
                    label = { Text("Swipe left") },
                    secondaryLabel = { Text(prefs.swipeLeft.label) },
                    colors = ChipDefaults.secondaryChipColors(),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            item {
                Chip(
                    onClick = { store.update { it.copy(swipeRight = it.swipeRight.next()) } },
                    label = { Text("Swipe right") },
                    secondaryLabel = { Text(prefs.swipeRight.label) },
                    colors = ChipDefaults.secondaryChipColors(),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            item { ListHeader { Text("Tip taps") } }
            item {
                ToggleChip(
                    checked = prefs.fingerTaps,
                    onCheckedChange = { on -> store.update { it.copy(fingerTaps = on) } },
                    label = { Text("Fingertip taps (experimental)") },
                    secondaryLabel = { Text("finger to thumb: select / double = back") },
                    toggleControl = { Switch(checked = prefs.fingerTaps) },
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            item {
                Chip(
                    onClick = { store.update { it.copy(tapSensitivity = it.tapSensitivity.next()) } },
                    label = { Text("Tap sensitivity") },
                    secondaryLabel = { Text(prefs.tapSensitivity.label) },
                    colors = ChipDefaults.secondaryChipColors(),
                    modifier = Modifier.fillMaxWidth(),
                    enabled = prefs.fingerTaps,
                )
            }
            item {
                Text(
                    "Experimental: taps are read from the motion sensors while the pad is open, and ignored while the arm is moving.",
                    style = MaterialTheme.typography.caption3,
                    color = MaterialTheme.colors.onSurfaceVariant,
                    textAlign = TextAlign.Center,
                )
            }
            item { ListHeader { Text("Wrist twist") } }
            item {
                ToggleChip(
                    checked = prefs.wristTwist,
                    onCheckedChange = { on -> store.update { it.copy(wristTwist = on) } },
                    label = { Text("Twist twice = back") },
                    secondaryLabel = { Text("two quick wrist flicks") },
                    toggleControl = { Switch(checked = prefs.wristTwist) },
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            item {
                Chip(
                    onClick = { store.update { it.copy(twistSensitivity = it.twistSensitivity.next()) } },
                    label = { Text("Twist sensitivity") },
                    secondaryLabel = { Text(prefs.twistSensitivity.label) },
                    colors = ChipDefaults.secondaryChipColors(),
                    modifier = Modifier.fillMaxWidth(),
                    enabled = prefs.wristTwist,
                )
            }
            item { ListHeader { Text("Crown") } }
            item {
                Chip(
                    onClick = { store.update { it.copy(crownSensitivity = it.crownSensitivity.next()) } },
                    label = { Text("Sensitivity") },
                    secondaryLabel = { Text(prefs.crownSensitivity.label) },
                    colors = ChipDefaults.secondaryChipColors(),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            item { ListHeader { Text("Buttons") } }
            item {
                Text(
                    "Side button 1: tap = select, hold = long press.\nButton 2: back.\nButton 3: “Hey Even”.",
                    style = MaterialTheme.typography.caption2,
                    color = MaterialTheme.colors.onSurfaceVariant,
                    textAlign = TextAlign.Center,
                )
            }
            item {
                Text(
                    "Faceclaw watch v${BuildConfig.VERSION_NAME}",
                    style = MaterialTheme.typography.caption3,
                    color = MaterialTheme.colors.onSurfaceVariant,
                    textAlign = TextAlign.Center,
                )
            }
        }
    }
}
