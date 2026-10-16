package app.drivedesk.phone

import android.content.Context
import java.net.Inet4Address
import java.net.NetworkInterface
import java.security.SecureRandom

const val PORT = 8787

/** English or Traditional Chinese, following the phone's language setting. */
fun tr(en: String, zh: String): String = if (java.util.Locale.getDefault().language == "zh") zh else en

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

    /** "phone" or "switch": what the quick-settings tile starts. */
    fun lastMode(ctx: Context) = sp(ctx).getString("lastMode", "phone") ?: "phone"
    fun setLastMode(ctx: Context, v: String) = sp(ctx).edit().putString("lastMode", v).apply()

    fun switchIp(ctx: Context) = sp(ctx).getString("switchIp", "") ?: ""
    fun setSwitchIp(ctx: Context, v: String) = sp(ctx).edit().putString("switchIp", v).apply()

    fun sharp(ctx: Context) = sp(ctx).getBoolean("sharp", true)
    fun setSharp(ctx: Context, v: Boolean) = sp(ctx).edit().putBoolean("sharp", v).apply()
}

data class LanAddress(val iface: String, val ip: String, val likelyHotspot: Boolean) {
    val url get() = "http://$ip:$PORT"
    /** Tesla's browser blocks RFC 1918 ranges; anything else (e.g. a car router set to 198.18.0.x) works directly. */
    val carReachable: Boolean get() {
        val p = ip.split('.').mapNotNull { it.toIntOrNull() }
        if (p.size != 4) return false
        return !(p[0] == 10 || (p[0] == 172 && p[1] in 16..31) || (p[0] == 192 && p[1] == 168) || (p[0] == 169 && p[1] == 254))
    }
    val carUrl get() = "http://${ip.replace('.', '-')}.sslip.io:$PORT"
}

object Net {
    private val hotspotNames = Regex("^(ap|swlan|softap|wlan1|wigig|rndis|bt-pan)", RegexOption.IGNORE_CASE)

    /**
     * What the car should open: this phone's own address if the network uses a range Tesla accepts
     * (no VPN needed), otherwise the local VPN's virtual address if it's running.
     */
    fun carUrl(): String? = addresses().firstOrNull { it.carReachable }?.carUrl
        ?: if (CarTunnelService.active) CarTunnelService.carUrl else null

    /** True when the phone is on a network the car can reach directly, so the VPN is unnecessary. */
    fun directCarNetwork(): Boolean = addresses().any { it.carReachable }

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
