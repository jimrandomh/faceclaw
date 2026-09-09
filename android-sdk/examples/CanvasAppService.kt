package example.faceclaw

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import com.faceclaw.sdk.FaceclawAppService
import com.faceclaw.sdk.Ui
import com.faceclaw.sdk.HostEvent
import com.faceclaw.sdk.WindowState

/** Copy into an Android app and declare the SDK service contract from the README. */
class CanvasAppService : FaceclawAppService() {
    private val window = WindowState()
    private var clicks = 0

    override fun onHostEvent(event: HostEvent) {
        window.accept(event)
        if (event is HostEvent.Input && window.canDraw() && event.isClick()) clicks++
        draw()
    }

    override fun onHostDisconnected() { window.disconnect() }

    private fun draw() {
        if (!window.canDraw()) return
        val width = window.width()
        val height = window.height()
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
