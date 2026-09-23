@file:OptIn(kotlinx.cinterop.ExperimentalForeignApi::class)

package com.faceclaw.app

import kotlin.concurrent.Volatile
import platform.Foundation.NSBundle
import platform.Foundation.NSNotificationCenter
import platform.Foundation.NSOperationQueue
import platform.Foundation.NSThread
import platform.UIKit.UIApplication
import platform.UIKit.UIApplicationProtectedDataDidBecomeAvailable
import platform.UIKit.UIApplicationProtectedDataWillBecomeUnavailable
import platform.darwin.dispatch_async
import platform.darwin.dispatch_get_main_queue
import platform.darwin.dispatch_queue_create

/**
 * iOS [SessionHost]: listener callbacks go to the main queue (NativeScript's JavaScript
 * thread), the session worker is an NSThread, the "glasses screen on" wake lock maps to the
 * idle timer, and "phone locked" tracks protected-data availability (data protection kicks
 * in shortly after the passcode lock engages), observed on the main queue so the worker
 * never has to block on the main thread. There is no Even-app conflict on iOS.
 */
class IosSessionHost(private val platform: ProtocolPlatform = IosProtocolPlatform, private val threadName: String = "FaceclawBleCommunicator") : SessionHost {
    private val mainDispatcher = SessionDispatcher { action -> dispatch_async(dispatch_get_main_queue()) { action() } }

    @Volatile private var phoneLocked = false

    @Volatile private var workerDone: Latch? = null

    /** UIApplication exists only inside a UIKit app; the Kotlin test executable has no bundle type. */
    private val uiApplicationAvailable: Boolean =
        NSBundle.mainBundle.infoDictionary?.get("CFBundlePackageType") == "APPL"

    init {
        if (uiApplicationAvailable) {
            val center = NSNotificationCenter.defaultCenter
            center.addObserverForName(UIApplicationProtectedDataWillBecomeUnavailable, null, NSOperationQueue.mainQueue) { phoneLocked = true }
            center.addObserverForName(UIApplicationProtectedDataDidBecomeAvailable, null, NSOperationQueue.mainQueue) { phoneLocked = false }
            dispatch_async(dispatch_get_main_queue()) {
                phoneLocked = !UIApplication.sharedApplication.protectedDataAvailable
            }
        }
    }

    override fun postToMain(action: () -> Unit) {
        dispatch_async(dispatch_get_main_queue()) { action() }
    }

    override fun currentThreadDispatcher(): SessionDispatcher {
        if (NSThread.isMainThread) return mainDispatcher
        val queue = dispatch_queue_create("com.faceclaw.session.subscriber", null)
        return SessionDispatcher { action -> dispatch_async(queue) { action() } }
    }

    override fun isPhoneLocked(): Boolean = phoneLocked

    override fun setScreenWakeLock(on: Boolean) {
        if (!uiApplicationAvailable) return
        dispatch_async(dispatch_get_main_queue()) { UIApplication.sharedApplication.idleTimerDisabled = on }
    }

    override fun isEvenAppActive(): Boolean = false

    override fun startWorker(body: () -> Unit) {
        val latch = Latch(1, platform)
        workerDone = latch
        val thread = NSThread {
            try {
                body()
            } finally {
                latch.countDown()
            }
        }
        thread.name = threadName
        thread.start()
    }

    override fun joinWorker(timeoutMs: Long) {
        // Kotlin/Native threads cannot be interrupted; the core wakes its own sleeper before joining.
        workerDone?.await(timeoutMs)
        workerDone = null
    }

    override fun log(level: SessionLogLevel, tag: String, message: String, error: Throwable?) {
        when (level) {
            SessionLogLevel.DEBUG, SessionLogLevel.INFO -> PlatformLog.i(tag, message)
            SessionLogLevel.WARN -> PlatformLog.w(tag, if (error != null) "$message (${error.message})" else message)
            SessionLogLevel.ERROR -> PlatformLog.e(tag, message, error)
        }
    }
}
