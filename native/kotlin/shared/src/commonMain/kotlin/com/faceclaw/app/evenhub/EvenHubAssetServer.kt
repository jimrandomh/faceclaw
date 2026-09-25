package com.faceclaw.app

import kotlin.jvm.JvmStatic

/**
 * Offline asset resolution for an unpacked EvenHub app served from a fake per-app origin.
 * Shared by the Android WebViewClient interceptor and the iOS WKURLSchemeHandler so both apply
 * the same path rules, MIME table and bridge-shim injection.
 */
object EvenHubAssetServer {
    /** A resolved request: [relativePath] is root-relative with no leading slash. */
    data class Asset(val relativePath: String, val mime: String) {
        val isHtml: Boolean
            get() = mime == "text/html"
    }

    /** A loaded response body. */
    class Response(val mime: String, val bytes: ByteArray)

    /**
     * Maps a decoded URL path to a root-relative file path, or null when it escapes the root.
     * Empty and "/" paths serve index.html. Segments are normalised lexically ("." and "..");
     * platform adapters must still canonicalise the final file to defeat symlinks.
     */
    @JvmStatic
    fun resolve(urlPath: String?): Asset? {
        val path = if (urlPath.isNullOrEmpty() || urlPath == "/") "/index.html" else urlPath
        val segments = ArrayList<String>()
        for (segment in path.split('/')) {
            when (segment) {
                "", "." -> continue
                ".." -> if (segments.isEmpty()) return null else segments.removeAt(segments.size - 1)
                else -> segments.add(segment)
            }
        }
        if (segments.isEmpty()) return null
        val relative = segments.joinToString("/")
        return Asset(relative, mimeTypeFor(segments.last()))
    }

    /** True when [canonicalFile] lies inside [canonicalRoot] (both already canonicalised, no trailing slash). */
    @JvmStatic
    fun isInsideRoot(canonicalRoot: String, canonicalFile: String): Boolean =
        canonicalFile == canonicalRoot || canonicalFile.startsWith(canonicalRoot.trimEnd('/') + "/")

    /**
     * Inserts the bridge shim right after `<head...>` when present, else before everything, so
     * window.flutter_inappwebview exists before any app script runs.
     */
    @JvmStatic
    fun injectIntoHtml(html: String, injectScript: String): String {
        val tag = "<script>$injectScript</script>"
        val headIndex = html.lowercase().indexOf("<head")
        if (headIndex >= 0) {
            val close = html.indexOf('>', headIndex)
            if (close >= 0) return html.substring(0, close + 1) + tag + html.substring(close + 1)
        }
        return tag + html
    }

    /** Loads [asset] under [rootDir] with the shim spliced into HTML; null when the file is unreadable. */
    @JvmStatic
    fun load(rootDir: String, asset: Asset, injectScript: String): Response? {
        val path = rootDir.trimEnd('/') + "/" + asset.relativePath
        if (!fileExists(path)) return null
        val bytes = try { readFileData(path) } catch (e: Exception) { return null }
        if (!asset.isHtml) return Response(asset.mime, bytes)
        return Response(asset.mime, injectIntoHtml(bytes.decodeToString(), injectScript).encodeToByteArray())
    }

    /** Extension-based MIME lookup (the union of the Android and iOS tables). */
    @JvmStatic
    fun mimeTypeFor(name: String): String {
        val lower = name.lowercase()
        val dot = lower.lastIndexOf('.')
        val ext = if (dot >= 0) lower.substring(dot + 1) else ""
        return MIME_TYPES[ext] ?: "application/octet-stream"
    }

    private val MIME_TYPES = mapOf(
        "html" to "text/html", "htm" to "text/html",
        "js" to "text/javascript", "mjs" to "text/javascript",
        "css" to "text/css",
        "json" to "application/json",
        "wasm" to "application/wasm",
        "svg" to "image/svg+xml",
        "png" to "image/png", "jpg" to "image/jpeg", "jpeg" to "image/jpeg", "gif" to "image/gif",
        "webp" to "image/webp", "ico" to "image/x-icon",
        "woff" to "font/woff", "woff2" to "font/woff2", "ttf" to "font/ttf", "otf" to "font/otf",
        "txt" to "text/plain", "map" to "text/plain",
        "xml" to "application/xml", "mp3" to "audio/mpeg", "wav" to "audio/wav", "ogg" to "audio/ogg",
        "mp4" to "video/mp4", "webm" to "video/webm",
    )
}
