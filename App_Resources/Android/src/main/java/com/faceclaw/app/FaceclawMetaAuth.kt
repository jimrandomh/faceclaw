// The Meta account sign-in and the band ownership exchanges a Neural Band claim needs. Ported from
// callbacked/kinesis (MIT, Copyright (c) 2026 callbacked): Sources/Kinesis/MetaAuth.swift and
// Sources/Kinesis/MetaPairClient.swift, by way of tetramo-labs/glassly (MIT): the engine's
// services/neuralBand/MetaAuth.ts and bluetooth-sdk controllers/neuralband/MetaPairClient.kt.
package com.faceclaw.app

import android.util.Base64
import com.faceclaw.app.neuralband.BandIdentityInfo
import com.faceclaw.app.neuralband.CeremonyPairData
import com.faceclaw.app.neuralband.CeremonyPairRequestData
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.UUID
import java.util.concurrent.TimeUnit
import okhttp3.FormBody
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import org.json.JSONObject

class MetaAuthError(message: String) : Exception(message)

/** The account session is expired, invalid or revoked: the caller drops it and asks for a fresh sign-in. */
class MetaSessionInvalidError(message: String) : Exception(message)

/** What step 1 of the sign-in hands the WebView: the request token stays here, the etoken opens Meta's page. */
class MetaSsoTokens(val nativeSsoToken: String, val etoken: String)

/**
 * The chain: an anonymous tokens query, a WebView sign-in on auth.meta.com whose
 * fb-viewapp://…frl_login redirect carries a token and a blob, a blob decrypt, and the
 * ar-genai exchange that yields the user session. All calls block: run them off the main thread.
 */
object MetaAuth {
    // Meta's own client identifiers, the same in every copy of Meta's apps. They name the app
    // that asks, not a person. They are not secrets, and no account or session is in them.
    private const val FRL_CLIENT = "FRL|388177446008673|083800dd7efbbd42eab18c9886d79c18"
    private const val AR_CLIENT = "AR|306760944872162|a919421a55a8ea18080ab2f10f57f1be"
    private const val TOKENS_QUERY_URL = "https://meta.graph.meta.com/webview_tokens_query"
    private const val BLOBS_DECRYPT_URL = "https://meta.graph.meta.com/webview_blobs_decrypt"
    private const val LOGIN_URL = "https://ar-genai.graph.meta.com/login"
    private const val AUTH_ENTRY_BASE =
        "https://auth.meta.com/?native_app_id=388177446008673&source_app_id=388177446008673&native_sso_etoken="

    private val random = SecureRandom()

    fun authEntryUrl(tokens: MetaSsoTokens): String =
        AUTH_ENTRY_BASE + java.net.URLEncoder.encode(tokens.etoken, "UTF-8")

    /** The redirect that ends the sign-in: a custom scheme, or the frl_login marker on https. */
    fun isLoginCallback(url: String): Boolean =
        url.lowercase().startsWith("fb-viewapp:") || url.contains("frl_login")

    /**
     * The callback's `token` and `blob` query values, percent-decoded the way JavaScript's
     * decodeURIComponent does it: a literal '+' stays '+' (the blob is base64), where
     * URLDecoder (form decoding) would turn it into a space and spoil the blob.
     */
    fun callbackQuery(url: String): Pair<String?, String?> {
        val query = url.substringAfter('?', "").substringBefore('#')
        var token: String? = null
        var blob: String? = null
        for (pair in query.split('&')) {
            val key = pair.substringBefore('=')
            val value = runCatching {
                java.net.URLDecoder.decode(pair.substringAfter('=', "").replace("+", "%2B"), "UTF-8")
            }.getOrNull() ?: continue
            if (key == "token") token = value
            if (key == "blob") blob = value
        }
        return token to blob
    }

    /** The callback must present the first 16 hex digits of the request token's SHA-256. */
    fun callbackMatches(token: String?, nativeSsoToken: String): Boolean {
        if (token == null || token.length != 16) return false
        val digest = MessageDigest.getInstance("SHA-256").digest(nativeSsoToken.toByteArray(Charsets.UTF_8))
        val expected = digest.joinToString("") { "%02x".format(it) }.substring(0, 16)
        return MessageDigest.isEqual(token.toByteArray(), expected.toByteArray())
    }

