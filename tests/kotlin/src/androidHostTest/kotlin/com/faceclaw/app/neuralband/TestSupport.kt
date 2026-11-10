package com.faceclaw.app.neuralband

import java.security.KeyFactory
import java.security.interfaces.ECPrivateKey
import java.security.interfaces.ECPublicKey
import java.security.spec.ECPublicKeySpec

internal fun hex(text: String): ByteArray =
    ByteArray(text.length / 2) { text.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

/** Bytes counting up from [from] (inclusive) to [until] (exclusive), as Swift's `Data(a..<b)`. */
internal fun range(from: Int, until: Int): ByteArray = ByteArray(until - from) { (from + it).toByte() }

internal fun repeated(value: Int, count: Int): ByteArray = ByteArray(count) { value.toByte() }

internal fun Short.le(): ByteArray = byteArrayOf(toByte(), (toInt() shr 8).toByte())

internal fun Int.le16(): ByteArray = byteArrayOf(toByte(), (this shr 8).toByte())

internal fun Float.le(): ByteArray = toBits().let {
    byteArrayOf(it.toByte(), (it shr 8).toByte(), (it shr 16).toByte(), (it shr 24).toByte())
}

internal val EMPTY = ByteArray(0)

/** P-256 scalar 1, the synthetic band's public transport key: its point is the generator. */
internal object ScalarOne {
    val privateKey: ECPrivateKey = P256.privateKey(ByteArray(31) + byteArrayOf(1))
    val point: ByteArray = P256.rawPublic(
        KeyFactory.getInstance("EC").generatePublic(ECPublicKeySpec(P256.params.generator, P256.params)) as ECPublicKey,
    )
}

internal class Exchange(val events: List<BandEvent>, val requests: List<DataXFrame>)

internal inline fun <reified T : BandEvent.Payload> List<BandEvent>.has(): Boolean = any { it.payload is T }

internal inline fun <reified T : BandEvent.Payload> List<BandEvent>.payloads(): List<T> = mapNotNull { it.payload as? T }

/** The replacement for the keychain in tests. Mirrors its save semantics. */
internal class InMemoryBandIdentityStore : BandIdentityStore {
    private val keys = HashMap<String, P256.Signing.PrivateKey>()
    private val bandKeys = HashMap<String, P256.Signing.PublicKey>()

    override fun load(bandId: String): BandEnrollmentIdentity? =
        keys[bandId]?.let { BandEnrollmentIdentity(it, bandKeys[bandId]) }

    override fun save(bandId: String, privateKey: P256.Signing.PrivateKey, bandKey: P256.Signing.PublicKey?) {
        keys[bandId] = privateKey
        if (bandKey != null) bandKeys[bandId] = bandKey
    }

    override fun delete(bandId: String) {
        keys.remove(bandId)
        bandKeys.remove(bandId)
    }
}
