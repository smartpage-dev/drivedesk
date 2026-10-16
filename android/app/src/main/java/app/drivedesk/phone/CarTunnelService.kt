package app.drivedesk.phone

import android.content.Intent
import android.net.VpnService
import android.os.Build
import android.os.ParcelFileDescriptor
import android.util.Log
import java.io.FileInputStream

/**
 * Tesla's browser refuses private addresses (192.168.x.x, 10.x.x.x, 172.16-31.x.x), which is
 * all a phone hotspot hands out. This local-only VPN gives the phone one extra address outside
 * those ranges. When the car sends traffic to it through the hotspot, Linux delivers it to our
 * web server (which listens on all addresses), because the address belongs to this phone.
 *
 * Nothing is tunnelled anywhere:
 *  - the only route is the virtual address itself (/32), so no other traffic enters the VPN
 *  - only DriveDesk is included in the VPN, so other apps are never affected
 *  - packets that do arrive on the tunnel are read and discarded
 *
 * The same approach is documented by TeslaMirror (virtual IP + local VPN).
 */
class CarTunnelService : VpnService() {
    companion object {
        const val VIRTUAL_IP = "100.99.0.1"   // same address as the desktop hotspot, so the car needs one favourite
        @Volatile var active = false
            private set
        @Volatile private var instance: CarTunnelService? = null

        /** Address to type in the car. A hostname is used because Tesla rejects typed raw IPs. */
        val carUrl: String get() = "http://${VIRTUAL_IP.replace('.', '-')}.sslip.io:$PORT"

        fun shutdown() { instance?.let { it.stopTunnel(); it.stopSelf() } }
    }

    private var tun: ParcelFileDescriptor? = null

    override fun onCreate() { super.onCreate(); instance = this }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (tun == null) startTunnel()
        return START_STICKY
    }

    private fun startTunnel() {
        try {
            val b = Builder()
                .setSession(tr("DriveDesk car link", "DriveDesk 汽車連接"))
                .addAddress(VIRTUAL_IP, 32)
                .addRoute(VIRTUAL_IP, 32)
                .setMtu(1500)
                .setBlocking(true)
            try { b.addAllowedApplication(packageName) } catch (_: Exception) { }
            if (Build.VERSION.SDK_INT >= 29) b.setMetered(false)
            val fd = b.establish() ?: run { Log.w("DriveDesk", "VPN not permitted"); return }
            tun = fd
            active = true
            Thread({
                val input = FileInputStream(fd.fileDescriptor)
                val buf = ByteArray(32767)
                try { while (active) { if (input.read(buf) < 0) break } } catch (_: Exception) { }
            }, "tun-drain").apply { isDaemon = true; start() }
        } catch (e: Exception) {
            Log.e("DriveDesk", "car link failed", e)
            active = false
        }
    }

    fun stopTunnel() {
        active = false
        try { tun?.close() } catch (_: Exception) { }
        tun = null
    }

    override fun onRevoke() { stopTunnel(); stopSelf() } // user turned the VPN off in system settings

    override fun onDestroy() {
        stopTunnel()
        instance = null
        super.onDestroy()
    }
}