    /** Step 1: the anonymous WebView tokens query. */
    fun tokensQuery(): MetaSsoTokens {
        val lsd = makeLsd()
        val json = postMultipart(TOKENS_QUERY_URL, listOf("access_token" to FRL_CLIENT, "lsd" to lsd, "jazoest" to jazoest(lsd)))
        val nativeSsoToken = json.optString("native_sso_token")
        val etoken = json.optString("native_sso_etoken")
        if (nativeSsoToken.isEmpty() || etoken.isEmpty()) throw MetaAuthError("Meta didn't return sign-in tokens. Try again.")
        return MetaSsoTokens(nativeSsoToken, etoken)
    }

    /** Step 3: decrypt the login blob into the FRL access token. */
    fun decryptBlob(blob: String, requestToken: String): String {
        val lsd = makeLsd()
        val json = postMultipart(
            BLOBS_DECRYPT_URL,
            listOf("blob" to blob, "request_token" to requestToken, "access_token" to FRL_CLIENT, "lsd" to lsd, "jazoest" to jazoest(lsd)),
        )
        val token = json.optString("access_token")
        if (token.isEmpty()) throw MetaAuthError("Meta didn't confirm the sign-in. Try again.")
        return token
    }

    /** Step 4: exchange the FRL token for the ar user session. */
    fun login(frlAccessToken: String): MetaSession {
        val body = FormBody.Builder()
            .add("frl_access_token", frlAccessToken)
            .add("logging_session_id", randomId())
            .add("format", "json")
            .add("device_id", randomId())
            .add("generate_session_cookies", "1")
            .add("generate_analytics_claim", "1")
            .add("method", "POST")
            .build()
        val json = post(
            Request.Builder().url(LOGIN_URL).header("Accept", "application/json").header("Authorization", "OAuth $AR_CLIENT").post(body).build(),
        )
        val accessToken = json.optString("access_token")
        val userId = json.opt("user_id")?.let { if (it is Number) it.toLong().toString() else it.toString() } ?: ""
        if (accessToken.isEmpty() || userId.isEmpty()) throw MetaAuthError("Meta didn't return an account session. Try again.")
        return MetaSession(accessToken, userId)
    }

    private fun makeLsd(): String = "S0." + (0 until 6).joinToString("") { random.nextInt(10).toString() }

    private fun jazoest(lsd: String): String = "2" + lsd.sumOf { it.code }

    private fun randomId(): String = UUID.randomUUID().toString().uppercase()

    private fun postMultipart(url: String, fields: List<Pair<String, String>>): JSONObject {
        val builder = MultipartBody.Builder().setType(MultipartBody.FORM)
        for ((name, value) in fields) builder.addFormDataPart(name, value)
        val body: RequestBody = builder.build()
        return post(
            Request.Builder().url(url).header("Accept", "application/json").header("Origin", "https://auth.meta.com").post(body).build(),
        )
    }

    private fun post(request: Request): JSONObject {
        MetaHttp.client.newCall(request).execute().use { response ->
            val json = runCatching { JSONObject(response.body?.string().orEmpty()) }.getOrNull()
            if (response.code != 200 || json == null) throw MetaAuthError("Meta sign-in failed (HTTP ${response.code}). Try again.")
            val error = json.optJSONObject("error")
            if (error != null) {
                throw MetaAuthError(
                    "Meta sign-in failed (code ${error.optInt("code", -1)}, subcode ${error.optInt("error_subcode", -1)}). Try again.",
                )
            }
            return json
        }
    }
}

/**
 * The ownership HTTP exchanges against Meta's hardware graph. Form posts; receipts travel
 * verbatim and are never reformatted. Blocking: call off the main thread.
 */
class MetaPairClient(private val session: MetaSession) {
    class Pending(val signature: ByteArray, val receipt: String)
    class Final(val signature: ByteArray, val receipt: String, val devicePublicKey: ByteArray?)

    fun pairRequest(data: CeremonyPairRequestData): Pending =
        parsePending(execute("$HOST/pair_request", pairRequestFields(data.identity, data.nonce, data.appPublicKey, session)))

