package com.faceclaw.app

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.util.Log
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.BindException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.security.MessageDigest
import java.security.SecureRandom

/**
 * OAuth sign-in in the phone's browser with a loopback redirect
 * (http://127.0.0.1:<port><path>, the redirect providers such as Spotify
 * accept from native apps): Android's counterpart of the iOS
 * FaceclawWebSignIn / FaceclawLoopbackRedirect. A receiver on the loopback
 * interface answers the browser's request for the path with a short "signed
 * in" page and hands back the full redirect URL, query included; any other
 * path (a favicon) gets a 404.
 *
 * Android blocks activity starts from the background, so the TypeScript side
 * (app/native/spotify.ts) calls start(), then openBrowser() from Faceclaw's
 * activity once it is in front. The code exchange needs no foreground, so the
 * user can stay in the browser afterwards.
 */
class FaceclawWebSignIn private constructor() {
    companion object {
        private const val TAG = "FaceclawWebSignIn"
        /** Request heads beyond this are not a browser's redirect; stop reading. */
        private const val MAX_REQUEST_BYTES = 16384
        private const val CLIENT_TIMEOUT_MS = 3000
        private const val DONE_PAGE =
            "<!doctype html><html><head><meta charset=\"utf-8\">" +
                "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>Faceclaw</title></head>" +
                "<body style=\"font-family: sans-serif; text-align: center; padding: 64px 24px\">" +
                "<h2>Signed in</h2><p>You can close this page and return to Faceclaw.</p></body></html>"

        private val INSTANCE = FaceclawWebSignIn()
        private val random = SecureRandom()

        @JvmStatic fun shared(): FaceclawWebSignIn = INSTANCE

        /** byteCount random bytes, base64url without padding (PKCE verifiers, OAuth state). */
        @JvmStatic
        fun randomBase64Url(byteCount: Int): String {
            val bytes = ByteArray(byteCount.coerceIn(1, 256))
            random.nextBytes(bytes)
            return base64Url(bytes)
        }

        /** SHA-256 of the string's UTF-8 bytes, base64url without padding (a PKCE S256 challenge). */
        @JvmStatic
        fun sha256Base64Url(value: String): String =
            base64Url(MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8)))

        /** The target ("/path?query") of a GET request head; null for anything else. */
        @JvmStatic
        fun requestTarget(head: String): String? {
            val parts = head.substringBefore("\r\n").split(' ')
            return if (parts.size >= 3 && parts[0] == "GET" && parts[1].startsWith("/")) parts[1] else null
        }

        private fun base64Url(bytes: ByteArray): String =
            Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
    }

    private val mainHandler = Handler(Looper.getMainLooper())
    private val lock = Any()
    /** The receiver of the sign-in in progress; null when none is. */
    private var server: ServerSocket? = null
    private var listener: FaceclawWebSignInListener? = null

    /**
     * Listen for the redirect to http://127.0.0.1:<port><path>, ending any
     * sign-in in progress. Returns null, or why the receiver couldn't start
     * (and then the listener never hears). Otherwise the listener hears
     * exactly once, on the main thread.
     */
    fun start(port: Int, path: String, listener: FaceclawWebSignInListener): String? {
        cancel()
        if (port <= 0 || port > 65535 || !path.startsWith("/")) return "Invalid redirect address"
        val socket = ServerSocket()
        try {
            socket.reuseAddress = true
            socket.bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), port), 8)
        } catch (e: IOException) {
            try { socket.close() } catch (ignored: IOException) {}
            return if (e is BindException) "Another app is using port $port; close it and try again"
            else "Could not listen on port $port: ${e.message}"
        }
        synchronized(lock) {
            server = socket
            this.listener = listener
        }
        val thread = Thread({ acceptLoop(socket, port, path) }, "FaceclawWebSignIn")
        thread.isDaemon = true
        thread.start()
        return null
    }

    /** Open the sign-in page in the phone's browser; null, or why not. Call while Faceclaw is in front. */
    fun openBrowser(context: Context, url: String): String? {
        val uri = Uri.parse(url)
        if (uri.scheme != "https") return "Invalid sign-in address"
        val intent = Intent(Intent.ACTION_VIEW, uri)
            .addCategory(Intent.CATEGORY_BROWSABLE)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return try {
            context.startActivity(intent)
            null
        } catch (e: ActivityNotFoundException) {
            "No browser on this phone can open the sign-in page"
        } catch (e: Exception) {
            Log.w(TAG, "could not open the sign-in page", e)
            "Could not open the sign-in page: ${e.message}"
        }
    }

    /** End the sign-in in progress, if any; its listener hears "cancelled". */
    fun cancel() = fail("cancelled")

    /** End the sign-in in progress, if any, with this error. */
    fun fail(error: String) = finish(null, null, error)

    private fun acceptLoop(socket: ServerSocket, port: Int, path: String) {
        while (true) {
            // finish() closes the socket, which ends accept() with an exception.
            val client = try { socket.accept() } catch (e: IOException) { return }
            val target = try {
                serve(client, path)
            } catch (e: IOException) {
                null
            } finally {
                try { client.close() } catch (ignored: IOException) {}
            }
            if (target != null) {
                finish(socket, "http://127.0.0.1:$port$target", null)
                return
            }
        }
    }

    /** Read one request head and answer it; returns its target when it is the redirect. */
    private fun serve(client: Socket, path: String): String? {
        client.soTimeout = CLIENT_TIMEOUT_MS
        val input = client.getInputStream()
        val head = ByteArrayOutputStream()
        val buffer = ByteArray(2048)
        while (head.size() < MAX_REQUEST_BYTES) {
            val count = input.read(buffer)
            if (count <= 0) break
            head.write(buffer, 0, count)
            if (head.toString("ISO-8859-1").contains("\r\n\r\n")) break
        }
        val target = requestTarget(head.toString("UTF-8"))
        val matched = target != null && target.substringBefore('?') == path
        val body = (if (matched) DONE_PAGE else "Not found").toByteArray(Charsets.UTF_8)
        val headers = "HTTP/1.1 ${if (matched) "200 OK" else "404 Not Found"}\r\n" +
            "Content-Type: text/html; charset=utf-8\r\nContent-Length: ${body.size}\r\n" +
            "Cache-Control: no-store\r\nConnection: close\r\n\r\n"
        val output = client.getOutputStream()
        output.write(headers.toByteArray(Charsets.US_ASCII))
        output.write(body)
        output.flush()
        return if (matched) target else null
    }

    /**
     * Report the outcome once and stop listening. `socket` limits it to that
     * receiver's sign-in (a late redirect after a newer start() is dropped);
     * null ends whichever is in progress.
     */
    private fun finish(socket: ServerSocket?, url: String?, error: String?) {
        val ended = synchronized(lock) {
            val current = server
            if (current == null || (socket != null && socket !== current)) return
            val pending = listener
            server = null
            listener = null
            try { current.close() } catch (ignored: IOException) {}
            pending
        } ?: return
        mainHandler.post { ended.onFinished(url, if (url != null) null else error) }
    }
}
