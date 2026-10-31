package com.faceclaw.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.os.Handler
import android.os.Looper
import android.util.AtomicFile
import android.util.Log

import java.io.File
import java.io.IOException

/**
 * adb-triggered export/import of Faceclaw's settings as the JSON document shared with iOS
 * (SettingsTransfer; see scripts/config-transfer.md). scripts/pull_config.sh and
 * scripts/push_config.sh drive it; it works on release builds, where run-as is unavailable.
 *
 *   adb shell am broadcast --include-stopped-packages \
 *       -n com.faceclaw.app/.FaceclawSettingsPortReceiver -a com.faceclaw.app.SETTINGS_EXPORT
 *   adb pull /sdcard/Android/data/com.faceclaw.app/files/faceclaw-settings-export.json
 *
 *   adb push settings.json /sdcard/Android/data/com.faceclaw.app/files/faceclaw-settings-import.json
 *   adb shell am broadcast --include-stopped-packages \
 *       -n com.faceclaw.app/.FaceclawSettingsPortReceiver -a com.faceclaw.app.SETTINGS_IMPORT
 *
 * Settings live in two SharedPreferences files: FaceclawSettings' own, and NativeScript's
 * ApplicationSettings file (prefs.db), which still holds the pairing, onboarding and EvenHub
 * localStorage keys. Both are exported, and each imported key is written to the file the app
 * reads it from. An import merges: settings missing from the document are left alone.
 * It writes through the process's live SharedPreferences, so a running app cannot flush stale
 * values over it, then exits so the next launch starts from the imported settings.
 *
 * Security: the settings contain API tokens, so the manifest guards this receiver with
 * android.permission.DUMP — a development permission the adb shell holds but ordinary apps
 * cannot obtain without adb's help, keeping the trigger reachable from adb only. The transfer
 * file lives in getExternalFilesDir(), which other apps cannot read on Android 11+ (and which
 * the scripts delete as soon as the transfer completes); on the Android 7-10 devices minSdk
 * still admits, apps holding READ_EXTERNAL_STORAGE could read it during that window.
 */
class FaceclawSettingsPortReceiver : BroadcastReceiver() {
    companion object {
        private const val TAG = "FaceclawSettingsPort"
        const val ACTION_EXPORT = "com.faceclaw.app.SETTINGS_EXPORT"
        const val ACTION_IMPORT = "com.faceclaw.app.SETTINGS_IMPORT"
        private const val PLATFORM = "android"
        private const val SETTINGS_PREFS = "faceclaw_settings" // FaceclawSettings
        private const val NATIVESCRIPT_PREFS = "prefs.db" // NativeScript ApplicationSettings
        private const val EXPORT_NAME = "faceclaw-settings-export.json"
        private const val IMPORT_NAME = "faceclaw-settings-import.json"
        private const val BACKUP_NAME = "faceclaw-settings-previous.json"

        private enum class StoredAs { STRING, BOOLEAN, NUMBER }

        /**
         * Keys the app reads through NativeScript's ApplicationSettings rather than FaceclawSettings,
         * and the getter it uses (device-addresses.ts, onboarding-state.ts, evenhub/session.ts;
         * tests/settings-transfer.test.cjs keeps this list in step with them). prefs.db also holds
         * settings abandoned when FaceclawSettings took over, so nothing else is read from it.
         */
        private fun nativeScriptKey(key: String): StoredAs? = when {
            key == "onboarding.complete" || key == "onboarding.previewOnly" -> StoredAs.BOOLEAN
            key == "deviceIdentity.pairedAtMs" -> StoredAs.NUMBER
            key.startsWith("deviceAddress.") || key.startsWith("deviceIdentity.") || key.startsWith("evenhub:") -> StoredAs.STRING
            else -> null
        }
    }

    override fun onReceive(context: Context, intent: Intent?) {
        val action = intent?.action
        try {
            if (ACTION_EXPORT == action) {
                resultData = exportSettings(context)
            } else if (ACTION_IMPORT == action) {
                val result = importSettings(context)
                resultData = result
                if (!result.startsWith("imported:")) return
                // Restart cleanly: running code may hold settings it read before the import.
                Handler(Looper.getMainLooper()).postDelayed({
                    Log.i(TAG, "Exiting after settings import")
                    System.exit(0)
                }, 500)
            }
        } catch (e: Exception) {
            Log.e(TAG, "Settings $action failed", e)
            resultData = "error: ${e.message ?: e}"
        }
    }

    private fun settingsPrefs(context: Context): SharedPreferences =
        context.getSharedPreferences(SETTINGS_PREFS, Context.MODE_PRIVATE)

    private fun nativeScriptPrefs(context: Context): SharedPreferences =
        context.getSharedPreferences(NATIVESCRIPT_PREFS, Context.MODE_PRIVATE)

