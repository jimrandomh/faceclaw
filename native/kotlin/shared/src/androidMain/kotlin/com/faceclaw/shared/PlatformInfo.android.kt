package com.faceclaw.shared

import android.os.Looper

internal actual object PlatformInfo {
    actual val name: String = "Android"

    actual fun threadName(): String = Thread.currentThread().name

    actual fun isMainThread(): Boolean = Looper.myLooper() == Looper.getMainLooper()
}
