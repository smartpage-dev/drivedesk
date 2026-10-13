package app.drivedesk.phone

import android.content.Context
import java.net.Inet4Address
import java.net.NetworkInterface
import java.security.SecureRandom

const val PORT = 8787

object Prefs {
    private fun sp(ctx: Context) = ctx.getSharedPreferences("drivedesk", Context.MODE_PRIVATE)

    /** 6-digit PIN, created once and kept so the car can remember it. */
    fun pin(ctx: Context): String {
        val p = sp(ctx).getString("pin", null)
        if (p != null) return p
        return newPin(ctx)
    }

    fun newPin(ctx: Context): String {
        val p = String.format("%06d", SecureRandom().nextInt(1_000_000))
        sp(ctx).edit().putString("pin", p).apply()
        return p
    }

    /** Tesla connection (local VPN with a virtual address). On by default; other browsers don't need it. */
    fun carLink(ctx: Context) = sp(ctx).getBoolean("carLink", true)
    fun setCarLink(ctx: Context, v: Boolean) = sp(ctx).edit().putBoolean("carLink", v).apply()

    fun sharp(ctx: Context) = sp(ctx).getBoolean("sharp", true)
    fun setSharp(ctx: Context, v: Boolean) = sp(ctx).edit().putBoolean("sharp", v).apply()
}

data class LanAddress(val iface: String, val ip: String, val likelyHotspot: Boolean) {
    val url get() = "http://$ip:$PORT"
}

object Net {
    private val hotspotNames = Regex("^(ap|swlan|softap|wlan1|wigig|rndis|bt-pan)", RegexOption.IGNORE_CASE)

    /** Every IPv4 address on this phone, hotspot interfaces first. */
    fun addresses(): List<LanAddress> {
        val out = mutableListOf<LanAddress>()
        try {
            for (ni in NetworkInterface.getNetworkInterfaces()) {
                if (!ni.isUp || ni.isLoopback) continue
                if (ni.name.startsWith("rmnet") || ni.name.startsWith("ccmni") || ni.name.startsWith("dummy")) continue // mobile data, not reachable
                if (ni.name.startsWith("tun") || ni.name.startsWith("ppp") || ni.name.startsWith("ipsec")) continue // VPN interfaces (incl. our car link)
                for (a in ni.inetAddresses) {
                    if (a is Inet4Address && !a.isLoopbackAddress) {
                        out += LanAddress(ni.name, a.hostAddress ?: continue, hotspotNames.containsMatchIn(ni.name))
                    }
                }
            }
        } catch (_: Exception) { }
        return out.sortedByDescending { it.likelyHotspot }
    }
}
