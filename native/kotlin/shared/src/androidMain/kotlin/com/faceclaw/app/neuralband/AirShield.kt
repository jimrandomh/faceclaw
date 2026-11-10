// Ported from callbacked/kinesis (MIT, Copyright (c) 2026 callbacked): Sources/KinesisCore/AirShield.swift,
// by way of tetramo-labs/glassly (MIT).
package com.faceclaw.app.neuralband

import java.math.BigInteger
import java.security.AlgorithmParameters
import java.security.GeneralSecurityException
import java.security.KeyFactory
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.Signature
import java.security.interfaces.ECPrivateKey
import java.security.interfaces.ECPublicKey
import java.security.spec.ECFieldFp
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPrivateKeySpec
import java.security.spec.ECPublicKeySpec
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

class BandProtocolError(override val message: String) : Exception(message)

/**
 * How many encryption-scheme guesses a newer band (scheme 26) may need. A session that fails
 * before its first authenticated packet with [BandSession.schemeGuessInUse] set is retried with
 * the next guess, up to this many times; the working guess is worth remembering per band.
 */
val BAND_SCHEME_GUESS_COUNT: Int get() = AirShieldVariant.SCHEME_26_GUESSES.size

internal data class AirShieldVariant(val hashedSecret: Boolean, val macKey: MacKey, val macPrefix: Boolean, val announce: ULong) {
    enum class MacKey { ENCRYPTION, DERIVED, DERIVED_HASHED }

    val padsAligned: Boolean get() = announce != 3uL

    companion object {
        val SCHEME_3 = AirShieldVariant(hashedSecret = true, macKey = MacKey.ENCRYPTION, macPrefix = false, announce = 3uL)
        val SCHEME_31 = AirShieldVariant(hashedSecret = false, macKey = MacKey.DERIVED, macPrefix = true, announce = 31uL)

        private fun guess(hashedSecret: Boolean, macKey: MacKey, macPrefix: Boolean) =
            AirShieldVariant(hashedSecret, macKey, macPrefix, announce = 26uL)

        val SCHEME_26_GUESSES = listOf(
            guess(false, MacKey.ENCRYPTION, true),
            guess(false, MacKey.DERIVED, true),
            guess(true, MacKey.ENCRYPTION, false),
            guess(false, MacKey.ENCRYPTION, false),
            guess(true, MacKey.ENCRYPTION, true),
            guess(false, MacKey.DERIVED, false),
            guess(true, MacKey.DERIVED_HASHED, false),
            guess(true, MacKey.DERIVED_HASHED, true),
        )
    }
}

internal class AirShieldKeys(
    val encryption: ByteArray,
    val mac: ByteArray,
    val macPrefix: ByteArray = ByteArray(0),
    val padAligned: Boolean = false,
) {
    constructor(secret: ByteArray, challenge: ByteArray, seed: ByteArray) : this(AirShieldVariant.SCHEME_3, secret, challenge, seed)

    constructor(variant: AirShieldVariant, secret: ByteArray, challenge: ByteArray, seed: ByteArray) : this(
        derive(variant, secret, challenge, seed),
        deriveMac(variant, secret, challenge, seed),
        if (variant.macPrefix) byteArrayOf(2, 2, 0, 0) else ByteArray(0),
        variant.padsAligned,
    )

    private companion object {
        fun check(secret: ByteArray, challenge: ByteArray, seed: ByteArray) {
            if (secret.size != 32 || challenge.size != 16 || seed.size != 32) {
                throw BandProtocolError("Invalid AirShield key material")
            }
        }

        fun hkdf(ikm: ByteArray, salt: ByteArray) = hkdfSha256(ikm, salt, info = "AirShield".toByteArray(), length = 32)

        fun derive(variant: AirShieldVariant, secret: ByteArray, challenge: ByteArray, seed: ByteArray): ByteArray {
            check(secret, challenge, seed)
            val hashed = sha256(secret)
            return if (variant.hashedSecret) {
                hkdf(hashed, sha256(hashed + challenge + seed))
            } else {
                hkdf(secret, sha256(challenge + seed))
            }
        }

        fun deriveMac(variant: AirShieldVariant, secret: ByteArray, challenge: ByteArray, seed: ByteArray): ByteArray {
            check(secret, challenge, seed)
            val hashed = sha256(secret)
            val label = "hmac_derive".toByteArray()
            return when (variant.macKey) {
                AirShieldVariant.MacKey.ENCRYPTION -> derive(variant, secret, challenge, seed)
                AirShieldVariant.MacKey.DERIVED -> hkdf(secret, sha256(seed + challenge + label))
                AirShieldVariant.MacKey.DERIVED_HASHED -> hkdf(hashed, sha256(seed + challenge + label + hashed))
            }
        }
    }
}

