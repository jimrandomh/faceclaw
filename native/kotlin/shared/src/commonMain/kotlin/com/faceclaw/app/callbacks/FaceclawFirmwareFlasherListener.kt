package com.faceclaw.app

/** Callbacks from FaceclawFirmwareFlasher to the TypeScript layer. */
interface FaceclawFirmwareFlasherListener {
    fun onLog(line: String?): Unit

    /**
     * Fine-grained progress for the UI bar. `lens` is "left"/"right"; component/block indices are
     * 1-based against their counts. `bytesSent` / `bytesTotal` cover the whole lens image, so a bar
     * driven by them moves evenly even though the components differ wildly in size.
     */
    fun onProgress(
        lens: String?,
        componentIndex: Int,
        componentCount: Int,
        blockIndex: Int,
        blockCount: Int,
        bytesSent: Long,
        bytesTotal: Long,
    ): Unit

    /**
     * Coarse lifecycle. `state` is one of: validating, connecting, flashing, rebooting, done,
     * error. `detail` carries the lens name or a message.
     */
    fun onState(state: String?, detail: String?): Unit

    /** Terminal callback: success or failure, with an explanatory message. */
    fun onComplete(success: Boolean, detail: String?): Unit
}
