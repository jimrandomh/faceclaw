package com.faceclaw.app

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaPlayer
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log

import org.json.JSONObject

import java.io.IOException
import java.nio.ByteBuffer
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock
import java.util.zip.CRC32
import kotlin.concurrent.withLock

/**
 * Plays a video file onto the glasses. A background thread decodes the video track
 * (MediaExtractor + MediaCodec), scales each due frame's luma to gray (VideoFrameScaler) and
 * submits it straight into a rect of a window's compositor surface, through the same
 * submitSurfaceFrame entry point app workers use, so no JS runs per frame. When wanted, the
 * audio track plays through a MediaPlayer on the phone's default media route, and the video
 * clock follows its position.
 *
 * The TS side (app/native/video-player.ts) owns the window: it paints the rest of the surface
 * and repaints the video rect from [copyLastFrame] whenever it renders. Frames are submitted
 * only while playing, and [pause] returns only once no further frame can be submitted, so a
 * repaint right after it (the paused overlay) is never overwritten.
 *
 * Control methods are for the main thread; listener callbacks are posted to it.
 */
class FaceclawVideoPlayer(context: Context) {
    interface Listener {
        /**
         * "playing", "paused" or "ended", with the media position. Also sent as "paused" when a
         * seek made while paused has decoded its new frame (see [copyLastFrame]).
         */
        fun onStateChanged(state: String?, positionMs: Long)

        /** Playback stopped on an error (unreadable file, no decoder, ...). */
        fun onError(message: String?)
    }

    companion object {
        private const val TAG = "FaceclawVideo"
        private const val CODEC_TIMEOUT_US = 10_000L
        /** Longest single sleep while waiting for a frame to come due, so commands stay responsive. */
        private const val MAX_WAIT_US = 20_000L
        /** A frame this far behind the clock is dropped undrawn... */
        private const val LATE_DROP_US = 50_000L
        /** ...unless nothing has been drawn for this long, so a slow phone still shows progress. */
        private const val MAX_DROP_GAP_NANOS = 250_000_000L
        /**
         * Decoded frames closer together than this are thinned: past ~30fps the glasses link
         * could never show them, and each one still costs a scale and a composite.
         */
        private const val MIN_FRAME_INTERVAL_US = 30_000L
        /** Audio position is ignored this long after the clock starts (output startup latency). */
        private const val AUDIO_SETTLE_NANOS = 500_000_000L
        /** Clock drift from the audio position that makes the video clock jump to it. */
        private const val AUDIO_RESYNC_US = 60_000L
        /** How often the audio position is read (a binder call into the media server). */
        private const val AUDIO_CHECK_INTERVAL_NANOS = 250_000_000L
        /** A seek never lands closer than this to the end, so it always shows a frame. */
        private const val SEEK_END_MARGIN_US = 500_000L

        private val AUDIO_ATTRIBUTES: AudioAttributes = AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_MOVIE)
                .build()

        private fun MediaFormat.intOr(key: String, fallback: Int): Int =
                if (containsKey(key)) getInteger(key) else fallback

        private fun MediaFormat.longOr(key: String, fallback: Long): Long =
                if (containsKey(key)) getLong(key) else fallback

        private fun findTrack(extractor: MediaExtractor, mimePrefix: String): Int {
            for (i in 0 until extractor.trackCount) {
                val mime = extractor.getTrackFormat(i).getString(MediaFormat.KEY_MIME) ?: continue
                if (mime.startsWith(mimePrefix)) return i
            }
            return -1
        }