private fun crypt(data: ByteArray, key: ByteArray, iv: ByteArray, mode: Int): ByteArray {
    if (key.size != 32 || iv.size != 16 || data.isEmpty() || data.size % 16 != 0) {
        throw BandProtocolError("Invalid AES block shape")
    }
    return try {
        val cipher = Cipher.getInstance("AES/CBC/NoPadding")
        cipher.init(mode, SecretKeySpec(key, "AES"), IvParameterSpec(iv))
        cipher.doFinal(data)
    } catch (e: GeneralSecurityException) {
        throw BandProtocolError("AES operation failed: ${e.message}")
    }
}

internal class AirShieldCipher(val keys: AirShieldKeys, iv: ByteArray, counter: UInt) {
    var iv: ByteArray = iv
        private set
    var counter: UInt = counter
        private set

    val padsAligned: Boolean get() = keys.padAligned

    private fun tag(body: ByteArray): ByteArray = hmacSha256(keys.mac, keys.macPrefix + counter.littleEndianBytes() + body)

    fun encrypt(frame: ByteArray): ByteArray {
        var count = 16 - frame.size % 16
        if (count == 16 && !keys.padAligned) count = 0
        val padded = frame + ByteArray(count) { (0xc0 + count).toByte() }
        if (padded.isEmpty() || padded.size > 4096) throw BandProtocolError("AirShield frame too large")
        val ciphertext = crypt(padded, keys.encryption, iv, Cipher.ENCRYPT_MODE)
        val body = byteArrayOf((ciphertext.size / 16 - 1).toByte()) + ciphertext
        val tag = tag(body)
        iv = ciphertext.copyOfRange(ciphertext.size - 16, ciphertext.size)
        counter += 1u
        return byteArrayOf(0x40) + tag.copyOfRange(0, 8) + body
    }

    fun decrypt(packet: ByteArray): ByteArray {
        if (packet.size < 10) throw BandProtocolError("Truncated AirShield packet")
        val expected = tag(packet.dropFirst(9))
        // Compare every byte before decrypting. No unauthenticated plaintext leaves this type.
        var difference = 0
        for (i in 0 until minOf(8, maxOf(0, packet.size - 1))) {
            difference = difference or (expected[i].toInt() xor packet[i + 1].toInt())
        }
        if (difference and 0xff != 0) throw BandProtocolError("Band packet authentication failed")
        val ciphertext = packet.dropFirst(10)
        val plaintext = crypt(ciphertext, keys.encryption, iv, Cipher.DECRYPT_MODE)
        iv = ciphertext.copyOfRange(ciphertext.size - 16, ciphertext.size)
        counter += 1u
        return plaintext
    }
}

internal class AirShieldReceiver(val cipher: AirShieldCipher) {
    private var pending = ByteArray(0)

    fun feed(bytes: ByteArray): List<ByteArray> {
        pending += bytes
        val plaintext = ArrayList<ByteArray>()
        while (pending.isNotEmpty()) {
            val marker = pending[0].toInt() and 0xff
            if ((marker == 0x81 || marker == 0x82) && pending.size >= 2 && (pending[1].toInt() and 0xff) <= 1) {
                pending = pending.dropFirst(2)
                continue
            }
            if (marker == 0x01 || marker == 0x02) {
                if (pending.size < 2) break
                val size = 3 + (pending[1].toInt() and 0xff)
                if (pending.size < size) break
                pending = pending.dropFirst(size)
                continue
            }
            if ((marker == 0x81 || marker == 0x82) && pending.size < 2) break
            if (marker != 0x40 && marker != 0x41 && marker != 0x42) {
                throw BandProtocolError("Unsupported band transport marker")
            }
            if (pending.size < 10) break
            val size = 10 + ((pending[9].toInt() and 0xff) + 1) * 16
            if (pending.size < size) break
            if (marker == 0x40) plaintext.add(cipher.decrypt(pending.copyOfRange(0, size)))
            // Relay channels are not part of the authenticated input service.
            pending = pending.dropFirst(size)
        }
        return plaintext
    }

