package com.faceclaw.wear.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.graphics.Color
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.wear.compose.material.Colors
import androidx.wear.compose.material.MaterialTheme
import androidx.wear.compose.navigation.SwipeDismissableNavHost
import androidx.wear.compose.navigation.composable
import androidx.wear.compose.navigation.rememberSwipeDismissableNavController
import com.faceclaw.wear.Haptics
import com.faceclaw.wear.PhoneLink
import com.faceclaw.wear.WatchPrefs

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

/** Root: the remote pad, with every other screen a swipe-back away. */
@Composable
fun FaceclawWearApp(link: PhoneLink, prefsStore: WatchPrefs, haptics: Haptics) {
    val prefs by prefsStore.prefs.collectAsStateWithLifecycle()
    val navController = rememberSwipeDismissableNavController()

    MaterialTheme(colors = FaceclawColors) {
        SwipeDismissableNavHost(navController = navController, startDestination = Routes.REMOTE) {
            composable(Routes.REMOTE) {
                RemoteScreen(
                    link = link,
                    prefs = prefs,
                    haptics = haptics,
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
                SettingsScreen(prefs = prefs, store = prefsStore)
            }
        }
    }
}
