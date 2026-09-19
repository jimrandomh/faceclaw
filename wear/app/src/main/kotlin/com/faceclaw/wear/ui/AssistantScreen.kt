package com.faceclaw.wear.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.rememberScalingLazyListState
import androidx.wear.compose.material.Button
import androidx.wear.compose.material.ButtonDefaults
import androidx.wear.compose.material.Chip
import androidx.wear.compose.material.ChipDefaults
import androidx.wear.compose.material.Icon
import androidx.wear.compose.material.MaterialTheme
import androidx.wear.compose.material.PositionIndicator
import androidx.wear.compose.material.Scaffold
import androidx.wear.compose.material.Text
import androidx.wear.compose.material.TimeText
import com.faceclaw.wear.Command
import com.faceclaw.wear.Gesture
import com.faceclaw.wear.Haptics
import com.faceclaw.wear.PhoneLink
import com.faceclaw.wear.R

/**
 * Ask the assistant from the wrist (watch speech recognition or keyboard) and
 * read its reply here as it streams, mirrored from the glasses overlay. "Hey
 * Even" instead uses the glasses' own microphone and voice dialog.
 */
@Composable
fun AssistantScreen(link: PhoneLink, haptics: Haptics) {
    val state by link.state.collectAsStateWithLifecycle()
    val mirror by link.assistant.collectAsStateWithLifecycle()
    val notice by link.notice.collectAsStateWithLifecycle()
    val listState = rememberScalingLazyListState()
    val available = state?.assistantAvailable != false

    val ask = rememberSpeechLauncher(
        prompt = stringResource(R.string.speech_prompt_assistant),
        onResult = { text -> haptics.click(); link.sendAssistantQuery(text) },
        onUnavailable = { haptics.error() },
    )
    val type = rememberKeyboardLauncher(
        label = stringResource(R.string.keyboard_label_assistant),
        onResult = { text -> haptics.click(); link.sendAssistantQuery(text) },
        onUnavailable = { haptics.error() },
    )

    // A finished reply deserves a nudge: the wrist may be down while it streams.
    LaunchedEffect(mirror.phase, mirror.updatedAt) {
        if (mirror.phase == "done" || mirror.phase == "error") haptics.doubleClick()
    }

    Scaffold(
        timeText = { TimeText() },
        positionIndicator = { PositionIndicator(scalingLazyListState = listState) },
    ) {
        ScalingLazyColumn(state = listState, modifier = Modifier.fillMaxSize()) {
            item {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(top = 6.dp),
                    horizontalArrangement = Arrangement.Center,
                ) {
                    Button(onClick = ask, modifier = Modifier.size(44.dp), enabled = available) {
                        Icon(painterResource(R.drawable.ic_mic), contentDescription = "Ask by voice", modifier = Modifier.size(22.dp))
                    }
                    Spacer(modifier = Modifier.size(10.dp))
                    Button(
                        onClick = type,
                        modifier = Modifier.size(44.dp),
                        colors = ButtonDefaults.secondaryButtonColors(),
                        enabled = available,
                    ) {
                        Icon(painterResource(R.drawable.ic_keyboard), contentDescription = "Ask by keyboard", modifier = Modifier.size(22.dp))
                    }
                }
            }
            item {
                val label = when (mirror.phase) {
                    "thinking" -> "Thinking…"
                    "streaming" -> "Replying…"
                    "error" -> "Error"
                    "done" -> "Reply"
                    else -> if (available) "Ask something" else "Set up the assistant in Faceclaw's Settings"
                }
                Text(
                    label,
                    style = MaterialTheme.typography.caption1,
                    color = MaterialTheme.colors.onSurfaceVariant,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
                )
            }
            if (mirror.text.isNotBlank()) {
                item {
                    Text(
                        mirror.text,
                        style = MaterialTheme.typography.body2,
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 6.dp, vertical = 4.dp),
                    )
                }
            }
            item {
                Chip(
                    onClick = {
                        haptics.click()
                        link.sendGesture(Gesture.WAKEWORD)
                    },
                    label = { Text("“Hey Even” on glasses") },
                    secondaryLabel = { Text("uses the glasses mic") },
                    colors = ChipDefaults.secondaryChipColors(),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            if (mirror.phase != "idle") {
                item {
                    Chip(
                        onClick = {
                            haptics.click()
                            link.sendCommand(Command.CLOSE_ASSISTANT)
                            link.clearAssistant()
                        },
                        label = { Text(if (mirror.phase == "thinking" || mirror.phase == "streaming") "Cancel" else "Dismiss") },
                        colors = ChipDefaults.secondaryChipColors(),
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
        }
        NoticeOverlay(notice)
    }
}