    fun finish() {
        if (pending.isNotEmpty()) throw BandProtocolError("Truncated AirShield packet")
    }
}

/**
 * P-256 through the platform JCA. Points travel as the band's 64-byte X||Y form
 * (x9.63 without its 0x04 prefix); private keys as 32-byte big-endian scalars;
 * ECDSA signatures as 64-byte r||s.
 */
object P256 {
    internal val params: ECParameterSpec by lazy {
        val parameters = AlgorithmParameters.getInstance("EC")
        parameters.init(ECGenParameterSpec("secp256r1"))
        parameters.getParameterSpec(ECParameterSpec::class.java)
    }

    internal fun generateKeyPair(): KeyPair {
        val generator = KeyPairGenerator.getInstance("EC")
        generator.initialize(ECGenParameterSpec("secp256r1"))
        return generator.generateKeyPair()
    }

    internal fun rawPublic(key: ECPublicKey): ByteArray = fixed32(key.w.affineX) + fixed32(key.w.affineY)

    /** Rejects anything that is not a point on the curve, as CryptoKit does. */
    internal fun publicKey(raw: ByteArray): ECPublicKey {
        if (raw.size != 64) throw BandProtocolError("Invalid P-256 public key")
        val x = BigInteger(1, raw.copyOfRange(0, 32))
        val y = BigInteger(1, raw.copyOfRange(32, 64))
        val p = (params.curve.field as ECFieldFp).p
        val onCurve = x < p && y < p &&
            y.multiply(y).mod(p) == x.pow(3).add(params.curve.a.multiply(x)).add(params.curve.b).mod(p)
        if (!onCurve) throw BandProtocolError("Invalid P-256 public key")
        return try {
            KeyFactory.getInstance("EC").generatePublic(ECPublicKeySpec(ECPoint(x, y), params)) as ECPublicKey
        } catch (e: GeneralSecurityException) {
            throw BandProtocolError("Invalid P-256 public key")
        }
    }

    internal fun rawPrivate(key: ECPrivateKey): ByteArray = fixed32(key.s)

    internal fun privateKey(raw: ByteArray): ECPrivateKey {
        if (raw.size != 32) throw BandProtocolError("Invalid P-256 private key")
        val scalar = BigInteger(1, raw)
        if (scalar.signum() == 0 || scalar >= params.order) throw BandProtocolError("Invalid P-256 private key")
        return try {
            KeyFactory.getInstance("EC").generatePrivate(ECPrivateKeySpec(scalar, params)) as ECPrivateKey
        } catch (e: GeneralSecurityException) {
            throw BandProtocolError("Invalid P-256 private key")
        }
    }

    /** The x coordinate of the shared point, as CryptoKit's shared secret. */
    internal fun sharedSecret(privateKey: ECPrivateKey, peer: ECPublicKey): ByteArray =
        try {
            val agreement = KeyAgreement.getInstance("ECDH")
            agreement.init(privateKey)
            agreement.doPhase(peer, true)
            agreement.generateSecret()
        } catch (e: GeneralSecurityException) {
            throw BandProtocolError("Band key agreement failed")
        }

    /** ECDSA over SHA-256(message), returned as raw r||s. */
    internal fun sign(privateKey: ECPrivateKey, message: ByteArray): ByteArray {
        val signer = Signature.getInstance("SHA256withECDSA")
        signer.initSign(privateKey)
        signer.update(message)
        return derToRaw(signer.sign())
    }

    internal fun verify(publicKey: ECPublicKey, signature: ByteArray, message: ByteArray): Boolean {
        if (signature.size != 64) return false
        return try {
            val verifier = Signature.getInstance("SHA256withECDSA")
            verifier.initVerify(publicKey)
            verifier.update(message)
            verifier.verify(rawToDer(signature))
        } catch (e: GeneralSecurityException) {
            false
        }
    }

    internal fun derToRaw(der: ByteArray): ByteArray {
        var offset = 0
        fun length(): Int {
            val first = der[offset++].toInt() and 0xff
            if (first < 0x80) return first
            var value = 0
            repeat(first and 0x7f) { value = (value shl 8) or (der[offset++].toInt() and 0xff) }
            return value
        }
        fun integer(): ByteArray {
            if (der[offset++].toInt() != 0x02) throw BandProtocolError("Invalid ECDSA signature")
            val size = length()
            val value = BigInteger(1, der.copyOfRange(offset, offset + size))
            offset += size
            return fixed32(value)
        }
        try {
            if (der[offset++].toInt() != 0x30) throw BandProtocolError("Invalid ECDSA signature")
            length()
            return integer() + integer()
        } catch (e: IndexOutOfBoundsException) {
            throw BandProtocolError("Invalid ECDSA signature")
        }
    }

