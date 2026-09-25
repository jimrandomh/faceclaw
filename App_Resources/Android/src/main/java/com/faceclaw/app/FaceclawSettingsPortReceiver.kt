package com.faceclaw.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.util.Xml

import org.xmlpull.v1.XmlPullParser

import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream

/**
 * adb-triggered export/import of the faceclaw_settings SharedPreferences
 * file, so configuration (API keys, device addresses, ...) can be moved off a
 * release build, where run-as is unavailable. See scripts/pull_config.sh and
 * scripts/push_config.sh, which use run-as on debuggable builds and fall back
 * to this receiver otherwise.
 *
 *   adb shell am broadcast -n com.faceclaw.app/.FaceclawSettingsPortReceiver \
 *       -a com.faceclaw.app.SETTINGS_EXPORT
 *   adb pull /sdcard/Android/data/com.faceclaw.app/files/faceclaw-settings-export.xml
 *
 *   adb push settings.xml /sdcard/Android/data/com.faceclaw.app/files/faceclaw-settings-import.xml
 *   adb shell am broadcast -n com.faceclaw.app/.FaceclawSettingsPortReceiver \
 *       -a com.faceclaw.app.SETTINGS_IMPORT
 *
 * Security: the settings file contains API tokens, so the manifest guards
 * this receiver with android.permission.DUMP — a development permission the
 * adb shell holds but ordinary apps cannot obtain without adb's help, keeping
 * the trigger reachable from adb only. The transfer file lives in
 * getExternalFilesDir(), which other apps cannot read on Android 11+ (and
 * which the scripts delete as soon as the transfer completes); on the
 * Android 7-10 devices minSdk still admits, apps holding READ_EXTERNAL_STORAGE
 * could read it during that window.
 */
class FaceclawSettingsPortReceiver : BroadcastReceiver() {
    companion object {
        private const val TAG = "FaceclawSettingsPort"
        const val ACTION_EXPORT = "com.faceclaw.app.SETTINGS_EXPORT"
        const val ACTION_IMPORT = "com.faceclaw.app.SETTINGS_IMPORT"
        private const val PREFS_FILE = "faceclaw_settings.xml"
        private const val EXPORT_NAME = "faceclaw-settings-export.xml"
        private const val IMPORT_NAME = "faceclaw-settings-import.xml"
    }

    override fun onReceive(context: Context, intent: Intent?) {
        val action = intent?.action
        try {
            if (ACTION_EXPORT == action) {
                resultData = exportSettings(context)
            } else if (ACTION_IMPORT == action) {
                resultData = importSettings(context)
                // Exit once the broadcast result has been delivered: this
                // process may hold stale in-memory SharedPreferences that a
                // later apply() would flush over the imported file, and the
                // next launch must re-read from disk.
                Handler(Looper.getMainLooper()).postDelayed({
                    Log.i(TAG, "Exiting after settings import")
                    System.exit(0)
                }, 500)
            }
        } catch (e: Exception) {
            Log.e(TAG, "Settings $action failed", e)
            resultData = "error: $e"
        }
    }

    private fun prefsFile(context: Context): File {
        return File(context.applicationInfo.dataDir, "shared_prefs/$PREFS_FILE")
    }

    @Throws(IOException::class)
    private fun externalFile(context: Context, name: String): File {
        val dir = context.getExternalFilesDir(null)
            ?: throw IOException("external files dir unavailable")
        return File(dir, name)
    }

    @Throws(IOException::class)
    private fun exportSettings(context: Context): String {
        val prefs = prefsFile(context)
        if (!prefs.exists()) {
            return "error: no settings file yet ($prefs)"
        }
        val out = externalFile(context, EXPORT_NAME)
        copy(prefs, out)
        return "exported: $out"
    }

    @Throws(Exception::class)
    private fun importSettings(context: Context): String {
        val staged = externalFile(context, IMPORT_NAME)
        if (!staged.exists()) {
            return "error: nothing staged at $staged"
        }
        validatePrefsXml(staged)
        val prefs = prefsFile(context)
        prefs.parentFile?.mkdirs()
        if (prefs.exists()) {
            copy(prefs, File(prefs.path + ".bak"))
        }
        copy(staged, prefs)
        staged.delete()
        return "imported: $prefs (previous settings in $PREFS_FILE.bak)"
    }

    /** Reject files that are not a SharedPreferences <map> document. */
    @Throws(Exception::class)
    private fun validatePrefsXml(file: File) {
        FileInputStream(file).use { input ->
            val parser = Xml.newPullParser()
            parser.setInput(input, null)
            var event = parser.next()
            while (event != XmlPullParser.START_TAG && event != XmlPullParser.END_DOCUMENT) {
                event = parser.next()
            }
            if (event != XmlPullParser.START_TAG || "map" != parser.name) {
                throw IOException("not a SharedPreferences <map> document")
            }
            // Walk the rest so malformed XML is caught before it replaces
            // the live settings file.
            while (parser.next() != XmlPullParser.END_DOCUMENT) { }
        }
    }

    @Throws(IOException::class)
    private fun copy(from: File, to: File) {
        FileInputStream(from).use { input: InputStream ->
            FileOutputStream(to).use { out: OutputStream ->
                val buffer = ByteArray(8192)
                var n: Int
                while (input.read(buffer).also { n = it } > 0) {
                    out.write(buffer, 0, n)
                }
            }
        }
    }
}
