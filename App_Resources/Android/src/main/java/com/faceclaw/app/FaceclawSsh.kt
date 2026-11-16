package com.faceclaw.app

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import android.util.Base64
import android.util.Log
import com.faceclaw.ssh.faceclawssh.Channel
import com.faceclaw.ssh.faceclawssh.Faceclawssh
import com.faceclaw.ssh.faceclawssh.Listener
import com.faceclaw.ssh.faceclawssh.Signer
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * One SSH channel for the TypeScript side (app/native/ssh.ts), backed by the
 * gomobile-bound Go transport in native/ssh. `spec` is the Go openSpec JSON.
 * Events arrive from Go goroutines and are posted to the Looper of the
 * thread that constructed this object (a JS isolate's own thread), like
 * FaceclawWebSocket.
 */
class FaceclawSshChannel(spec: String, useKey: Boolean, listener: FaceclawSshListener) {
    private val handler = Handler(Looper.myLooper() ?: Looper.getMainLooper())
    private val channel: Channel

    init {
        val signer = if (useKey) FaceclawSshKeys.signer() else null
        channel = Faceclawssh.open(spec, signer, object : Listener {
            override fun onEvent(kind: String?, payload: String?) {
                handler.post {
                    try {
                        listener.onEvent(kind, payload)
                    } catch (t: Throwable) {
                        Log.w(TAG, "listener onEvent($kind) failed", t)
                    }
                }
            }
        })
    }

    fun send(text: String): Boolean = channel.send(text)

    fun close() = channel.close()

    private companion object {
        const val TAG = "FaceclawSsh"
    }
}

/**
 * The device's SSH client key and the Terminal app's saved SSH passwords.
 *
 * The client key is an ECDSA P-256 key generated inside Android Keystore
 * (StrongBox when the device has one) and never exportable: only its public
 * half leaves the keystore, as an authorized_keys line. Passwords are
 * encrypted with an AES-GCM key that also lives in Keystore, and stored in a
 * private SharedPreferences file kept apart from the settings store (which is
 * exported by the settings port).
 */
object FaceclawSshKeys {
    private const val TAG = "FaceclawSsh"
    private const val CLIENT_KEY_ALIAS = "faceclaw-ssh-client"
    private const val SECRET_KEY_ALIAS = "faceclaw-ssh-secrets"
    private const val SECRETS_PREFS = "faceclaw_ssh_secrets"
    private const val GCM_TAG_BITS = 128

    private fun keyStore(): KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    @JvmStatic
    @Synchronized
    fun hasClientKey(): Boolean = keyStore().containsAlias(CLIENT_KEY_ALIAS)

    /** Generate the client key if it doesn't exist yet. */
    @JvmStatic
    @Synchronized
    fun ensureClientKey() {
        if (keyStore().containsAlias(CLIENT_KEY_ALIAS)) return
        fun spec(strongBox: Boolean): KeyGenParameterSpec {
            val builder = KeyGenParameterSpec.Builder(CLIENT_KEY_ALIAS, KeyProperties.PURPOSE_SIGN)
                .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
            if (strongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) builder.setIsStrongBoxBacked(true)
            return builder.build()
        }
        val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
        try {
            generator.initialize(spec(strongBox = true))
            generator.generateKeyPair()
        } catch (e: Exception) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && e is StrongBoxUnavailableException) {
                Log.i(TAG, "StrongBox unavailable; generating the SSH key in the TEE")
            } else {
                Log.w(TAG, "StrongBox key generation failed; retrying in the TEE", e)
            }
            generator.initialize(spec(strongBox = false))
            generator.generateKeyPair()
        }
        Log.i(TAG, "generated SSH client key")
    }

    /** X.509 SubjectPublicKeyInfo DER of the client key, or null if none. */
    @JvmStatic
    fun publicKey(): ByteArray? = keyStore().getCertificate(CLIENT_KEY_ALIAS)?.publicKey?.encoded

    /** The client key's authorized_keys line (generating the key if needed). */
    @JvmStatic
    fun authorizedKey(comment: String): String {
        ensureClientKey()
        return Faceclawssh.authorizedKey(publicKey(), comment)
    }

    /** The client key's SHA256 fingerprint (generating the key if needed). */
    @JvmStatic
    fun fingerprint(): String {
        ensureClientKey()
        return Faceclawssh.fingerprint(publicKey())
    }

    /** A Go Signer over the client key, generating the key if needed. */
    @JvmStatic
    fun signer(): Signer? = try {
        ensureClientKey()
        val publicKey = publicKey() ?: throw IllegalStateException("client key has no certificate")
        object : Signer {
            override fun publicKey(): ByteArray = publicKey
            override fun sign(data: ByteArray?): ByteArray {
                val privateKey = keyStore().getKey(CLIENT_KEY_ALIAS, null) as PrivateKey
                return Signature.getInstance("SHA256withECDSA").run {
                    initSign(privateKey)
                    update(data ?: ByteArray(0))
                    sign()
                }
            }
        }
    } catch (t: Throwable) {
        Log.w(TAG, "SSH client key unavailable", t)
        null
    }

    private fun secretKey(): SecretKey {
        val store = keyStore()
        (store.getKey(SECRET_KEY_ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(SECRET_KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        )
        return generator.generateKey()
    }

    private fun prefs(context: Context) =
        context.applicationContext.getSharedPreferences(SECRETS_PREFS, Context.MODE_PRIVATE)

    @JvmStatic
    @Synchronized
    fun setSecret(context: Context, id: String, value: String) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, secretKey())
        val sealed = cipher.iv + cipher.doFinal(value.toByteArray(Charsets.UTF_8))
        prefs(context).edit().putString(id, Base64.encodeToString(sealed, Base64.NO_WRAP)).apply()
    }

    /** The saved secret, or "" if none (or it can no longer be decrypted). */
    @JvmStatic
    @Synchronized
    fun getSecret(context: Context, id: String): String {
        val encoded = prefs(context).getString(id, null) ?: return ""
        return try {
            val sealed = Base64.decode(encoded, Base64.NO_WRAP)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            val ivLength = 12
            cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(GCM_TAG_BITS, sealed, 0, ivLength))
            String(cipher.doFinal(sealed, ivLength, sealed.size - ivLength), Charsets.UTF_8)
        } catch (t: Throwable) {
            Log.w(TAG, "saved SSH secret unreadable; dropping it", t)
            prefs(context).edit().remove(id).apply()
            ""
        }
    }

    @JvmStatic
    @Synchronized
    fun removeSecret(context: Context, id: String) {
        prefs(context).edit().remove(id).apply()
    }

    /** Put text on the phone's clipboard (from any thread). */
    @JvmStatic
    fun copyToClipboard(context: Context, label: String, text: String) {
        val appContext = context.applicationContext
        Handler(Looper.getMainLooper()).post {
            val clipboard = appContext.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            clipboard.setPrimaryClip(ClipData.newPlainText(label, text))
        }
    }
}