    internal fun rawToDer(raw: ByteArray): ByteArray {
        val r = BigInteger(1, raw.copyOfRange(0, 32)).toByteArray()
        val s = BigInteger(1, raw.copyOfRange(32, 64)).toByteArray()
        val body = byteArrayOf(0x02, r.size.toByte()) + r + byteArrayOf(0x02, s.size.toByte()) + s
        return byteArrayOf(0x30, body.size.toByte()) + body
    }

    private fun fixed32(value: BigInteger): ByteArray {
        val bytes = value.toByteArray()
        if (bytes.size > 33 || (bytes.size == 33 && bytes[0].toInt() != 0)) throw BandProtocolError("P-256 value out of range")
        val trimmed = if (bytes.size == 33) bytes.copyOfRange(1, 33) else bytes
        return ByteArray(32 - trimmed.size) + trimmed
    }

    object Signing {
        class PublicKey internal constructor(internal val key: ECPublicKey) {
            /** The 64-byte X||Y point. Throws [BandProtocolError] off the curve. */
            constructor(rawRepresentation: ByteArray) : this(P256.publicKey(rawRepresentation))

            val rawRepresentation: ByteArray get() = P256.rawPublic(key)
            val x963Representation: ByteArray get() = byteArrayOf(4) + rawRepresentation

            fun isValidSignature(signature: ByteArray, message: ByteArray): Boolean = P256.verify(key, signature, message)

            override fun equals(other: Any?): Boolean =
                other is PublicKey && rawRepresentation.contentEquals(other.rawRepresentation)

            override fun hashCode(): Int = rawRepresentation.contentHashCode()
        }

        /**
         * JCA cannot derive a public key from a bare scalar, so the pair travels
         * together; [fromRaw] checks that the two belong together.
         */
        class PrivateKey private constructor(internal val key: ECPrivateKey, val publicKey: PublicKey) {
            constructor() : this(P256.generateKeyPair())

            private constructor(pair: KeyPair) : this(pair.private as ECPrivateKey, PublicKey(pair.public as ECPublicKey))

            /** The 32-byte big-endian scalar. */
            val rawRepresentation: ByteArray get() = P256.rawPrivate(key)

            /** ECDSA over SHA-256(message), as the 64-byte r||s form. */
            fun signature(message: ByteArray): ByteArray = P256.sign(key, message)

            companion object {
                fun fromRaw(rawRepresentation: ByteArray, publicKey: PublicKey): PrivateKey {
                    val key = PrivateKey(P256.privateKey(rawRepresentation), publicKey)
                    val probe = "neural band key check".toByteArray()
                    if (!publicKey.isValidSignature(key.signature(probe), probe)) {
                        throw BandProtocolError("P-256 private key does not match its public key")
                    }
                    return key
                }
            }
        }
    }
}

internal fun sha256(data: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(data)

internal fun hmacSha256(key: ByteArray, data: ByteArray): ByteArray {
    val mac = Mac.getInstance("HmacSHA256")
    mac.init(SecretKeySpec(key, "HmacSHA256"))
    return mac.doFinal(data)
}

/** RFC 5869 HKDF-SHA256, extract then expand. */
internal fun hkdfSha256(ikm: ByteArray, salt: ByteArray, info: ByteArray, length: Int): ByteArray {
    val prk = hmacSha256(if (salt.isEmpty()) ByteArray(32) else salt, ikm)
    var output = ByteArray(0)
    var block = ByteArray(0)
    var counter = 1
    while (output.size < length) {
        block = hmacSha256(prk, block + info + byteArrayOf(counter.toByte()))
        output += block
        counter += 1
    }
    return output.copyOfRange(0, length)
}

internal fun ByteArray.dropFirst(count: Int): ByteArray =
    if (count >= size) ByteArray(0) else copyOfRange(count, size)

internal fun UInt.littleEndianBytes(): ByteArray =
    byteArrayOf(toByte(), (this shr 8).toByte(), (this shr 16).toByte(), (this shr 24).toByte())

internal fun UInt.bigEndianBytes(): ByteArray =
    byteArrayOf((this shr 24).toByte(), (this shr 16).toByte(), (this shr 8).toByte(), toByte())