        /**
         * Describe a video file for the settings panel, as JSON: {width, height} in display
         * orientation (rotation applied), rotation, durationMs, hasAudio, mime; or {error}.
         */
        @JvmStatic
        fun probe(path: String?): String {
            val result = JSONObject()
            val extractor = MediaExtractor()
            try {
                extractor.setDataSource(path ?: throw IOException("no path"))
                val videoTrack = findTrack(extractor, "video/")
                if (videoTrack < 0) {
                    result.put("error", "No video track")
                    return result.toString()
                }
                var durationUs = 0L
                for (i in 0 until extractor.trackCount) {
                    durationUs = Math.max(durationUs, extractor.getTrackFormat(i).longOr(MediaFormat.KEY_DURATION, 0L))
                }
                val format = extractor.getTrackFormat(videoTrack)
                val rotation = VideoFrameScaler.normalizeRotation(format.intOr(MediaFormat.KEY_ROTATION, 0))
                val codedWidth = format.intOr(MediaFormat.KEY_WIDTH, 0)
                val codedHeight = format.intOr(MediaFormat.KEY_HEIGHT, 0)
                val swap = rotation == 90 || rotation == 270
                result.put("width", if (swap) codedHeight else codedWidth)
                result.put("height", if (swap) codedWidth else codedHeight)
                result.put("rotation", rotation)
                result.put("durationMs", durationUs / 1000)
                result.put("hasAudio", findTrack(extractor, "audio/") >= 0)
                result.put("mime", format.getString(MediaFormat.KEY_MIME) ?: "")
            } catch (e: Exception) {
                Log.w(TAG, "probe failed for $path", e)
                result.put("error", e.message ?: e.toString())
            } finally {
                extractor.release()
            }
            return result.toString()
        }
    }

    /** What one start() call asked for; fixed for that playback's lifetime. */
    private class Params(
            val path: String,
            val surfaceId: String,
            val x: Int,
            val y: Int,
            val width: Int,
            val height: Int,
            val monochrome: Boolean,
            val gamma: Float,
            val audio: Boolean,
    )

    private enum class Wait { DUE, INTERRUPTED, STOP }

    private val appContext: Context = context.applicationContext
    private val mainHandler = Handler(Looper.getMainLooper())
    private val audioManager = appContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    @Volatile private var listener: Listener? = null

    private val lock = ReentrantLock()
    private val wake = lock.newCondition()

    // Everything below is guarded by lock.
    /** Bumped by every start/stop; a playback thread whose generation is stale exits. */
    private var generation = 0
    private var params: Params? = null
    /** The user's intent: playing or paused. */
    private var playing = false
    private var ended = false
    /** A seek (or the initial start) is decoding toward its target; the clock waits for its frame. */
    private var seeking = false
    private var pendingSeekUs = -1L
    private var durationUs = 0L
    private var clockRunning = false
    /** Media time while the clock is stopped. */
    private var heldUs = 0L
    private var clockBaseUs = 0L
    private var clockBaseNanos = 0L
    private var clockStartedNanos = 0L
    private var lastAudioCheckNanos = 0L
    private var audio: MediaPlayer? = null
    private var hasAudioFocus = false
    private var focusRequest: AudioFocusRequest? = null
    /** The most recently decoded frame (params.width x params.height), shown or previewed. */
    private var lastFrame: ByteArray? = null
    /** Checksum of the frame last submitted, so an unchanged frame is not recomposited; -1 = none. */
    private var lastSubmittedChecksum = -1L
    private var submitFailures = 0

    private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
        when (change) {
            AudioManager.AUDIOFOCUS_LOSS, AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> {
                if (change == AudioManager.AUDIOFOCUS_LOSS) lock.withLock { hasAudioFocus = false }
                // Another app (a call, a music player) took the audio: pause like any player would.
                if (isPlaying()) {
                    pause()
                    notifyState(generationNow(), "paused", getPositionMs())
                }
            }
        }
    }

    fun setListener(listener: Listener?) {
        this.listener = listener
    }

    /**
     * Start playing [path] from [startMs] into the (rectX, rectY, width, height) rect of
     * compositor surface [surfaceId], replacing any current playback. Decoding and audio setup
     * happen on the playback thread; failures arrive as [Listener.onError].
     */
    fun start(
            path: String,
            surfaceId: String,
            rectX: Int,
            rectY: Int,
            width: Int,
            height: Int,
            monochrome: Boolean,
            gamma: Float,
            withAudio: Boolean,
            startMs: Long,
    ) {
        require(width > 0 && height > 0) { "bad video rect ${width}x$height" }
        val p = Params(path, surfaceId, rectX, rectY, width, height, monochrome, gamma, withAudio)
        val gen = lock.withLock {
            endPlaybackLocked()
            params = p
            playing = true
            ended = false
            seeking = true
            pendingSeekUs = Math.max(0L, startMs) * 1000
            heldUs = pendingSeekUs
            // The old frame may not match the new settings (size, monochrome).
            lastFrame = null
            lastSubmittedChecksum = -1
            submitFailures = 0
            generation
        }
        val thread = Thread({ Playback(gen, p).run() }, "FaceclawVideo")
        thread.priority = Thread.NORM_PRIORITY + 1
        thread.start()
    }

    /** Pause; once this returns no further frame is submitted until [resume]. */
    fun pause() {
        lock.withLock {
            if (!playing) return
            playing = false
            holdClockLocked(clockUsLocked())
            wake.signalAll()
        }
    }

    fun resume() {
        lock.withLock {
            if (playing || ended || params == null) return
            playing = true
            // A fresh frame must go out even if it matches the last one: the TS side painted over
            // the surface while paused.
            lastSubmittedChecksum = -1
            if (!seeking) startClockLocked()
            wake.signalAll()
        }
    }

    /** Seek to [positionMs]; while paused, the new frame is decoded and announced as "paused". */
    fun seekTo(positionMs: Long) {
        lock.withLock {
            if (params == null || ended) return
            var targetUs = Math.max(0L, positionMs) * 1000
            if (durationUs > 0) targetUs = Math.min(targetUs, Math.max(0L, durationUs - SEEK_END_MARGIN_US))
            pendingSeekUs = targetUs
            seeking = true
            holdClockLocked(targetUs)
            lastSubmittedChecksum = -1
            wake.signalAll()
        }
    }

    fun getPositionMs(): Long = lock.withLock { clockUsLocked() / 1000 }

    fun getDurationMs(): Long = lock.withLock { durationUs / 1000 }

    fun isPlaying(): Boolean = lock.withLock { playing && !ended && params != null }

    /**
     * Copy the most recent frame into [out], which must hold exactly the video rect's
     * width*height bytes (row-major 8bpp gray). False when there is no frame of that size yet.
     */
    fun copyLastFrame(out: ByteBuffer): Boolean {
        lock.withLock {
            val frame = lastFrame ?: return false
            if (out.capacity() != frame.size) return false
            out.clear()
            out.put(frame)
            out.clear()
            return true
        }
    }

    /** End playback and free the decoder and audio; the last frame stays readable. */
    fun stop() {
        lock.withLock { endPlaybackLocked() }
    }

    /** stop(), and drop the listener and frame. */
    fun release() {
        lock.withLock {
            endPlaybackLocked()
            lastFrame = null
        }
        listener = null
    }

    private fun generationNow(): Int = lock.withLock { generation }

    private fun endPlaybackLocked() {
        generation++
        params = null
        playing = false
        seeking = false
        pendingSeekUs = -1
        // Keep the position readable (an error's caller resumes from it).
        heldUs = clockUsLocked()
        clockRunning = false
        releaseAudioLocked()
        wake.signalAll()
    }

    // ---- clock (all under lock) ----

    private fun clockUsLocked(): Long =
            if (!clockRunning) heldUs else clockBaseUs + (System.nanoTime() - clockBaseNanos) / 1000

    private fun startClockLocked() {
        if (clockRunning) return
        clockRunning = true
        clockBaseUs = heldUs
        clockBaseNanos = System.nanoTime()
        clockStartedNanos = clockBaseNanos
        val player = audio ?: return
        requestAudioFocusLocked()
        try {
            player.start()
        } catch (e: IllegalStateException) {
            Log.w(TAG, "audio start failed", e)
        }
    }

    private fun holdClockLocked(atUs: Long) {
        heldUs = atUs
        if (!clockRunning) return
        clockRunning = false
        try {
            audio?.let { if (it.isPlaying) it.pause() }
        } catch (e: IllegalStateException) {
            Log.w(TAG, "audio pause failed", e)
        }
    }

    /**
     * Keep the video clock on the audio position: output latency and seeks make the two drift,
     * and a picture ahead of or behind its sound is the one sync error people notice.
     */
    private fun followAudioLocked() {
        val player = audio ?: return
        val now = System.nanoTime()
        if (!clockRunning || now - clockStartedNanos < AUDIO_SETTLE_NANOS) return
        if (now - lastAudioCheckNanos < AUDIO_CHECK_INTERVAL_NANOS) return
        lastAudioCheckNanos = now
        val audioUs = try {
            if (!player.isPlaying) return // finished (audio shorter than video) or not started
            player.currentPosition * 1000L
        } catch (e: IllegalStateException) {
            return
        }
        if (Math.abs(audioUs - clockUsLocked()) > AUDIO_RESYNC_US) {
            clockBaseUs = audioUs
            clockBaseNanos = System.nanoTime()
        }
    }

    private fun seekAudioLocked(targetUs: Long) {
        val player = audio ?: return
        try {
            if (Build.VERSION.SDK_INT >= 26) {
                player.seekTo(targetUs / 1000, MediaPlayer.SEEK_CLOSEST)
            } else {
                player.seekTo((targetUs / 1000).toInt())
            }
        } catch (e: IllegalStateException) {
            Log.w(TAG, "audio seek failed", e)
        }
    }

    private fun requestAudioFocusLocked() {
        if (hasAudioFocus) return
        val result = if (Build.VERSION.SDK_INT >= 26) {
            val request = focusRequest ?: AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                    .setAudioAttributes(AUDIO_ATTRIBUTES)
                    .setOnAudioFocusChangeListener(focusListener, mainHandler)
                    .build()
                    .also { focusRequest = it }
            audioManager.requestAudioFocus(request)
        } else {
            @Suppress("DEPRECATION")
            audioManager.requestAudioFocus(focusListener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN)
        }
        // Play regardless: the sound was asked for, and a refusal is transient (a call ending).
        hasAudioFocus = result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
    }

    private fun releaseAudioLocked() {
        val player = audio ?: return
        audio = null
        try {
            player.release()
        } catch (e: Exception) {
            Log.w(TAG, "audio release failed", e)
        }
        if (hasAudioFocus) {
            hasAudioFocus = false
            if (Build.VERSION.SDK_INT >= 26) {
                focusRequest?.let { audioManager.abandonAudioFocusRequest(it) }
            } else {
                @Suppress("DEPRECATION")
                audioManager.abandonAudioFocus(focusListener)
            }
        }
    }

    // ---- notifications ----

    private fun notifyState(gen: Int, state: String, positionMs: Long) {
        mainHandler.post {
            if (lock.withLock { gen == generation }) listener?.onStateChanged(state, positionMs)
        }
    }

    private fun notifyError(gen: Int, message: String) {
        mainHandler.post {
            if (lock.withLock { gen == generation }) listener?.onError(message)
        }
    }

    // ---- frame output (under lock) ----

    private fun submitLocked(p: Params, pixels: ByteArray, checksum: Long) {
        val buffer = ByteBuffer.wrap(pixels)
        // Frame id 0: per-frame FrameTimings entries at video rate would crowd every real
        // input/render frame out of the timing export.
        val fingerprint = "video:$generation:" + java.lang.Long.toHexString(checksum)
        try {
            val communicator = FaceclawBleCommunicator.getActive()
            if (communicator != null) {
                communicator.submitSurfaceFrame(buffer, p.surfaceId, p.x, p.y, p.width, p.height, fingerprint, 0, 0, null)
            } else {
                FaceclawPreviewCompositor.getActive()?.submitSurfaceFrame(
                        buffer, p.surfaceId, p.x, p.y, p.width, p.height, fingerprint, 0, 0, null)
            }
            submitFailures = 0
        } catch (e: RuntimeException) {
            // The window's surface went away or shrank under us (closed, relaid out): drop the frame.
            if (submitFailures++ == 0) Log.w(TAG, "video frame submit failed: ${e.message}")
        }
    }

    /**
     * One start() call's decode thread. Owns the extractor and decoder; everything shared with
     * the control methods goes through the player's lock.
     */
    private inner class Playback(private val gen: Int, private val p: Params) {
        private var extractor: MediaExtractor? = null
        private var codec: MediaCodec? = null
        private val info = MediaCodec.BufferInfo()
        private var inputDone = false
        private var outputDone = false
        private var trackEndUs = 0L
        /** Frames before this are decoded only on the way to a seek target. */
        private var skipUntilUs = 0L
        private var lastDrawnPtsUs = Long.MIN_VALUE / 2
        private var lastDrawnNanos = 0L
        private var rotation = 0
        private var lut = ByteArray(256)
        private var scaler: VideoFrameScaler? = null
        private var luma = ByteArray(0)
        /** The frame being built; swapped with lastFrame when shown. */
        private var frame = ByteArray(p.width * p.height)
        private val crc = CRC32()

        fun run() {
            try {
                open()
                loop()
            } catch (t: Throwable) {
                Log.w(TAG, "playback failed for ${p.path}", t)
                val current = lock.withLock {
                    val current = gen == generation
                    if (current) endPlaybackLocked()
                    current
                }
                // endPlaybackLocked bumped the generation; report under the new one.
                if (current) notifyError(generationNow(), t.message ?: t.toString())
            } finally {
                try {
                    codec?.stop()
                } catch (ignored: Throwable) {
                }
                codec?.release()
                extractor?.release()
            }
        }

        private fun current(): Boolean = lock.withLock { gen == generation }

        private fun open() {
            val ex = MediaExtractor()
            extractor = ex
            ex.setDataSource(p.path)
            val track = findTrack(ex, "video/")
            if (track < 0) throw IOException("No video track")
            ex.selectTrack(track)
            val format = ex.getTrackFormat(track)
            rotation = VideoFrameScaler.normalizeRotation(format.intOr(MediaFormat.KEY_ROTATION, 0))
            trackEndUs = format.longOr(MediaFormat.KEY_DURATION, 0L)
            // Most video is limited ("TV") range; only an explicit full-range tag says otherwise.
            val limited = format.intOr(MediaFormat.KEY_COLOR_RANGE, MediaFormat.COLOR_RANGE_LIMITED) !=
                    MediaFormat.COLOR_RANGE_FULL
            lut = VideoFrameScaler.toneLut(limited, p.gamma, p.monochrome)
            val mime = format.getString(MediaFormat.KEY_MIME) ?: throw IOException("Unknown video format")
            format.setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatYUV420Flexible)
            val decoder = try {
                MediaCodec.createDecoderByType(mime)
            } catch (e: Exception) {
                throw IOException("No decoder for $mime")
            }
            codec = decoder
            decoder.configure(format, null, null, 0)
            decoder.start()
            val player = if (p.audio && findTrack(ex, "audio/") >= 0) openAudio() else null
            lock.withLock {
                if (gen != generation) {
                    player?.release()
                    return
                }
                durationUs = trackEndUs
                // Positioned by the start seek, which is the first command loop() handles.
                audio = player
            }
        }

        /** A prepared MediaPlayer for the file's audio, or null (played silent) if it won't open. */
        private fun openAudio(): MediaPlayer? {
            val player = MediaPlayer()
            return try {
                player.setAudioAttributes(AUDIO_ATTRIBUTES)
                player.setDataSource(p.path)
                player.prepare()
                player
            } catch (e: Exception) {
                Log.w(TAG, "audio unavailable for ${p.path}; playing silent", e)
                player.release()
                null
            }
        }

        private fun loop() {
            while (true) {
                // Commands: stop, seek, or wait out a pause.
                var seekUs = -1L
                lock.withLock {
                    while (true) {
                        if (gen != generation) return
                        if (pendingSeekUs >= 0) {
                            seekUs = pendingSeekUs
                            pendingSeekUs = -1
                            break
                        }
                        if (playing || seeking) break
                        wake.await()
                    }
                }
                if (seekUs >= 0) {
                    seek(seekUs)
                    continue
                }
                if (outputDone) {
                    if (awaitEnd()) return
                    continue
                }
                feedInput()
                val index = codec!!.dequeueOutputBuffer(info, CODEC_TIMEOUT_US)
                if (index < 0) continue // try again later / format or buffers changed
                val endOfStream = (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0
                if (info.size > 0) {
                    handleFrame(index, info.presentationTimeUs)
                } else {
                    codec!!.releaseOutputBuffer(index, false)
                }
                if (endOfStream) outputDone = true
            }
        }

        private fun seek(targetUs: Long) {
            lock.withLock {
                if (gen != generation) return
                seekAudioLocked(targetUs)
            }
            extractor!!.seekTo(targetUs, MediaExtractor.SEEK_TO_PREVIOUS_SYNC)
            codec!!.flush()
            inputDone = false
            outputDone = false
            skipUntilUs = targetUs
            lastDrawnPtsUs = Long.MIN_VALUE / 2
        }

        private fun feedInput() {
            if (inputDone) return
            val decoder = codec!!
            val ex = extractor!!
            while (true) {
                val index = decoder.dequeueInputBuffer(0)
                if (index < 0) return
                val buffer = decoder.getInputBuffer(index) ?: return
                val size = ex.readSampleData(buffer, 0)
                if (size < 0) {
                    decoder.queueInputBuffer(index, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                    inputDone = true
                    return
                }
                decoder.queueInputBuffer(index, 0, size, ex.sampleTime, 0)
                ex.advance()
            }
        }

        /** Decide a decoded frame's fate (skip, preview, drop, draw); always releases it. */
        private fun handleFrame(index: Int, ptsUs: Long) {
            try {
                if (ptsUs < skipUntilUs) return
                val landingSeek = lock.withLock { seeking }
                if (landingSeek) {
                    landSeek(index, ptsUs)
                    return
                }
                if (ptsUs - lastDrawnPtsUs < MIN_FRAME_INTERVAL_US) return
                if (waitUntilDue(ptsUs) != Wait.DUE) return
                val lateUs = lock.withLock { clockUsLocked() } - ptsUs
                if (lateUs > LATE_DROP_US && System.nanoTime() - lastDrawnNanos < MAX_DROP_GAP_NANOS) return
                val checksum = convert(index)
                present(ptsUs, checksum)
            } finally {
                codec!!.releaseOutputBuffer(index, false)
            }
        }

        /**
         * The first frame at or past a seek target (or the start position): drawn and the clock
         * started when playing, kept as the paused preview otherwise.
         */
        private fun landSeek(index: Int, ptsUs: Long) {
            val checksum = convert(index)
            var previewed = false
            lock.withLock {
                if (gen != generation || pendingSeekUs >= 0) return
                seeking = false
                heldUs = ptsUs
                swapInFrameLocked()
                if (playing) {
                    submitLocked(p, lastFrame!!, checksum)
                    lastSubmittedChecksum = checksum
                    startClockLocked()
                } else {
                    previewed = true
                }
            }
            lastDrawnPtsUs = ptsUs
            lastDrawnNanos = System.nanoTime()
            notifyState(gen, if (previewed) "paused" else "playing", ptsUs / 1000)
        }

        /** Show a due frame, unless a pause or seek got in first. */
        private fun present(ptsUs: Long, checksum: Long) {
            lock.withLock {
                if (gen != generation || !playing || pendingSeekUs >= 0) return
                swapInFrameLocked()
                if (checksum != lastSubmittedChecksum) {
                    submitLocked(p, lastFrame!!, checksum)
                    lastSubmittedChecksum = checksum
                }
            }
            lastDrawnPtsUs = ptsUs
            lastDrawnNanos = System.nanoTime()
        }

        private fun swapInFrameLocked() {
            val shown = frame
            val previous = lastFrame
            frame = if (previous != null && previous.size == shown.size) previous else ByteArray(shown.size)
            lastFrame = shown
        }

        /** Block until the clock reaches [ptsUs]; paused time doesn't count. */
        private fun waitUntilDue(ptsUs: Long): Wait {
            lock.withLock {
                while (true) {
                    if (gen != generation) return Wait.STOP
                    if (pendingSeekUs >= 0) return Wait.INTERRUPTED
                    if (!playing) {
                        wake.await()
                        continue
                    }
                    followAudioLocked()
                    val now = clockUsLocked()
                    if (now >= ptsUs) return Wait.DUE
                    wake.await(Math.min(ptsUs - now, MAX_WAIT_US), TimeUnit.MICROSECONDS)
                }
            }
        }

        /**
         * The decoder is drained: hold the last frame until the clock reaches the end, then
         * report "ended". False when a seek interrupted the wait (playback continues).
         */
        private fun awaitEnd(): Boolean {
            val endUs = Math.max(trackEndUs, lastDrawnPtsUs)
            val landing = lock.withLock { seeking }
            if (!landing && waitUntilDue(endUs) != Wait.DUE) return !current()
            lock.withLock {
                if (gen != generation) return true
                if (pendingSeekUs >= 0) return false
                playing = false
                seeking = false
                ended = true
                holdClockLocked(endUs)
                releaseAudioLocked()
            }
            notifyState(gen, "ended", endUs / 1000)
            return true
        }

        /** Scale the output buffer's frame into [frame]; returns its checksum. */
        private fun convert(index: Int): Long {
            val decoder = codec!!
            val image = try {
                decoder.getOutputImage(index)
            } catch (e: Exception) {
                null
            }
            if (image != null) {
                try {
                    val plane = image.planes[0]
                    val crop = image.cropRect
                    val offset = copyLuma(plane.buffer) + crop.top * plane.rowStride + crop.left * plane.pixelStride
                    scaleInto(crop.width(), crop.height(), offset, plane.rowStride, plane.pixelStride)
                } finally {
                    image.close()
                }
            } else {
                // No Image access: every YUV420 layout starts with the Y plane at the buffer start.
                val buffer = decoder.getOutputBuffer(index) ?: throw IOException("Decoder returned no frame")
                buffer.position(info.offset)
                buffer.limit(info.offset + info.size)
                val format = decoder.outputFormat
                val width = format.getInteger(MediaFormat.KEY_WIDTH)
                val stride = format.intOr(MediaFormat.KEY_STRIDE, width)
                val left = format.intOr("crop-left", 0)
                val top = format.intOr("crop-top", 0)
                val right = format.intOr("crop-right", width - 1)
                val bottom = format.intOr("crop-bottom", format.getInteger(MediaFormat.KEY_HEIGHT) - 1)
                copyLuma(buffer)
                scaleInto(right - left + 1, bottom - top + 1, top * stride + left, stride, 1)
            }
            crc.reset()
            crc.update(frame, 0, frame.size)
            return crc.value
        }

        /** Bulk-copy the plane (one memcpy; per-byte reads from a direct buffer are slow). Returns 0. */
        private fun copyLuma(buffer: ByteBuffer): Int {
            val bytes = buffer.remaining()
            if (luma.size < bytes) luma = ByteArray(bytes)
            buffer.get(luma, 0, bytes)
            return 0
        }

        private fun scaleInto(width: Int, height: Int, offset: Int, rowStride: Int, pixelStride: Int) {
            var s = scaler
            if (s == null || s.sourceWidth != width || s.sourceHeight != height) {
                s = VideoFrameScaler(width, height, rotation, p.width, p.height)
                scaler = s
            }
            s.scale(luma, offset, rowStride, pixelStride, lut, frame)
        }
    }
}