    fun pair(data: CeremonyPairData): Final =
        parseFinal(execute("$HOST/pair", pairFields(data.receipt, data.signature, session)))

    private fun execute(url: String, fields: List<Pair<String, String>>): JSONObject {
        val body = FormBody.Builder().also { builder -> fields.forEach { (name, value) -> builder.add(name, value) } }.build()
        val request = Request.Builder().url(url).header("Accept", "application/json").post(body).build()
        MetaHttp.client.newCall(request).execute().use { response ->
            val json = runCatching { JSONObject(response.body?.string().orEmpty()) }.getOrNull()
            val error = json?.optJSONObject("error")
            if (isSessionFailure(response.code, error)) {
                throw MetaSessionInvalidError("Your Meta session expired. Sign in again to claim the band.")
            }
            if (response.code != 200 || json == null) throw MetaAuthError("The band claim service failed (HTTP ${response.code}). Try again.")
            if (error != null) throw MetaAuthError("The band claim service rejected the request (code ${error.optInt("code", -1)}). Try again.")
            return json
        }
    }

    companion object {
        const val HOST = "https://graph.facebook-hardware.com"

        // Meta's own client identifier, the same in every copy of Meta's apps. It names the app that asks, not a person.
        const val HW_CLIENT = "HW|1312539125771114|98588f106d5d542adbf590619ca071fe"

        private fun b64(bytes: ByteArray) = Base64.encodeToString(bytes, Base64.NO_WRAP)
        private fun unb64(text: String): ByteArray? = runCatching { Base64.decode(text, Base64.DEFAULT) }.getOrNull()

        private fun additionalData(nonce: ByteArray, appPublicKey: ByteArray, secondaryCert: String) =
            "{\"device_nonce\":\"${b64(nonce)}\",\"app_pubkey\":\"${b64(appPublicKey)}\",\"secondary_cert\":\"$secondaryCert\"}"

        private fun base(session: MetaSession) = listOf(
            "access_token" to HW_CLIENT,
            "user_access_token" to session.accessToken,
            "user_token_universe" to MetaSession.UNIVERSE,
            "pair_protocol_version" to "3",
        )

        private fun pairRequestFields(identity: BandIdentityInfo, nonce: ByteArray, appPublicKey: ByteArray, session: MetaSession) =
            base(session) + listOf(
                "device_cert" to b64(identity.deviceCertificate),
                "serial_number" to identity.serial,
                "additional_data" to additionalData(nonce, appPublicKey, b64(identity.secondaryCertificate)),
            )

        private fun pairFields(receipt: String, signature: ByteArray, session: MetaSession) =
            base(session) + listOf(
                "device_pending_ownership_receipt" to receipt,
                "device_pending_ownership_receipt_signature" to b64(signature),
            )

        private fun parsePending(json: JSONObject): Pending {
            val receipt = json.optString("pending_ownership_receipt")
            val signature = unb64(json.optString("receipt_signature"))
            if (receipt.isEmpty() || signature == null) throw MetaAuthError("The band claim service didn't return a receipt. Try again.")
            return Pending(signature, receipt)
        }

        private fun parseFinal(json: JSONObject): Final {
            val receipt = json.optString("final_ownership_receipt")
            val signature = unb64(json.optString("receipt_signature"))
            if (receipt.isEmpty() || signature == null) throw MetaAuthError("The band claim service didn't return a final receipt. Try again.")
            // The live server omits device_ec_public_key here; the reference app logs and continues.
            val deviceKey = deviceKey(json) ?: runCatching { JSONObject(receipt) }.getOrNull()?.let { deviceKey(it) }
            return Final(signature, receipt, deviceKey)
        }

        private fun deviceKey(json: JSONObject): ByteArray? {
            val additional = json.optJSONObject("additional_data") ?: return null
            val encoded = additional.optString("device_ec_public_key")
            return if (encoded.isEmpty()) null else unb64(encoded)
        }

        /** An auth HTTP status, or the graph's expired-token error code. */
        private fun isSessionFailure(status: Int, error: JSONObject?) = status == 401 || status == 403 || error?.optInt("code") == 190
    }
}

private object MetaHttp {
    val client: OkHttpClient = OkHttpClient.Builder().callTimeout(30, TimeUnit.SECONDS).build()
}
