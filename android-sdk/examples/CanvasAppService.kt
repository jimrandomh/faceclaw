package example.faceclaw

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import com.faceclaw.sdk.FaceclawAppService
import com.faceclaw.sdk.Ui
import org.json.JSONObject

/** Copy into an Android app and declare the SDK service contract from the README. */
class CanvasAppService : FaceclawAppService() {
    private var width = 0
    private var height = 0
    private var visible = false
    private var screenOn = true
    private var clicks = 0

    override fun onHostEvent(type: String, data: JSONObject) {
        when (type) {
            "open", "resize" -> {
                width = data.getInt("width")
                height = data.getInt("height")
            }
            "visibility" -> {
                visible = data.getBoolean("visible")
                screenOn = data.getBoolean("screenOn")
            }
            "input" -> if (data.optString("type") == "click") clicks++
            "close" -> visible = false
        }
        draw()
    }

    override fun onHostDisconnected() {
        visible = false
        width = 0
        height = 0
    }

    private fun draw() {
        if (!visible || !screenOn || width <= 0 || height <= 0) return
        val frame = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        try {
            val canvas = Canvas(frame)
            canvas.drawColor(Color.BLACK)
            // Faceclaw helpers and ordinary Android drawing share the same canvas.
            Ui.card(canvas, 12f, 12f, width - 12f, height - 12f, 6f, Color.DKGRAY)
            Ui.text(canvas, "Hello from an APK", 26f, 42f, 18f, Color.WHITE)
            Ui.text(canvas, "Clicks: $clicks", 26f, 72f, 16f, Color.WHITE)
            canvas.drawCircle(width - 42f, height - 42f, 12f,
                Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE })
            submitBitmap(frame) // The SDK copies synchronously; the app owns the bitmap.
        } finally {
            frame.recycle()
        }
    }
}
