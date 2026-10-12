package app.drivedesk.phone

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.Intent
import android.graphics.Path
import android.graphics.Point
import android.os.Handler
import android.os.Looper
import android.view.accessibility.AccessibilityEvent
import org.json.JSONArray
import org.json.JSONObject

/**
 * Optional. When enabled in Settings > Accessibility, taps and swipes from the car screen are
 * replayed on the phone with dispatchGesture(). It never reads screen content.
 *
 * Messages (coordinates normalized 0..1):
 *   {t:"tap",x,y}  {t:"long",x,y}  {t:"swipe",p:[[x,y],...],ms}
 *   {t:"multi",p:[[[x,y],...],[[x,y],...]],ms}   (pinch / two-finger)
 *   {t:"key",k:"back"|"home"|"recents"|"notifications"}
 */
class TouchService : AccessibilityService() {
    companion object {
        @Volatile var instance: TouchService? = null
            private set
    }

    private val main = Handler(Looper.getMainLooper())

    override fun onServiceConnected() { instance = this }
    override fun onUnbind(intent: Intent?): Boolean { instance = null; return super.onUnbind(intent) }
    override fun onDestroy() { instance = null; super.onDestroy() }
    override fun onAccessibilityEvent(event: AccessibilityEvent?) {}
    override fun onInterrupt() {}

    fun handle(msg: JSONObject, screen: Point) {
        main.post {
            when (msg.optString("t")) {
                "tap" -> gesture(listOf(listOf(pt(msg.optDouble("x"), msg.optDouble("y"), screen))), 40)
                "long" -> gesture(listOf(listOf(pt(msg.optDouble("x"), msg.optDouble("y"), screen))), 700)
                "swipe" -> gesture(listOf(path(msg.optJSONArray("p"), screen)), msg.optLong("ms", 200))
                "multi" -> {
                    val paths = msg.optJSONArray("p") ?: return@post
                    val strokes = (0 until minOf(paths.length(), 2)).map { path(paths.optJSONArray(it), screen) }
                    gesture(strokes, msg.optLong("ms", 300))
                }
                "key" -> when (msg.optString("k")) {
                    "back" -> performGlobalAction(GLOBAL_ACTION_BACK)
                    "home" -> performGlobalAction(GLOBAL_ACTION_HOME)
                    "recents" -> performGlobalAction(GLOBAL_ACTION_RECENTS)
                    "notifications" -> performGlobalAction(GLOBAL_ACTION_NOTIFICATIONS)
                }
            }
        }
    }

    private fun pt(nx: Double, ny: Double, s: Point): FloatArray {
        val x = (if (nx.isNaN()) 0.5 else nx).coerceIn(0.0, 1.0) * (s.x - 1)
        val y = (if (ny.isNaN()) 0.5 else ny).coerceIn(0.0, 1.0) * (s.y - 1)
        return floatArrayOf(x.toFloat(), y.toFloat())
    }

    private fun path(arr: JSONArray?, s: Point): List<FloatArray> {
        if (arr == null || arr.length() == 0) return listOf(pt(0.5, 0.5, s))
        return (0 until arr.length()).mapNotNull { i ->
            val p = arr.optJSONArray(i) ?: return@mapNotNull null
            pt(p.optDouble(0), p.optDouble(1), s)
        }
    }

    private fun gesture(strokes: List<List<FloatArray>>, durationMs: Long) {
        val ms = durationMs.coerceIn(20, 5000)
        val b = GestureDescription.Builder()
        for (pts in strokes) {
            if (pts.isEmpty()) continue
            val p = Path().apply {
                moveTo(pts[0][0], pts[0][1])
                for (i in 1 until pts.size) lineTo(pts[i][0], pts[i][1])
            }
            b.addStroke(GestureDescription.StrokeDescription(p, 0, ms))
        }
        try { dispatchGesture(b.build(), null, null) } catch (_: Exception) { }
    }
}
