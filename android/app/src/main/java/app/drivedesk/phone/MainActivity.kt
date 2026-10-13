package app.drivedesk.phone

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.net.VpnService
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Switch
import android.widget.TextView

class MainActivity : Activity() {
    private val slate = Color.parseColor("#1C2733")
    private val panel = Color.parseColor("#243241")
    private val fg = Color.parseColor("#E8EDF2")
    private val muted = Color.parseColor("#8A99A8")
    private val amber = Color.parseColor("#F2A93B")

    private lateinit var status: TextView
    private lateinit var address: TextView
    private lateinit var otherAddress: TextView
    private lateinit var pin: TextView
    private lateinit var startBtn: Button
    private lateinit var touchStatus: TextView
    private lateinit var touchBtn: Button
    private val ui = Handler(Looper.getMainLooper())
    private val tick = object : Runnable { override fun run() { refresh(); ui.postDelayed(this, 1500) } }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = slate

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(24), dp(28), dp(24), dp(32))
            setBackgroundColor(slate)
        }

        root.addView(label("DriveDesk", 15f, muted))
        status = label("", 22f, fg, bold = true).also { it.setPadding(0, dp(8), 0, dp(4)); root.addView(it) }
        address = label("", 24f, amber, bold = true).also { it.setTextIsSelectable(true); root.addView(it) }
        otherAddress = label("", 13f, muted).also { it.setPadding(0, dp(4), 0, 0); root.addView(it) }
        root.addView(label("PIN", 13f, muted).also { it.setPadding(0, dp(18), 0, 0) })
        pin = label("", 44f, amber, bold = true).also { it.letterSpacing = 0.12f; root.addView(it) }

        startBtn = button("Start sharing", primary = true) { toggle() }
        root.addView(startBtn, lp(top = 20))

        root.addView(section("How to connect"))
        root.addView(label(
            "1. Turn on this phone's hotspot (Settings > Hotspot). Use 5 GHz, and turn off Wi-Fi 6 if your phone has that option.\n" +
            "2. On the car screen, connect to that hotspot under Wi-Fi.\n" +
            "3. Tap Start sharing here. The first time, allow the VPN request: it's local-only and lets the car reach this phone.\n" +
            "4. Park, open the car's browser, type the orange address above, and enter the PIN.",
            15f, fg).also { it.setLineSpacing(0f, 1.35f) })

        root.addView(section("Touch control"))
        touchStatus = label("", 15f, muted).also { root.addView(it) }
        touchBtn = button("Turn on touch control") { openAccessibility() }
        root.addView(touchBtn, lp(top = 10))
        if (Build.VERSION.SDK_INT >= 33) {
            root.addView(label(
                "If the switch is greyed out: open App info, tap the ⋮ menu, choose \"Allow restricted settings\", then try again.",
                13f, muted).also { it.setPadding(0, dp(10), 0, 0) })
            root.addView(button("Open App info") {
                startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
            }, lp(top = 8))
        }

        root.addView(section("Tesla connection"))
        root.addView(Switch(this).apply {
            this.text = "Use the Tesla connection (local VPN)"
            setTextColor(fg); textSize = 15f
            isChecked = Prefs.carLink(this@MainActivity)
            setOnCheckedChangeListener { _, v -> Prefs.setCarLink(this@MainActivity, v) }
        })
        root.addView(label(
            "Tesla's browser blocks normal hotspot addresses. This gives the phone an extra address the car accepts. " +
            "No traffic leaves the phone through it and other apps aren't affected. Turn it off only for non-Tesla screens. " +
            "It replaces any other VPN while sharing.",
            13f, muted).also { it.setPadding(0, dp(6), 0, 0) })

        root.addView(section("Quality"))
        root.addView(Switch(this).apply {
            this.text = "Sharper text (uses more Wi-Fi bandwidth)"
            setTextColor(fg); textSize = 15f
            isChecked = Prefs.sharp(this@MainActivity)
            setOnCheckedChangeListener { _, v -> Prefs.setSharp(this@MainActivity, v) }
        })
        root.addView(label("Applies the next time you start sharing.", 13f, muted))

        root.addView(button("New PIN") { Prefs.newPin(this); refresh() }, lp(top = 24))

        setContentView(ScrollView(this).apply { setBackgroundColor(slate); addView(root) })

        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 2)
        }
    }

    override fun onResume() { super.onResume(); ui.post(tick) }
    override fun onPause() { super.onPause(); ui.removeCallbacks(tick) }

    private fun refresh() {
        val addrs = Net.addresses()
        val running = MirrorService.running
        status.text = when {
            !running -> "Not sharing"
            MirrorService.viewers > 0 -> "Sharing to ${MirrorService.viewers} screen" + (if (MirrorService.viewers > 1) "s" else "")
            else -> "Sharing. Open this in the car's browser:"
        }
        if (running && CarTunnelService.active) {
            address.text = CarTunnelService.carUrl
            address.textSize = 22f
            otherAddress.text = if (addrs.isEmpty()) "" else "Phones, tablets, laptops: " + addrs.joinToString("  ") { it.url }
        } else {
            address.text = when {
                addrs.isEmpty() -> "Turn on your hotspot to get an address"
                running -> addrs.joinToString("\n") { it.url }
                else -> "Tap Start sharing to get the car address"
            }
            address.textSize = 18f
            otherAddress.text = if (running && Prefs.carLink(this)) "Tesla connection is off or was not allowed, so a Tesla can't open this address." else ""
        }
        pin.text = Prefs.pin(this)
        startBtn.text = if (running) "Stop sharing" else "Start sharing"

        val touchOn = TouchService.instance != null
        touchStatus.text = if (touchOn) "On. Tap, swipe, pinch, and Back/Home work from the car."
                           else "Off. The car can watch but not control the phone."
        touchBtn.visibility = if (touchOn) View.GONE else View.VISIBLE
    }

    private fun toggle() {
        if (MirrorService.running) {
            startService(Intent(this, MirrorService::class.java).setAction(MirrorService.ACTION_STOP))
            ui.postDelayed({ refresh() }, 300)
            return
        }
        if (Prefs.carLink(this)) {
            val consent = VpnService.prepare(this)
            if (consent != null) { askVpn(consent); return }
            startService(Intent(this, CarTunnelService::class.java))
        }
        requestCapture()
    }

    @Suppress("DEPRECATION")
    private fun askVpn(consent: Intent) = startActivityForResult(consent, 3)

    private fun requestCapture() {
        val mpm = getSystemService(MediaProjectionManager::class.java)!!
        @Suppress("DEPRECATION")
        startActivityForResult(mpm.createScreenCaptureIntent(), 1)
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == 3) {
            // VPN consent: continue to screen capture either way; without it only non-Tesla screens can connect.
            if (resultCode == RESULT_OK) startService(Intent(this, CarTunnelService::class.java))
            requestCapture()
            return
        }
        if (requestCode != 1 || resultCode != RESULT_OK || data == null) {
            if (!MirrorService.running) CarTunnelService.shutdown()
            return
        }
        startForegroundService(Intent(this, MirrorService::class.java)
            .putExtra(MirrorService.EXTRA_CODE, resultCode)
            .putExtra(MirrorService.EXTRA_DATA, data))
        ui.postDelayed({ refresh() }, 500)
    }

    private fun openAccessibility() = startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))

    // ---- tiny view helpers ----
    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()
    private fun lp(top: Int = 0) = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(top) }

    private fun label(s: String, size: Float, color: Int, bold: Boolean = false) = TextView(this).apply {
        text = s; textSize = size; setTextColor(color)
        if (bold) typeface = Typeface.DEFAULT_BOLD
    }

    private fun section(title: String) = label(title, 17f, fg, bold = true).apply {
        setPadding(0, dp(28), 0, dp(8))
    }

    private fun button(s: String, primary: Boolean = false, onClick: () -> Unit) = Button(this).apply {
        text = s; isAllCaps = false; textSize = 17f
        setTextColor(if (primary) slate else fg)
        background = GradientDrawable().apply { cornerRadius = dp(10).toFloat(); setColor(if (primary) amber else panel) }
        minHeight = dp(54)
        gravity = Gravity.CENTER
        setOnClickListener { onClick() }
    }
}
