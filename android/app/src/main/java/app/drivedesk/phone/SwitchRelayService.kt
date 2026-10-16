package app.drivedesk.phone

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.drawable.Icon
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import java.net.InetSocketAddress
import java.net.Socket
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * Nintendo Switch mode: the phone only relays. It receives the Switch's video (SysDVR) over
 * the hotspot and serves it to the car with the same viewer page used for phone mirroring.
 * No screen capture is involved, so the phone's own screen can be off.
 */
class SwitchRelayService : Service() {
    companion object {
        const val EXTRA_IP = "ip"
        const val ACTION_STOP = "app.drivedesk.phone.SWITCH_STOP"
        @Volatile var running = false
            private set
        @Volatile var status = ""
            private set
        @Volatile private var hubRef: StreamHub? = null
        val viewers: Int get() = hubRef?.count() ?: 0

        /** Looks for SysDVR's RTSP port on every address in this phone's hotspot networks. */
        fun findSwitch(): String? {
            val bases = Net.addresses().filter { it.likelyHotspot }.ifEmpty { Net.addresses() }
                .map { it.ip.substringBeforeLast('.') }.distinct()
            val found = AtomicReference<String?>(null)
            val pool = Executors.newFixedThreadPool(48)
            for (base in bases) for (i in 1..254) {
                val ip = "$base.$i"
                pool.execute {
                    if (found.get() != null) return@execute
                    try { Socket().use { it.connect(InetSocketAddress(ip, SwitchSource.PORT), 350); found.compareAndSet(null, ip) } }
                    catch (_: Exception) { }
                }
            }
            pool.shutdown()
            pool.awaitTermination(15, TimeUnit.SECONDS)
            return found.get()
        }
    }

    private val hub = StreamHub()
    private var server: WebServer? = null
    private var source: SwitchSource? = null
    private var wakeLock: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) { stopSelf(); return START_NOT_STICKY }
        if (running) return START_NOT_STICKY
        val ip = intent?.getStringExtra(EXTRA_IP)?.trim().orEmpty()
        startForegroundCompat(ip)
        if (ip.isEmpty()) { stopSelf(); return START_NOT_STICKY }

        server = WebServer(this, hub, { msg, client ->
            when (msg.optString("t")) {
                "ping" -> client.text("""{"t":"caps","touch":false,"source":"switch"}""")
                "audio" -> { client.wantsAudio = msg.optBoolean("on", false) }
                else -> {}
            }
        }, source = "switch").also {
            try { it.start() } catch (e: Exception) { Log.e("DriveDesk", "server failed", e); status = tr("Port $PORT is busy. Stop phone sharing first.", "連接埠 $PORT 已被佔用，請先停止手機分享。"); stopSelf(); return START_NOT_STICKY }
        }
        wakeLock = getSystemService(PowerManager::class.java)!!
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "DriveDesk:switch")
            .apply { acquire(6 * 60 * 60 * 1000L) }
        source = SwitchSource(ip, hub) { status = it }.also { it.start() }
        hubRef = hub
        running = true
        return START_NOT_STICKY
    }

    private fun startForegroundCompat(ip: String) {
        val nm = getSystemService(NotificationManager::class.java)!!
        nm.createNotificationChannel(NotificationChannel("switch", tr("Switch streaming", "Switch 串流"), NotificationManager.IMPORTANCE_LOW))
        val stop = PendingIntent.getService(this, 3, Intent(this, SwitchRelayService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val open = PendingIntent.getActivity(this, 4, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val addr = Net.carUrl() ?: Net.addresses().firstOrNull()?.url ?: ""
        val n = Notification.Builder(this, "switch")
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle(tr("Streaming Switch ($ip) to your car", "正在串流 Switch（$ip）到汽車"))
            .setContentText("$addr  " + tr("PIN", "PIN 碼") + " ${Prefs.pin(this)}")
            .setContentIntent(open)
            .setOngoing(true)
            .addAction(Notification.Action.Builder(Icon.createWithResource(this, R.drawable.ic_stat), tr("Stop", "停止"), stop).build())
            .build()
        if (Build.VERSION.SDK_INT >= 29) startForeground(2, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
        else startForeground(2, n)
    }

    override fun onDestroy() {
        running = false
        hubRef = null
        source?.stop()
        hub.closeAll()
        server?.stop()
        CarTunnelService.shutdown()
        try { wakeLock?.release() } catch (_: Exception) { }
        super.onDestroy()
    }
}
