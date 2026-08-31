package com.faceclaw.wear.ui

import android.app.Activity
import android.app.RemoteInput
import android.content.ActivityNotFoundException
import android.content.Intent
import android.speech.RecognizerIntent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberUpdatedState
import androidx.wear.input.RemoteInputIntentHelper

private const val REMOTE_INPUT_KEY = "faceclaw_text"

/**
 * The watch's own speech recognizer (the system's, so it works with the
 * wrist raised and no glasses mic involved). Returns a launcher; the
 * recognized text arrives in onResult.
 */
@Composable
fun rememberSpeechLauncher(
    prompt: String,
    onResult: (String) -> Unit,
    onUnavailable: () -> Unit,
): () -> Unit {
    val currentOnResult = rememberUpdatedState(onResult)
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        if (result.resultCode != Activity.RESULT_OK) return@rememberLauncherForActivityResult
        val text = result.data
            ?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)
            ?.firstOrNull()
            ?.trim()
        if (!text.isNullOrEmpty()) currentOnResult.value(text)
    }
    return {
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            .putExtra(RecognizerIntent.EXTRA_PROMPT, prompt)
        try {
            launcher.launch(intent)
        } catch (error: ActivityNotFoundException) {
            onUnavailable()
        }
    }
}

/**
 * The Wear OS text entry sheet (keyboard / voice / handwriting, whatever the
 * watch offers). Returns a launcher; the entered text arrives in onResult.
 */
@Composable
fun rememberKeyboardLauncher(
    label: String,
    onResult: (String) -> Unit,
    onUnavailable: () -> Unit,
): () -> Unit {
    val currentOnResult = rememberUpdatedState(onResult)
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        if (result.resultCode != Activity.RESULT_OK) return@rememberLauncherForActivityResult
        val data = result.data ?: return@rememberLauncherForActivityResult
        val text = RemoteInput.getResultsFromIntent(data)
            ?.getCharSequence(REMOTE_INPUT_KEY)
            ?.toString()
            ?.trim()
        if (!text.isNullOrEmpty()) currentOnResult.value(text)
    }
    return {
        val remoteInput = RemoteInput.Builder(REMOTE_INPUT_KEY)
            .setLabel(label)
            .setAllowFreeFormInput(true)
            .build()
        val intent = RemoteInputIntentHelper.createActionRemoteInputIntent()
        RemoteInputIntentHelper.putRemoteInputsExtra(intent, listOf(remoteInput))
        RemoteInputIntentHelper.putTitleExtra(intent, label)
        try {
            launcher.launch(intent)
        } catch (error: ActivityNotFoundException) {
            onUnavailable()
        }
    }
}
