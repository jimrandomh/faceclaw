@file:OptIn(kotlinx.cinterop.ExperimentalForeignApi::class)

package com.faceclaw.app

import kotlin.concurrent.Volatile

import platform.Foundation.NSData
import platform.Foundation.NSError
import platform.Foundation.NSHTTPURLResponse
import platform.Foundation.NSMutableURLRequest
import platform.Foundation.NSString
import platform.Foundation.NSURL
import platform.Foundation.NSURLRequest
import platform.Foundation.NSURLResponse
import platform.Foundation.NSURLSession
import platform.Foundation.NSURLSessionConfiguration
import platform.Foundation.NSURLSessionDataDelegateProtocol
import platform.Foundation.NSURLSessionDataTask
import platform.Foundation.NSURLSessionResponseAllow
import platform.Foundation.NSURLSessionResponseDisposition
import platform.Foundation.NSURLSessionTask
import platform.Foundation.NSUTF8StringEncoding
import platform.Foundation.create
import platform.Foundation.dataUsingEncoding
import platform.Foundation.setHTTPBody
import platform.Foundation.setHTTPMethod
import platform.Foundation.setValue
import platform.darwin.NSObject

/** Builds an NSURLRequest with the shared User-Agent unless the caller supplied one. */
internal fun buildRequest(url: NSURL, method: String, body: String?, headers: List<Pair<String, String>>): NSMutableURLRequest {
    val request = NSMutableURLRequest.requestWithURL(url)
    request.setHTTPMethod(method)
    if (body != null) request.setHTTPBody((body as NSString).dataUsingEncoding(NSUTF8StringEncoding))
    var hasUserAgent = false
    for ((name, value) in headers) {
        if (name.equals("User-Agent", ignoreCase = true)) hasUserAgent = true
        request.setValue(value, forHTTPHeaderField = name)
    }
    if (!hasUserAgent) request.setValue(HttpIdentity.getUserAgent(), forHTTPHeaderField = "User-Agent")
    return request
}

internal fun parseUrl(url: String): NSURL? {
    val target = NSURL.URLWithString(url) ?: return null
    val scheme = target.scheme?.lowercase() ?: return null
    return if (scheme == "https" || scheme == "http") target else null
}

/**
 * Streaming POST over NSURLSession for the shared [SseStream]. Redirects are refused so
 * provider credentials in the headers are never forwarded; a 3xx reaches the sink as a
 * status with an (empty) body. Delegate callbacks arrive on NSURLSession's own queue.
 */
internal object IosStreamingHttp : StreamingHttp {
    override fun post(url: String, body: String, headers: List<Pair<String, String>>, sink: ChunkSink): Cancellable {
        val target = parseUrl(url)
        if (target == null) {
            sink.onFailure("Invalid streaming URL")
            return object : Cancellable { override fun cancel() {} }
        }
        val request = buildRequest(target, "POST", body, listOf("Content-Type" to "application/json; charset=utf-8", "Accept" to "text/event-stream") + headers)
        val configuration = NSURLSessionConfiguration.ephemeralSessionConfiguration
        configuration.timeoutIntervalForRequest = 180.0
        configuration.timeoutIntervalForResource = 180.0
        val delegate = StreamingDelegate(sink)
        val session = NSURLSession.sessionWithConfiguration(configuration, delegate, delegateQueue = null)
        val task = session.dataTaskWithRequest(request)
        task.resume()
        return object : Cancellable {
            override fun cancel() {
                delegate.cancelled = true
                session.invalidateAndCancel()
            }
        }
    }

    private class StreamingDelegate(private val sink: ChunkSink) : NSObject(), NSURLSessionDataDelegateProtocol {
        @Volatile
        var cancelled = false

        override fun URLSession(
            session: NSURLSession,
            dataTask: NSURLSessionDataTask,
            didReceiveResponse: NSURLResponse,
            completionHandler: (NSURLSessionResponseDisposition) -> Unit,
        ) {
            val code = (didReceiveResponse as? NSHTTPURLResponse)?.statusCode?.toInt() ?: 0
            if (!cancelled) sink.onStatus(code)
            completionHandler(NSURLSessionResponseAllow)
        }

        override fun URLSession(session: NSURLSession, dataTask: NSURLSessionDataTask, didReceiveData: NSData) {
            if (cancelled) return
            val bytes = didReceiveData.byteArray()
            sink.onChunk(bytes, 0, bytes.size)
        }

        override fun URLSession(
            session: NSURLSession,
            task: NSURLSessionTask,
            willPerformHTTPRedirection: NSHTTPURLResponse,
            newRequest: NSURLRequest,
            completionHandler: (NSURLRequest?) -> Unit,
        ) {
            // Never forward provider credentials to a redirected endpoint.
            completionHandler(null)
        }

        override fun URLSession(session: NSURLSession, task: NSURLSessionTask, didCompleteWithError: NSError?) {
            if (cancelled) return
            if (didCompleteWithError != null) sink.onFailure(didCompleteWithError.localizedDescription)
            else sink.onComplete()
            session.finishTasksAndInvalidate()
        }
    }
}
