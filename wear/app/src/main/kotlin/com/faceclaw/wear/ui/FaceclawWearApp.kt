package com.faceclaw.wear.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import androidx.wear.compose.material.Colors
import androidx.wear.compose.material.MaterialTheme
import androidx.wear.compose.navigation.SwipeDismissableNavHost
import androidx.wear.compose.navigation.composable
import androidx.wear.compose.navigation.rememberSwipeDismissableNavController
import com.faceclaw.wear.AmbientMode
import com.faceclaw.wear.Haptics
import com.faceclaw.wear.PhoneLink
import com.faceclaw.wear.Wake
import com.faceclaw.wear.WatchPrefs
import kotlinx.coroutines.flow.StateFlow

object Routes {
    const val REMOTE = "remote"
    const val APPS = "apps"
    const val ASSISTANT = "assistant"
    const val STATUS = "status"
    const val SETTINGS = "settings"
}

private val FaceclawColors = Colors(
    primary = Color(0xFFB8D8FF),
    primaryVariant = Color(0xFF7FB0F0),
    secondary = Color(0xFFC9C9C9),
    secondaryVariant = Color(0xFF8A8A8A),
    onPrimary = Color(0xFF0B1A2E),
    onSecondary = Color(0xFF101010),
)

/** The watch's ambient state, for screens that pause work while it is on. */
val LocalAmbientMode = compositionLocalOf { AmbientMode() }

/**
 * Root: the remote pad, with every other screen a swipe-back away. In ambient
 * [AmbientScreen] is laid over the lot. The screens stay composed underneath
 * (the nav host animates any destination it composes, which on every wake
 * was a visible flicker between two identical frames) and read
 * [LocalAmbientMode] to pause their sensors.
 */
@Composable
fun FaceclawWearApp(
    link: PhoneLink,
    prefsStore: WatchPrefs,
    haptics: Haptics,
    ambient: StateFlow<AmbientMode>,
    wakes: StateFlow<Wake?>,
) {
    val ambientMode by ambient.collectAsStateWithLifecycle()
    val navController = rememberSwipeDismissableNavController()

    MaterialTheme(colors = FaceclawColors) {
        CompositionLocalProvider(LocalAmbientMode provides ambientMode) {
            Box(modifier = Modifier.fillMaxSize()) {
                Screens(navController, link, prefsStore, haptics, wakes)
                if (ambientMode.active) AmbientScreen(link = link, ambient = ambientMode)
            }
        }
    }
}

@Composable
private fun Screens(
    navController: NavHostController,
    link: PhoneLink,
    prefsStore: WatchPrefs,
    haptics: Haptics,
    wakes: StateFlow<Wake?>,
) {
    // Prefs are collected inside each destination rather than passed in as a
    // value: the nav host keeps the content lambda it composed, so a value
    // captured by the builder would stay stale until the screen is re-entered.
    SwipeDismissableNavHost(navController = navController, startDestination = Routes.REMOTE) {
        composable(Routes.REMOTE) {
            val prefs by prefsStore.prefs.collectAsStateWithLifecycle()
            RemoteScreen(
                link = link,
                prefs = prefs,
                haptics = haptics,
                wakes = wakes,
                onOpenApps = { navController.navigate(Routes.APPS) },
                onOpenAssistant = { navController.navigate(Routes.ASSISTANT) },
                onOpenStatus = { navController.navigate(Routes.STATUS) },
            )
        }
        composable(Routes.APPS) {
            AppsScreen(link = link, haptics = haptics, onDone = { navController.popBackStack() })
        }
        composable(Routes.ASSISTANT) {
            AssistantScreen(link = link, haptics = haptics)
        }
        composable(Routes.STATUS) {
            StatusScreen(link = link, haptics = haptics, onOpenSettings = { navController.navigate(Routes.SETTINGS) })
        }
        composable(Routes.SETTINGS) {
            val prefs by prefsStore.prefs.collectAsStateWithLifecycle()
            SettingsScreen(prefs = prefs, store = prefsStore)
        }
    }
}
