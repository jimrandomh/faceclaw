package dev.lumen.band

import android.bluetooth.BluetoothAdapter
import android.content.Context
import android.util.AtomicFile
import android.util.Base64
import org.json.JSONObject
import java.io.File
import java.io.FileNotFoundException
import java.util.Locale

/** An Air Gestures export for a band already claimed and bonded to this phone. */
object Identity {
    private const val BUNDLE_FORMAT = "air-gestures-band"
    private const val BUNDLE_VERSION = 1
    private const val MAX_BUNDLE_BYTES = 16 * 1024

    internal data class Record(
        val address: String,
        val schemeGuess: Int,
        val owner: ByteArray,
    )

    private fun store(context: Context) =
        AtomicFile(File(context.noBackupFilesDir, "neural-band-owner-v1.json"))

    @JvmStatic
    @Synchronized
    fun present(context: Context): Boolean {
        val record = load(context) ?: return false
        record.owner.fill(0)
        return true
    }

    /** Replaces the key and address as one atomic record after validating the export. */
    @JvmStatic
    @Synchronized
    fun importBundle(context: Context, bytes: ByteArray): Boolean {
        if (!Bridge.available) return false
        val bundle = parse(bytes, MAX_BUNDLE_BYTES) ?: return false
        val record = decode(bundle) ?: return false
        try {
            val handle = Bridge.open(record.owner, record.schemeGuess, false, "", "")
            if (handle == 0L) return false
            Bridge.close(handle)
            return write(context, bytes)
        } catch (_: Exception) {
            return false
        } catch (_: LinkageError) {
            return false
        } finally {
            record.owner.fill(0)
        }
    }

    /** Stop the link before erasing its local identity. The Android Bluetooth bond stays. */
    @JvmStatic
    @Synchronized
    fun forgetLocal(context: Context): Boolean {
        val file = store(context)
        file.delete()
        return try {
            file.openRead().use { false }
        } catch (_: FileNotFoundException) {
            !file.baseFile.exists()
        } catch (_: Exception) {
            false
        }
    }

    @Synchronized
    internal fun load(context: Context): Record? = runCatching { read(context)?.let(::decode) }.getOrNull()

    private fun read(context: Context): JSONObject? {
        val bytes = try {
            store(context).readFully()
        } catch (error: FileNotFoundException) {
            if (store(context).baseFile.exists()) throw error
            return null
        }
        return try {
            parse(bytes, MAX_BUNDLE_BYTES) ?: error("Invalid private Neural Band owner record")
        } finally {
            bytes.fill(0)
        }
    }

    private fun write(context: Context, bytes: ByteArray): Boolean {
        val file = store(context)
        val output = file.startWrite()
        try {
            output.write(bytes)
            file.finishWrite(output)
        } catch (_: Exception) {
            file.failWrite(output)
            return false
        }
        val stored = file.readFully()
        return try {
            stored.contentEquals(bytes)
        } finally {
            stored.fill(0)
        }
    }

    private fun parse(bytes: ByteArray, maxLength: Int): JSONObject? =
        if (bytes.isEmpty() || bytes.size > maxLength) null else runCatching {
            JSONObject(bytes.toString(Charsets.UTF_8))
        }.getOrNull()

    private fun validAddress(address: String) = BluetoothAdapter.checkBluetoothAddress(address) &&
        address != "00:00:00:00:00:00"

    private fun decode(bundle: JSONObject): Record? = runCatching {
            if (bundle.getString("format") != BUNDLE_FORMAT || bundle.getInt("version") != BUNDLE_VERSION) {
                return null
            }
            val band = bundle.getJSONObject("band")
            val address = band.getString("address").uppercase(Locale.ROOT)
            if (!validAddress(address)) return null
            val owner = Base64.decode(bundle.getString("owner_key"), Base64.DEFAULT)
            if (owner.size != 32 && owner.size != 97) {
                owner.fill(0)
                return null
            }
            Record(address, band.optInt("scheme_guess", 0), owner)
    }.getOrNull()
}
