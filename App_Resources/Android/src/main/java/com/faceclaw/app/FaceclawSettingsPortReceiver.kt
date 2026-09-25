package com.faceclaw.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.util.Log

import java.io.File
import java.io.IOException

/**
 * adb-only JSONC config transfer, guarded by android.permission.DUMP.
 * Files are staged in the external app directory and removed after transfer.
 */
class FaceclawSettingsPortReceiver : BroadcastReceiver() {
    companion object {
        private const val TAG = "FaceclawSettingsPort"
        const val ACTION_EXPORT = "com.faceclaw.app.SETTINGS_EXPORT"
        const val ACTION_IMPORT = "com.faceclaw.app.SETTINGS_IMPORT"
        private const val EXPORT_NAME = "faceclaw-settings-export.jsonc"
        private const val IMPORT_NAME = "faceclaw-settings-import.jsonc"
    }

    override fun onReceive(context: Context, intent: Intent?) {
        val action = intent?.action
        try {
            if (ACTION_EXPORT == action) {
                resultData = exportSettings(context)
            } else if (ACTION_IMPORT == action) {
                resultData = importSettings(context)
                // Exit once the broadcast result has been delivered: app
                // components may cache derived settings; restart them
                // against the imported document.
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

    @Throws(IOException::class)
    private fun externalFile(context: Context, name: String): File {
        val dir = context.getExternalFilesDir(null)
            ?: throw IOException("external files dir unavailable")
        return File(dir, name)
    }

    @Throws(IOException::class)
    private fun exportSettings(context: Context): String {
        val config = FaceclawSettings.getInstance(context).exportConfig()
        val out = externalFile(context, EXPORT_NAME)
        out.writeText(config, Charsets.UTF_8)
        return "exported: $out"
    }

    @Throws(Exception::class)
    private fun importSettings(context: Context): String {
        val staged = externalFile(context, IMPORT_NAME)
        if (!staged.exists() || staged.length() > 2 * 1024 * 1024) {
            throw IOException("Missing or oversized staged config")
        }
        try {
            FaceclawSettings.getInstance(context).importConfig(staged.readText(Charsets.UTF_8))
        } finally {
            staged.delete()
        }
        return "imported: ${FaceclawSettings.configFile(context)} (previous settings in .previous)"
    }
}
