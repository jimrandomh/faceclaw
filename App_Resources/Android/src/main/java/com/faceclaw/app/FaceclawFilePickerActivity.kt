package com.faceclaw.app

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.util.Log
import android.webkit.ValueCallback
import android.webkit.WebChromeClient

/** Runs Android's system picker and returns its URIs to the hosted WebView. */
class FaceclawFilePickerActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (savedInstanceState != null) return

        val picker = pendingIntent
        if (picker == null) {
            deliver(null)
            finish()
            return
        }

        try {
            startActivityForResult(picker, REQUEST_CODE)
        } catch (error: ActivityNotFoundException) {
            Log.w(TAG, "No file picker available", error)
            deliver(null)
            finish()
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQUEST_CODE) return

        val selected = WebChromeClient.FileChooserParams.parseResult(resultCode, data)
            ?: multipleSelection(resultCode, data)
        deliver(selected)
        finish()
    }

    override fun onDestroy() {
        if (isFinishing && !isChangingConfigurations) deliver(null)
        super.onDestroy()
    }

    private fun multipleSelection(resultCode: Int, data: Intent?): Array<Uri>? {
        if (resultCode != RESULT_OK) return null
        val clip = data?.clipData ?: return null
        return Array(clip.itemCount) { index -> clip.getItemAt(index).uri }
    }

    companion object {
        private const val TAG = "FaceclawFilePicker"
        private const val REQUEST_CODE = 7301

        private var pendingCallback: ValueCallback<Array<Uri>>? = null
        private var pendingIntent: Intent? = null

        private fun deliver(uris: Array<Uri>?) {
            val callback = pendingCallback
            pendingCallback = null
            pendingIntent = null
            callback?.onReceiveValue(uris)
        }

        @JvmStatic
        fun launch(
            context: Context,
            callback: ValueCallback<Array<Uri>>,
            params: WebChromeClient.FileChooserParams,
        ): Boolean {
            deliver(null)

            val picker = try {
                params.createIntent()
            } catch (error: Exception) {
                Log.w(TAG, "Could not create file picker intent", error)
                null
            } ?: Intent(Intent.ACTION_GET_CONTENT).setType("*/*")

            picker.addCategory(Intent.CATEGORY_OPENABLE)
            if (params.acceptTypes.any { it.startsWith(".") }) {
                picker.type = "*/*"
                picker.removeExtra(Intent.EXTRA_MIME_TYPES)
            }
            if (params.mode == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE) {
                picker.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
            }

            pendingCallback = callback
            pendingIntent = picker
            return try {
                val activityIntent = Intent(context, FaceclawFilePickerActivity::class.java)
                if (context !is Activity) activityIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                context.startActivity(activityIntent)
                true
            } catch (error: Exception) {
                Log.w(TAG, "Could not start file picker", error)
                deliver(null)
                true
            }
        }
    }
}