    @Throws(IOException::class)
    private fun externalFile(context: Context, name: String): File {
        val dir = context.getExternalFilesDir(null)
            ?: throw IOException("external files dir unavailable")
        return File(dir, name)
    }

    private fun appVersion(context: Context): String? =
        runCatching { context.packageManager.getPackageInfo(context.packageName, 0).versionName }.getOrNull()

    /** Every setting, from the file the app reads it from, as SettingsTransfer values. */
    private fun currentSettings(context: Context): Map<String, Any?> {
        val values = linkedMapOf<String, Any?>()
        for ((key, value) in settingsPrefs(context).all) {
            if (key == null || nativeScriptKey(key) != null) continue
            val exported = exportable(value)
            if (exported != null) values[key] = exported else Log.w(TAG, "Not exporting $key: unsupported type")
        }
        for ((key, value) in nativeScriptPrefs(context).all) {
            val storedAs = nativeScriptKey(key ?: continue) ?: continue
            // NativeScript stores numbers as the raw bits of a double in a long.
            val exported = if (storedAs == StoredAs.NUMBER && value is Long) {
                Double.fromBits(value).takeIf { it.isFinite() }?.let { JsonNumber.of(it) }
            } else {
                exportable(value)
            }
            if (exported != null) values[key] = exported else Log.w(TAG, "Not exporting $key: unsupported value")
        }
        return values
    }

    private fun exportable(value: Any?): Any? = when (value) {
        is String, is Boolean -> value
        is Int, is Long -> JsonNumber(value.toString())
        is Float -> value.toDouble().takeIf { it.isFinite() }?.let { JsonNumber.of(it) }
        else -> null // string sets are unused
    }

    private fun exportSettings(context: Context): String {
        val document = SettingsTransfer.export(currentSettings(context), PLATFORM, appVersion(context))
        val out = externalFile(context, EXPORT_NAME)
        writeAtomically(out, document)
        return "exported: $out"
    }

    private fun importSettings(context: Context): String {
        val staged = externalFile(context, IMPORT_NAME)
        if (!staged.exists()) {
            return "error: nothing staged at $staged"
        }
        val plan = try {
            SettingsTransfer.planImport(staged.readText(), PLATFORM)
        } finally {
            staged.delete() // holds API tokens
        }

        // Convert everything before writing anything, so a bad value leaves settings untouched.
        val settingsWrites = ArrayList<(SharedPreferences.Editor) -> Unit>()
        val nativeScriptWrites = ArrayList<(SharedPreferences.Editor) -> Unit>()
        for ((key, value) in plan.values) {
            when (nativeScriptKey(key)) {
                // FaceclawSettings only has string and boolean getters.
                null -> if (value is Boolean) {
                    settingsWrites.add { e -> e.putBoolean(key, value) }
                } else {
                    settingsWrites.add { e -> e.putString(key, text(value)) }
                }
                StoredAs.STRING -> nativeScriptWrites.add { e -> e.putString(key, text(value)) }
                StoredAs.BOOLEAN -> {
                    val flag = value as? Boolean ?: (value as? String)?.toBooleanStrictOrNull()
                        ?: throw IllegalArgumentException("Setting $key must be a boolean")
                    nativeScriptWrites.add { e -> e.putBoolean(key, flag) }
                }
                StoredAs.NUMBER -> {
                    val number = text(value).toDoubleOrNull()?.takeIf { it.isFinite() }
                        ?: throw IllegalArgumentException("Setting $key must be a number")
                    nativeScriptWrites.add { e -> e.putLong(key, number.toRawBits()) }
                }
            }
        }

        val backup = File(context.filesDir, BACKUP_NAME)
        writeAtomically(backup, SettingsTransfer.export(currentSettings(context), PLATFORM, appVersion(context)))
        commit(settingsPrefs(context), settingsWrites)
        commit(nativeScriptPrefs(context), nativeScriptWrites)

        val skipped = if (plan.skipped.isEmpty()) "" else
            " (left out ${plan.skipped.size} ${plan.sourcePlatform ?: "other-platform"}-only settings)"
        return "imported: ${plan.values.size} settings$skipped; previous settings saved in $backup"
    }

    private fun text(value: Any): String = when (value) {
        is JsonNumber -> value.text
        else -> value.toString()
    }

    private fun commit(prefs: SharedPreferences, writes: List<(SharedPreferences.Editor) -> Unit>) {
        if (writes.isEmpty()) return
        val editor = prefs.edit()
        for (write in writes) write(editor)
        if (!editor.commit()) throw IOException("Could not save settings")
    }

    private fun writeAtomically(file: File, text: String) {
        val atomic = AtomicFile(file)
        val stream = atomic.startWrite()
        try {
            stream.write(text.toByteArray(Charsets.UTF_8))
            atomic.finishWrite(stream)
        } catch (e: IOException) {
            atomic.failWrite(stream)
            throw e
        }
    }
}
