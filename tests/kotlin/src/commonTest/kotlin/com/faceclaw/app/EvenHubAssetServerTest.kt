package com.faceclaw.app

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class EvenHubAssetServerTest {
    @Test
    fun resolvesPathsWithIndexDefaultAndEscapeChecks() {
        assertEquals("index.html", EvenHubAssetServer.resolve(null)!!.relativePath)
        assertEquals("index.html", EvenHubAssetServer.resolve("")!!.relativePath)
        assertEquals("index.html", EvenHubAssetServer.resolve("/")!!.relativePath)
        assertEquals("assets/app.js", EvenHubAssetServer.resolve("/assets/app.js")!!.relativePath)
        assertEquals("assets/app.js", EvenHubAssetServer.resolve("/assets/./x/../app.js")!!.relativePath)
        assertNull(EvenHubAssetServer.resolve("/../secret"))
        assertNull(EvenHubAssetServer.resolve("/a/../../secret"))
        assertNull(EvenHubAssetServer.resolve("/.."))
        assertTrue(EvenHubAssetServer.resolve("/index.html")!!.isHtml)
        assertTrue(EvenHubAssetServer.isInsideRoot("/apps/x", "/apps/x/index.html"))
        assertTrue(EvenHubAssetServer.isInsideRoot("/apps/x/", "/apps/x/a/b"))
        assertEquals(false, EvenHubAssetServer.isInsideRoot("/apps/x", "/apps/xy/index.html"))
        assertEquals(false, EvenHubAssetServer.isInsideRoot("/apps/x", "/apps/index.html"))
    }

    @Test
    fun mimeTableCoversBothPlatformsTables() {
        assertEquals("text/html", EvenHubAssetServer.mimeTypeFor("Index.HTM"))
        assertEquals("text/javascript", EvenHubAssetServer.mimeTypeFor("bundle.mjs"))
        assertEquals("application/wasm", EvenHubAssetServer.mimeTypeFor("core.wasm"))
        assertEquals("font/woff2", EvenHubAssetServer.mimeTypeFor("a.woff2"))
        assertEquals("image/svg+xml", EvenHubAssetServer.mimeTypeFor("icon.svg"))
        assertEquals("text/plain", EvenHubAssetServer.mimeTypeFor("bundle.js.map"))
        assertEquals("application/octet-stream", EvenHubAssetServer.mimeTypeFor("blob"))
        assertEquals("application/octet-stream", EvenHubAssetServer.mimeTypeFor("weird.xyz"))
    }

    @Test
    fun injectsShimAfterHeadOrAtStart() {
        assertEquals(
            "<!doctype html><HEAD lang=\"x\"><script>S</script><title>t</title></HEAD>",
            EvenHubAssetServer.injectIntoHtml("<!doctype html><HEAD lang=\"x\"><title>t</title></HEAD>", "S"),
        )
        assertEquals("<script>S</script><body>x</body>", EvenHubAssetServer.injectIntoHtml("<body>x</body>", "S"))
        assertEquals("<script>S</script><head", EvenHubAssetServer.injectIntoHtml("<head", "S"), "unterminated head tag")
    }
}
