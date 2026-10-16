package app.drivedesk.phone

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Point
import android.graphics.drawable.Icon
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import android.view.Display
import org.json.JSONObject
import kotlin.math.max
import kotlin.math.min

class MirrorService : Service() {
    companion object {
        const val ACTION_STOP = "app.drivedesk.phone.STOP"
        const val EXTRA_CODE = "code"
        const val EXTRA_DATA = "data"
        @Volatile var running = false
            private set
        @Volatile private var hubRef: StreamHub? = null
        val viewers: Int get() = hubRef?.count() ?: 0
    }

    private val hub = StreamHub()
    private var server: WebServer? = null
    private var projection: MediaProjection? = null
    private var virtualDisplay: VirtualDisplay? = null
    private var encoder: VideoEncoder? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private val thread = HandlerThread("mirror").apply { start() }
    private val handler = Handler(thread.looper)
    private val displays by lazy { getSystemService(DisplayManager::class.java)!! }

    private val displayListener = object : DisplayManager.DisplayListener {
        override fun onDisplayAdded(id: Int) {}
        override fun onDisplayRemoved(id: Int) {}
        override fun onDisplayChanged(id: Int) {
            if (id != Display.DEFAULT_DISPLAY) return
            val r = realSize()
            val enc = encoder ?: return
            // Phone rotated: rebuild the encoder at the new orientation.
            if ((r.x > r.y) != (enc.width > enc.height)) handler.post { startCapture() }
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) { stopSelf(); return START_NOT_STICKY }
        if (running) return START_NOT_STICKY

        // Must be a foreground service of type mediaProjection *before* getMediaProjection (Android 14+).
        startForegroundCompat()

        val code = intent?.getIntExtra(EXTRA_CODE, 0) ?: 0
        val data: Intent? = if (Build.VERSION.SDK_INT >= 33) intent?.getParcelableExtra(EXTRA_DATA, Intent::class.java)
                            else @Suppress("DEPRECATION") intent?.getParcelableExtra(EXTRA_DATA)
        if (data == null) { stopSelf(); return START_NOT_STICKY }

        val mpm = getSystemService(MediaProjectionManager::class.java)!!
        val mp = mpm.getMediaProjection(code, data) ?: run { stopSelf(); return START_NOT_STICKY }
        mp.registerCallback(object : MediaProjection.Callback() {
            override fun onStop() { stopSelf() } // user tapped "Stop sharing" in the system UI
        }, handler)
        projection = mp

        server = WebServer(this, hub, { msg, client -> onControl(msg, client) }).also {
            try { it.start() } catch (e: Exception) { Log.e("DriveDesk", "server failed", e); stopSelf(); return START_NOT_STICKY }
        }

        @Suppress("DEPRECATION")
        wakeLock = getSystemService(PowerManager::class.java)!!
            .newWakeLock(PowerManager.SCREEN_DIM_WAKE_LOCK or PowerManager.ON_AFTER_RELEASE, "DriveDesk:mirror")
            .apply { acquire(6 * 60 * 60 * 1000L) } // screen must stay on to be mirrored

        handler.post { startCapture() }
        displays.registerDisplayListener(displayListener, handler)
        hubRef = hub
        running = true
        return START_NOT_STICKY
    }

    @Suppress("DEPRECATION")
    private fun realSize(): Point = Point().also { displays.getDisplay(Display.DEFAULT_DISPLAY).getRealSize(it) }

    /** Creates (or rebuilds after rotation) the encoder, then points the mirror display at it. */
    private fun startCapture() {
        val mp = projection ?: return
        val r = realSize()
        val sharp = Prefs.sharp(this)
        val bitrate = if (sharp) 10_000_000 else 6_000_000
        val maxSides = if (sharp) intArrayOf(1920, 1600, 1280, 1024, 800) else intArrayOf(1280, 1024, 800)

        var enc: VideoEncoder? = null
        for (maxLong in maxSides) {
            val scale = min(1.0, maxLong.toDouble() / max(r.x, r.y))
            val w = ((r.x * scale).toInt() / 16) * 16
            val h = ((r.y * scale).toInt() / 16) * 16
            try {
                enc = VideoEncoder(w, h, bitrate, 60, hub).also { it.start() }
                break
            } catch (e: Exception) {
                Log.w("DriveDesk", "encoder ${w}x$h failed", e)
            }
        }
        if (enc == null) { stopSelf(); return }

        val dpi = resources.displayMetrics.densityDpi
        val vd = virtualDisplay
        if (vd == null) {
            // Android 14+ allows only one virtual display per projection, so we keep it and resize later.
            virtualDisplay = mp.createVirtualDisplay("DriveDesk", enc.width, enc.height, dpi,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, enc.surface, null, handler)
        } else {
            vd.resize(enc.width, enc.height, dpi)
            vd.surface = enc.surface
        }
        val old = encoder
        encoder = enc
        old?.stop()
    }

    private fun onControl(msg: JSONObject, client: Client) {
        when (msg.optString("t")) {
            "key-request" -> hub.requestKeyFrame()
            "ping" -> client.text("""{"t":"caps","touch":${TouchService.instance != null}}""")
            else -> TouchService.instance?.handle(msg, realSize())
        }
    }

    private fun startForegroundCompat() {
        val nm = getSystemService(NotificationManager::class.java)!!
        nm.createNotificationChannel(NotificationChannel("mirror", tr("Screen sharing", "螢幕分享"), NotificationManager.IMPORTANCE_LOW))
        val stop = PendingIntent.getService(this, 1, Intent(this, MirrorService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val open = PendingIntent.getActivity(this, 2, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val addr = Net.carUrl() ?: Net.addresses().firstOrNull()?.url ?: tr("Turn on your hotspot", "請開啟熱點")
        val n = Notification.Builder(this, "mirror")
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle(tr("Sharing screen to your car", "正在分享螢幕到汽車"))
            .setContentText("$addr  " + tr("PIN", "PIN 碼") + " ${Prefs.pin(this)}")
            .setContentIntent(open)
            .setOngoing(true)
            .addAction(Notification.Action.Builder(Icon.createWithResource(this, R.drawable.ic_stat), tr("Stop", "停止"), stop).build())
            .build()
        if (Build.VERSION.SDK_INT >= 29) startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
        else startForeground(1, n)
    }

    override fun onDestroy() {
        running = false
        hubRef = null
        try { displays.unregisterDisplayListener(displayListener) } catch (_: Exception) { }
        hub.closeAll()
        server?.stop()
        encoder?.stop()
        virtualDisplay?.release()
        projection?.stop()
        CarTunnelService.shutdown()
        try { wakeLock?.release() } catch (_: Exception) { }
        thread.quitSafely()
        super.onDestroy()
    }
}
