package com.faceclaw.app

import android.os.Handler
import android.os.Looper
import android.util.Base64

import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.InterruptedIOException
import java.io.RandomAccessFile
import java.net.SocketTimeoutException
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

import okhttp3.Call
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response

import org.json.JSONArray

/**
 * Native HTTP owned by one hosted EvenHub app session. Responses stream into
 * unique app-private cache files, avoiding both WebView CORS and large byte[]
 * copies across the NativeScript bridge. Apps receive only opaque request IDs;
 * they never choose a filesystem path.
 *
 * Callbacks are posted to the constructing thread's Looper. No URL or header is
 * logged here or included in a failure message.
 */
class FaceclawEvenHubHttp(
    cacheDirPath: String?,
    listener: FaceclawEvenHubHttpListener?
) {
    private val cacheDir = File(
        cacheDirPath?.takeIf { it.isNotEmpty() }
            ?: throw IllegalArgumentException("cacheDirPath is required"),
        "evenhub-native-http",
    )
    private val listener = listener ?: throw IllegalArgumentException("listener is required")
    private val callbackHandler = Handler(Looper.myLooper() ?: Looper.getMainLooper())
    private val executor = Executors.newFixedThreadPool(MAX_CONCURRENT_DOWNLOADS) { runnable ->
        Thread(runnable, "FaceclawEvenHubHttp")
    }
    private val requests = HashMap<String, Entry>()
    private val lock = Object()

    @Volatile
    private var closed = false

    init {
        synchronized(lock) {
            check(cacheDir.isDirectory || cacheDir.mkdirs()) { "Could not create the native HTTP cache." }
            // A previous process cannot close its sessions. Reclaim only stale
            // response files in this dedicated directory; active readers refresh
            // their file timestamp and unfinished downloads update it as they write.
            val cutoff = System.currentTimeMillis() - RESPONSE_RETENTION_MS
            cacheDir.listFiles()?.forEach { file ->
                if (file.isFile && file.name.endsWith(RESPONSE_SUFFIX) && file.lastModified() < cutoff) {
                    file.delete()
                }
            }
        }
    }

    private class Entry(
        val id: String,
        val file: File,
        val maxBytes: Long,
        @Volatile var call: Call? = null,
        @Volatile var ready: Boolean = false,
        @Volatile var delivered: Boolean = false,
        var bodyLength: Long = -1,
        var lastTouchedAt: Long = System.currentTimeMillis(),
    )

    /**
     * Start a GET or HEAD. Invalid inputs and capacity limits throw without
     * creating state or files. At most four downloads run concurrently and a
     * session retains at most eight active/completed responses. In-flight
     * reservations plus completed bodies are capped at 64 MiB in aggregate.
     */
    fun request(
        url: String?,
        method: String?,
        headers: Array<String?>?,
        timeoutMs: Long,
        maxBytes: Long,
    ): String {
        require(!closed) { "Native HTTP session is closed." }
        require(!url.isNullOrEmpty()) { "url is required" }
        require(method == "GET" || method == "HEAD") { "method must be GET or HEAD" }
        require(timeoutMs > 0) { "timeoutMs must be positive" }
        require(maxBytes in 1..MAX_REQUEST_BYTES) { "maxBytes exceeds the 64 MiB limit" }
        val flat = SseStream.unpackHeaders(headers)
        // Build before registering anything, so malformed URLs/headers cannot leak a file.
        val requestBuilder = Request.Builder().url(url).method(method, null)
        for ((name, value) in flat) requestBuilder.addHeader(name, value)
        val request = requestBuilder.build()

        val id = UUID.randomUUID().toString()
        val file = File(cacheDir, "$id$RESPONSE_SUFFIX")
        val entry = Entry(id, file, maxBytes)
        synchronized(lock) {
            check(!closed) { "Native HTTP session is closed." }
            pruneExpiredResponsesLocked()
            check(requests.size < MAX_ACTIVE_REQUESTS) {
                "Too many active native HTTP responses; cancel completed responses before retrying."
            }
            check(requests.values.count { !it.ready } < MAX_CONCURRENT_DOWNLOADS) {
                "Too many concurrent native HTTP requests."
            }
            val reservedBytes = requests.values.sumOf { if (it.ready) it.bodyLength else it.maxBytes }
            check(reservedBytes + maxBytes <= MAX_TOTAL_RESPONSE_BYTES) {
                "Native HTTP session storage limit reached; cancel completed responses before retrying."
            }
            requests[id] = entry
        }
        try {
            executor.execute { run(entry, request, timeoutMs, maxBytes) }
        } catch (error: Exception) {
            cancel(id)
            throw error
        }
        return id
    }

    /** Read at most [maxBytes] directly at [offset]; returned data is base64 NO_WRAP. */
    fun read(requestId: String?, offset: Long, maxBytes: Int): String {
        require(offset >= 0) { "offset must be non-negative" }
        require(maxBytes in 1..MAX_CHUNK_BYTES) { "maxBytes exceeds the 1 MiB chunk limit" }
        val entry = synchronized(lock) {
            pruneExpiredResponsesLocked()
            requests[requestId]?.also {
                it.lastTouchedAt = System.currentTimeMillis()
                it.file.setLastModified(it.lastTouchedAt)
            }
        } ?: throw IllegalArgumentException("Unknown or cancelled native HTTP request.")
        check(entry.ready) { "Native HTTP response is not ready." }
        val fileLength = entry.file.length()
        if (!entry.file.isFile || fileLength != entry.bodyLength) {
            throw IOException("Native HTTP response file is unavailable.")
        }
        val count = minOf(maxBytes.toLong(), (fileLength - offset).coerceAtLeast(0)).toInt()
        val bytes = ByteArray(count)
        if (count > 0) {
            RandomAccessFile(entry.file, "r").use { input ->
                input.seek(offset)
                input.readFully(bytes)
            }
        }
        val result = JSONArray()
            .put(Base64.encodeToString(bytes, Base64.NO_WRAP))
            .put(offset + count >= fileLength)
        return result.toString()
    }

    /** Cancel and remove one request. Unknown IDs and repeated cancellation are harmless. */
    fun cancel(requestId: String?) {
        val entry = synchronized(lock) { requests.remove(requestId) } ?: return
        entry.call?.cancel()
        entry.file.delete()
    }

    /** Cancel all active calls and delete every response owned by this session. Idempotent. */
    fun close() {
        val entries: List<Entry>
        synchronized(lock) {
            if (closed) return
            closed = true
            entries = requests.values.toList()
            requests.clear()
        }
        executor.shutdownNow()
        for (entry in entries) {
            entry.call?.cancel()
            entry.file.delete()
        }
    }

    private fun run(entry: Entry, initialRequest: Request, timeoutMs: Long, maxBytes: Long) {
        var completed = false
        val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs)
        try {
            var request = initialRequest
            var redirects = 0
            while (true) {
                val remainingNanos = deadline - System.nanoTime()
                if (remainingNanos <= 0) throw SocketTimeoutException("Native HTTP request timed out.")
                val call = getClient().newCall(request)
                call.timeout().timeout(remainingNanos, TimeUnit.NANOSECONDS)
                entry.call = call
                if (!isRegistered(entry)) return
                val response = call.execute()
                val location = response.header("Location")
                if (response.code in REDIRECT_CODES && location != null) {
                    response.close()
                    if (redirects >= MAX_REDIRECTS) throw IOException("Too many redirects")
                    val target = request.url.resolve(location)
                        ?: throw IOException("Invalid redirect target")
                    if (!sameOrigin(request.url, target)) {
                        throw IOException("Cross-origin redirects are not allowed")
                    }
                    // Caller headers are retained only for this exact origin.
                    // In particular, an HTTPS-to-HTTP downgrade is not same-origin.
                    request = request.newBuilder().url(target).build()
                    redirects++
                    continue
                }
                response.use {
                    val body = response.body
                    val contentLength = body?.contentLength() ?: -1L
                    if (contentLength > maxBytes) throw IOException("Response exceeds maxBytes ($maxBytes).")
                    var total = 0L
                    FileOutputStream(entry.file).use { output ->
                        if (body != null) {
                            body.byteStream().use { input ->
                                val buffer = ByteArray(64 * 1024)
                                while (true) {
                                    val count = input.read(buffer)
                                    if (count < 0) break
                                    if (count == 0) continue
                                    total += count
                                    if (total > maxBytes) throw IOException("Response exceeds maxBytes ($maxBytes).")
                                    output.write(buffer, 0, count)
                                }
                            }
                        }
                    }
                    synchronized(lock) {
                        if (requests[entry.id] !== entry || closed) return
                        entry.bodyLength = total
                        entry.lastTouchedAt = System.currentTimeMillis()
                        entry.file.setLastModified(entry.lastTouchedAt)
                        entry.ready = true
                    }
                    completed = true
                    postResponse(entry, response)
                    return
                }
            }
        } catch (e: Exception) {
            if (isRegistered(entry)) postFailure(entry, failureMessage(e))
        } finally {
            entry.call = null
            if (!completed && !entry.delivered) {
                // Keep a failed entry until its posted callback has run. An
                // explicit cancel/close may still remove it first, which also
                // suppresses that callback as intended.
                entry.file.delete()
            }
        }
    }

    private fun isRegistered(entry: Entry): Boolean =
        synchronized(lock) { !closed && requests[entry.id] === entry }

    private fun removeAndDelete(entry: Entry) {
        synchronized(lock) { requests.remove(entry.id, entry) }
        entry.file.delete()
    }

    private fun pruneExpiredResponsesLocked() {
        val now = System.currentTimeMillis()
        val expired = requests.values.filter {
            it.ready && (now - it.lastTouchedAt > RESPONSE_RETENTION_MS
                || !it.file.isFile || it.file.length() != it.bodyLength)
        }
        for (entry in expired) {
            requests.remove(entry.id, entry)
            entry.file.delete()
        }
    }

    private fun postResponse(entry: Entry, response: Response) {
        val headers = JSONArray()
        for ((name, value) in response.headers) headers.put(JSONArray().put(name).put(value))
        callbackHandler.post {
            if (isRegistered(entry)) {
                listener.onResponse(entry.id, response.code, response.request.url.toString(), headers.toString())
            }
        }
    }

    private fun postFailure(entry: Entry, message: String) {
        callbackHandler.post {
            if (isRegistered(entry)) {
                entry.delivered = true
                removeAndDelete(entry)
                listener.onFailure(entry.id, message)
            }
        }
    }

    private fun failureMessage(error: Exception): String = when {
        error is SocketTimeoutException || error is InterruptedIOException ->
            "Native HTTP request timed out."
        // OkHttp and TLS exceptions often include the URL or peer details.
        // Return no upstream text so credentials in a URL can never leak.
        error.message?.startsWith("Response exceeds maxBytes") == true ->
            "Response exceeds the configured maxBytes limit."
        error.message == "Cross-origin redirects are not allowed" ->
            "Cross-origin redirects are not allowed."
        error.message == "Too many redirects" ->
            "Native HTTP request exceeded the redirect limit."
        error.message == "Could not create the native HTTP cache." -> error.message!!
        else -> "Native HTTP request failed."
    }

    companion object {
        const val MAX_REQUEST_BYTES = 64L * 1024L * 1024L
        const val MAX_CHUNK_BYTES = 1024 * 1024
        private const val MAX_TOTAL_RESPONSE_BYTES = 64L * 1024L * 1024L
        private const val MAX_ACTIVE_REQUESTS = 8
        private const val MAX_CONCURRENT_DOWNLOADS = 4
        private const val MAX_REDIRECTS = 10
        private const val RESPONSE_RETENTION_MS = 24L * 60L * 60L * 1000L
        private const val RESPONSE_SUFFIX = ".response"
        private val REDIRECT_CODES = setOf(301, 302, 303, 307, 308)

        private fun sameOrigin(first: okhttp3.HttpUrl, second: okhttp3.HttpUrl): Boolean =
            (first.scheme == "http" || first.scheme == "https")
                && first.scheme == second.scheme
                && first.host == second.host
                && first.port == second.port
                && second.username.isEmpty()
                && second.password.isEmpty()

        @Volatile
        private var sharedClient: OkHttpClient? = null

        private fun getClient(): OkHttpClient {
            if (sharedClient == null) {
                synchronized(FaceclawEvenHubHttp::class.java) {
                    if (sharedClient == null) {
                        // Redirects are handled above so every hop can be checked
                        // before caller-supplied headers are sent to its target.
                        sharedClient = OkHttpClient.Builder()
                            .connectTimeout(30, TimeUnit.SECONDS)
                            .readTimeout(60, TimeUnit.SECONDS)
                            .followRedirects(false)
                            .followSslRedirects(false)
                            .addInterceptor(FaceclawHttp.userAgentInterceptor())
                            .build()
                    }
                }
            }
            return sharedClient!!
        }
    }
}
