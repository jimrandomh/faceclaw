package dev.lumen.band

/** Selected entry points from Rokid Lumen's JNI bridge. Calls on a handle are serialized. */
internal object Bridge {
    val available: Boolean = try {
        System.loadLibrary("lumen_band")
        true
    } catch (_: LinkageError) {
        false
    } catch (_: SecurityException) {
        false
    }

    @JvmStatic external fun open(ownerKey: ByteArray, schemeGuess: Int, paused: Boolean, dial: String, mapping: String): Long
    @JvmStatic external fun request(handle: Long): ByteArray
    @JvmStatic external fun feed(handle: Long, bytes: ByteArray, now: Double): ByteArray
    @JvmStatic external fun tick(handle: Long, now: Double): ByteArray
    @JvmStatic external fun actions(handle: Long): String
    @JvmStatic external fun log(handle: Long): String
    @JvmStatic external fun status(handle: Long): String
    @JvmStatic external fun setPaused(handle: Long, paused: Boolean, now: Double)
    @JvmStatic external fun setMotion(handle: Long, enabled: Boolean)
    @JvmStatic external fun setMapping(handle: Long, mapping: String)
    @JvmStatic external fun setPointer(handle: Long, enabled: Boolean, tuning: String, now: Double)
    @JvmStatic external fun pointer(handle: Long, now: Double): DoubleArray
    @JvmStatic external fun setHandwriting(handle: Long, enabled: Boolean, collection: Int, model: Int, now: Double): ByteArray
    @JvmStatic external fun recoverHandwriting(handle: Long, collection: Int, model: Int, now: Double): ByteArray
    @JvmStatic external fun resetHandwritingText(handle: Long, text: String)
    @JvmStatic external fun handwritingEvents(handle: Long): String
    @JvmStatic external fun close(handle: Long)
}
