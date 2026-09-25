@file:OptIn(kotlinx.cinterop.ExperimentalForeignApi::class)

package com.faceclaw.app

import platform.Foundation.NSThread
import platform.darwin.dispatch_async
import platform.darwin.dispatch_get_main_queue

private fun main(action: () -> Unit) {
    dispatch_async(dispatch_get_main_queue()) { action() }
}

private fun runOnThread(name: String, body: () -> Unit) {
    val thread = NSThread { body() }
    thread.name = name
    thread.start()
}

/**
 * iOS host for the shared [DeviceInfoProbeFlow]: owns a CoreBluetooth link, runs the flow on
 * its own NSThread and delivers listener callbacks on the main queue. Same surface as
 * Android's FaceclawDeviceInfoProbe. Addresses are peripheral identifiers.
 */
class IosDeviceInfoProbe(rightAddress: String, leftAddress: String) {
    private val link = IosBleCentral()
    private val lock = IosProtocolPlatform.createLock()
    private var started = false
    private var listener: FaceclawDeviceInfoProbeListener? = null

    private val flow = DeviceInfoProbeFlow(
        link,
        rightAddress,
        leftAddress,
        object : FaceclawDeviceInfoProbeListener {
            override fun onLog(line: String?) {
                PlatformLog.i(DeviceInfoProbeFlow.TAG, line ?: "")
                post { it.onLog(line) }
            }

            override fun onState(state: String?, detail: String?) = post { it.onState(state, detail ?: "") }

            override fun onResult(leftVersion: String?, rightVersion: String?, extension: String?) =
                post { it.onResult(leftVersion, rightVersion, extension) }

            override fun onError(message: String?) = post { it.onError(message ?: "") }
        },
    )

    fun setListener(listener: FaceclawDeviceInfoProbeListener?) {
        lock.withLock { this.listener = listener }
    }

    fun start() {
        lock.withLock {
            if (started) return
            started = true
        }
        runOnThread("faceclaw-device-info") { flow.run() }
    }

    fun cancel() = flow.cancel()

    fun close() {
        cancel()
        runCatching { link.close() }
    }

    private fun post(action: (FaceclawDeviceInfoProbeListener) -> Unit) = main {
        lock.withLock { listener }?.let(action)
    }
}

/** iOS host for the shared [FlashPromptFlow] (the on-glasses Yes/No confirmation before flashing). */
class IosFlashPrompt(rightAddress: String, leftAddress: String, warningText: String, skipPrompt: Boolean) {
    private val link = IosBleCentral()
    private val lock = IosProtocolPlatform.createLock()
    private var started = false
    private var listener: FaceclawFlashPromptListener? = null

    private val flow = FlashPromptFlow(
        link,
        rightAddress,
        leftAddress,
        warningText,
        skipPrompt,
        object : FaceclawFlashPromptListener {
            override fun onLog(line: String?) {
                PlatformLog.i(FlashPromptFlow.TAG, line ?: "")
                post { it.onLog(line) }
            }

            override fun onState(state: String?, detail: String?) = post { it.onState(state, detail ?: "") }

            override fun onBattery(rightPercent: Int, leftPercent: Int) = post { it.onBattery(rightPercent, leftPercent) }

            override fun onResult(approved: Boolean) = post { it.onResult(approved) }
        },
    )

    fun setListener(listener: FaceclawFlashPromptListener?) {
        lock.withLock { this.listener = listener }
    }

    fun start() {
        lock.withLock {
            if (started) return
            started = true
        }
        runOnThread("faceclaw-flash-prompt") { flow.run() }
    }

    fun cancel() = flow.cancel()

    fun close() {
        cancel()
        runCatching { link.close() }
    }

    private fun post(action: (FaceclawFlashPromptListener) -> Unit) = main {
        lock.withLock { listener }?.let(action)
    }
}

/** iOS host for the shared [OtaFlashFlow] (custom-firmware OTA over the stock protocol). */
class IosFirmwareFlasher(rightAddress: String, leftAddress: String, firmwarePath: String) {
    private val link = IosBleCentral()
    private val lock = IosProtocolPlatform.createLock()
    private var started = false
    private var listener: FaceclawFirmwareFlasherListener? = null

    private val flow = OtaFlashFlow(
        link,
        rightAddress,
        leftAddress,
        firmwarePath,
        object : FaceclawFirmwareFlasherListener {
            override fun onLog(line: String?) {
                PlatformLog.i(OtaFlashFlow.TAG, line ?: "")
                post { it.onLog(line) }
            }

            override fun onProgress(lens: String?, componentIndex: Int, componentCount: Int, blockIndex: Int, blockCount: Int, bytesSent: Long, bytesTotal: Long) =
                post { it.onProgress(lens, componentIndex, componentCount, blockIndex, blockCount, bytesSent, bytesTotal) }

            override fun onState(state: String?, detail: String?) = post { it.onState(state, detail ?: "") }

            override fun onComplete(success: Boolean, detail: String?) = post { it.onComplete(success, detail ?: "") }
        },
    )

    fun setListener(listener: FaceclawFirmwareFlasherListener?) {
        lock.withLock { this.listener = listener }
    }

    fun start() {
        lock.withLock {
            if (started) return
            started = true
        }
        runOnThread("faceclaw-flasher") { flow.run() }
    }

    fun cancel() = flow.cancel()

    fun close() {
        cancel()
        runCatching { link.close() }
    }

    private fun post(action: (FaceclawFirmwareFlasherListener) -> Unit) = main {
        lock.withLock { listener }?.let(action)
    }
}
