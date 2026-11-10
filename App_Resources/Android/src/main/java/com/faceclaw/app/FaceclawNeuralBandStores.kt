// Adapted from tetramo-labs/glassly (MIT): bluetooth-sdk controllers/neuralband/MetaPairClient.kt
// (KeystoreSealedPrefs, MetaSessionStore) and core/BandIdentity.kt (EncryptedPrefsBandIdentityStore),
// themselves ported from callbacked/kinesis (MIT).
package com.faceclaw.app

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import com.faceclaw.app.neuralband.BandEnrollmentIdentity
import com.faceclaw.app.neuralband.BandIdentityStore
import com.faceclaw.app.neuralband.BandProtocolError
import com.faceclaw.app.neuralband.P256
import java.security.KeyStore
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONObject

/**
 * Values sealed with an AndroidKeyStore AES-256-GCM key, one preferences file per use. Each
 * entry is bound to its preference name as GCM associated data, so entries can't be swapped.
 * Nothing sealed here reaches Faceclaw's settings export (it isn't in the settings store).
 */
internal class KeystoreSealedPrefs(context: Context, prefsName: String, private val alias: String) {
    private val prefs = context.applicationContext.getSharedPreferences(prefsName, Context.MODE_PRIVATE)

    fun read(name: String): ByteArray? {
        val stored = prefs.getString(name, null) ?: return null
        return try {
            val sealed = Base64.decode(stored, Base64.NO_WRAP)
            if (sealed.size <= IV_BYTES) return null
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, wrappingKey(create = false) ?: return null, GCMParameterSpec(TAG_BITS, sealed, 0, IV_BYTES))
            cipher.updateAAD(name.toByteArray())
            cipher.doFinal(sealed, IV_BYTES, sealed.size - IV_BYTES)
        } catch (e: Exception) {
            null
        }
    }

    fun write(name: String, value: ByteArray): Boolean {
        val encoded = try {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.ENCRYPT_MODE, wrappingKey(create = true))
            cipher.updateAAD(name.toByteArray())
            Base64.encodeToString(cipher.iv + cipher.doFinal(value), Base64.NO_WRAP)
        } catch (e: Exception) {
            return false
        }
        return prefs.edit().putString(name, encoded).commit()
    }

    fun remove(vararg names: String) {
        val edit = prefs.edit()
        for (name in names) edit.remove(name)
        edit.commit()
    }

    private fun wrappingKey(create: Boolean): SecretKey? {
        val keyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        (keyStore.getKey(alias, null) as? SecretKey)?.let { return it }
        if (!create) return null
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    private companion object {
        const val KEYSTORE = "AndroidKeyStore"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val IV_BYTES = 12
        const val TAG_BITS = 128
    }
}

/**
 * The band identity Faceclaw proves ownership with, one per band (keyed by its Bluetooth
 * address). A claimed band reconnects with it and never needs the Meta account again.
 */
class FaceclawBandIdentityStore(context: Context) : BandIdentityStore {
    private val sealed = KeystoreSealedPrefs(context, "faceclaw_neural_band_identity", "faceclaw_neural_band_identity_wrap")

    override fun load(bandId: String): BandEnrollmentIdentity? {
        val keys = sealed.read(bandId)?.takeIf { it.size == 96 } ?: return null
        val privateKey = try {
            P256.Signing.PrivateKey.fromRaw(keys.copyOfRange(0, 32), P256.Signing.PublicKey(keys.copyOfRange(32, 96)))
        } catch (e: BandProtocolError) {
            return null
        }
        val bandKey = sealed.read(bandId + BAND_KEY_SUFFIX)?.takeIf { it.size == 64 }?.let {
            try {
                P256.Signing.PublicKey(it)
            } catch (e: BandProtocolError) {
                null
            }
        }
        return BandEnrollmentIdentity(privateKey, bandKey)
    }

    override fun save(bandId: String, privateKey: P256.Signing.PrivateKey, bandKey: P256.Signing.PublicKey?) {
        if (!sealed.write(bandId, privateKey.rawRepresentation + privateKey.publicKey.rawRepresentation)) {
            throw BandProtocolError("Couldn't store the band identity in the keystore")
        }
        if (bandKey != null) sealed.write(bandId + BAND_KEY_SUFFIX, bandKey.rawRepresentation)
    }

    override fun delete(bandId: String) = sealed.remove(bandId, bandId + BAND_KEY_SUFFIX)

    private companion object {
        const val BAND_KEY_SUFFIX = ".band"
    }
}

/** The Meta account session the ownership exchanges require. The sign-in runs in FaceclawMetaSignInActivity. */
class MetaSession(
    val accessToken: String,
    val userId: String,
    val deviceId: String = UUID.randomUUID().toString(),
    val obtainedAt: Long = System.currentTimeMillis(),
) {
    companion object {
        const val UNIVERSE = "ar"
    }
}

/** The session json, sealed in the keystore. Token material never reaches the log or JavaScript. */
class MetaSessionStore(context: Context) {
    private val sealed = KeystoreSealedPrefs(context, "faceclaw_neural_band_meta", "faceclaw_neural_band_meta_wrap")

    fun hasSavedSession(): Boolean = restoreSession() != null

    fun saveSession(session: MetaSession): Boolean {
        val json = JSONObject()
            .put("accessToken", session.accessToken)
            .put("userId", session.userId)
            .put("deviceId", session.deviceId)
            .put("universe", MetaSession.UNIVERSE)
            .put("obtainedAt", session.obtainedAt)
        return sealed.write(ACCOUNT, json.toString().toByteArray())
    }

    fun restoreSession(): MetaSession? {
        val bytes = sealed.read(ACCOUNT) ?: return null
        val json = runCatching { JSONObject(String(bytes)) }.getOrNull() ?: return null
        val token = json.optString("accessToken")
        val userId = json.optString("userId")
        if (json.optString("universe") != MetaSession.UNIVERSE || token.isEmpty() || userId.isEmpty()) return null
        return MetaSession(token, userId, json.optString("deviceId", UUID.randomUUID().toString()), json.optLong("obtainedAt"))
    }

    fun deleteSession() = sealed.remove(ACCOUNT)

    private companion object {
        const val ACCOUNT = "session"
    }
}
