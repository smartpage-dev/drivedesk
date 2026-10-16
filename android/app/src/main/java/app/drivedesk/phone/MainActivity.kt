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
import android.widget.EditText
import android.text.InputType
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Switch
import android.widget.TextView

class MainActivity : Activity() {
    companion object { const val EXTRA_AUTOSTART = "autostart" }

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
    private lateinit var switchIp: EditText
    private lateinit var switchBtn: Button
    private lateinit var switchStatus: TextView
    private var afterVpn: (() -> Unit)? = null
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
        root.addView(label(tr("PIN", "PIN 碼"), 13f, muted).also { it.setPadding(0, dp(18), 0, 0) })
        pin = label("", 44f, amber, bold = true).also { it.letterSpacing = 0.12f; root.addView(it) }

        startBtn = button(tr("Start sharing", "開始分享"), primary = true) { toggle() }
        root.addView(startBtn, lp(top = 20))

        root.addView(section(tr("How to connect", "如何連接")))
        root.addView(label(tr(
            "1. Turn on this phone's hotspot (Settings > Hotspot). Use 5 GHz, and turn off Wi-Fi 6 if your phone has that option.\n" +
            "2. On the car screen, connect to that hotspot under Wi-Fi.\n" +
            "3. Tap Start sharing here. The first time, allow the VPN request: it's local-only and lets the car reach this phone.\n" +
            "4. Park, open the car's browser, type the orange address above, and enter the PIN.",
            "1. 開啟這部手機的熱點（設定 > 熱點）。請用 5 GHz；如手機有 Wi-Fi 6 選項，請關閉。\n" +
            "2. 在汽車螢幕的 Wi-Fi 設定中連接該熱點。\n" +
            "3. 在這裡按「開始分享」。第一次使用時請允許 VPN 要求：它只在本機運作，讓汽車可以連接這部手機。\n" +
            "4. 泊好車，開啟汽車瀏覽器，輸入上方的橙色地址，再輸入 PIN 碼。"),
            15f, fg).also { it.setLineSpacing(0f, 1.35f) })

        root.addView(section(tr("Touch control", "觸控控制")))
        touchStatus = label("", 15f, muted).also { root.addView(it) }
        touchBtn = button(tr("Turn on touch control", "開啟觸控控制")) { openAccessibility() }
        root.addView(touchBtn, lp(top = 10))
        if (Build.VERSION.SDK_INT >= 33) {
            root.addView(label(
                tr("If the switch is greyed out: open App info, tap the ⋮ menu, choose \"Allow restricted settings\", then try again.",
                   "如開關呈灰色：開啟「應用程式資料」，按 ⋮ 選單，選擇「允許受限制的設定」，然後再試。"),
                13f, muted).also { it.setPadding(0, dp(10), 0, 0) })
            root.addView(button(tr("Open App info", "開啟應用程式資料")) {
                startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
            }, lp(top = 8))
        }

        root.addView(section("Nintendo Switch"))
        root.addView(label(tr(
            "Shows a Switch running SysDVR (custom firmware) on the car screen. In SysDVR Settings on the Switch, " +
            "choose Simple network mode, then connect the Switch to this phone's hotspot and start a game.",
            "在汽車螢幕顯示運行 SysDVR（自製韌體）的 Switch。請在 Switch 的 SysDVR Settings 選擇 Simple network mode，" +
            "然後把 Switch 連接到這部手機的熱點，再開始遊戲。"),
            13f, muted))
        switchIp = EditText(this).apply {
            hint = tr("Switch IP address, e.g. 192.168.43.120", "Switch 的 IP 地址，例如 192.168.43.120")
            setText(Prefs.switchIp(this@MainActivity))
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            setTextColor(fg); setHintTextColor(muted); textSize = 17f
        }
        root.addView(switchIp, lp(top = 8))
        root.addView(button(tr("Find my Switch", "尋找我的 Switch")) { findSwitch() }, lp(top = 8))
        switchBtn = button(tr("Stream Switch to car", "串流 Switch 到汽車"), primary = true) { toggleSwitch() }
        root.addView(switchBtn, lp(top = 8))
        switchStatus = label("", 13f, muted).also { it.setPadding(0, dp(6), 0, 0); root.addView(it) }

        root.addView(section(tr("Tesla connection", "Tesla 連接")))
        root.addView(Switch(this).apply {
            this.text = tr("Use the Tesla connection (local VPN)", "使用 Tesla 連接（本機 VPN）")
            setTextColor(fg); textSize = 15f
            isChecked = Prefs.carLink(this@MainActivity)
            setOnCheckedChangeListener { _, v -> Prefs.setCarLink(this@MainActivity, v) }
        })
        root.addView(label(tr(
            "Tesla's browser blocks normal hotspot addresses. This gives the phone an extra address the car accepts. " +
            "No traffic leaves the phone through it and other apps aren't affected. Turn it off only for non-Tesla screens. " +
            "It replaces any other VPN while sharing.",
            "Tesla 瀏覽器會封鎖一般熱點地址。此功能為手機加入一個汽車接受的額外地址，" +
            "不會經它把任何數據傳出手機，亦不影響其他 app。只有在非 Tesla 螢幕使用時才需關閉。分享期間會取代其他 VPN。"),
            13f, muted).also { it.setPadding(0, dp(6), 0, 0) })

        root.addView(section(tr("Quality", "畫質")))
        root.addView(Switch(this).apply {
            this.text = tr("Sharper text (uses more Wi-Fi bandwidth)", "更清晰的文字（使用更多 Wi-Fi 頻寬）")
            setTextColor(fg); textSize = 15f
            isChecked = Prefs.sharp(this@MainActivity)
            setOnCheckedChangeListener { _, v -> Prefs.setSharp(this@MainActivity, v) }
        })
        root.addView(label(tr("Applies the next time you start sharing.", "下次開始分享時生效。"), 13f, muted))

        root.addView(button(tr("New PIN", "更換 PIN 碼")) { Prefs.newPin(this); refresh() }, lp(top = 24))

        setContentView(ScrollView(this).apply { setBackgroundColor(slate); addView(root) })

        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 2)
        }
        handleAutostart(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleAutostart(intent)
    }

    /** Started from the quick-settings tile: repeat whatever was used last. */
    private fun handleAutostart(i: Intent?) {
        if (i == null || !i.getBooleanExtra(EXTRA_AUTOSTART, false)) return
        i.removeExtra(EXTRA_AUTOSTART)
        if (MirrorService.running || SwitchRelayService.running) return
        ui.post { if (Prefs.lastMode(this) == "switch" && Prefs.switchIp(this).isNotEmpty()) toggleSwitch() else toggle() }
    }

    override fun onResume() { super.onResume(); ui.post(tick) }
    override fun onPause() { super.onPause(); ui.removeCallbacks(tick) }

    private fun refresh() {
        val addrs = Net.addresses()
        val switching = SwitchRelayService.running
        val running = MirrorService.running || switching
        val viewers = MirrorService.viewers + SwitchRelayService.viewers
        status.text = when {
            !running -> tr("Not sharing", "未在分享")
            switching && viewers > 0 -> tr("Streaming Switch to $viewers screen" + (if (viewers > 1) "s" else ""), "正在串流 Switch 到 $viewers 個螢幕")
            switching -> tr("Streaming Switch. Open this in the car's browser:", "正在串流 Switch。請在汽車瀏覽器開啟：")
            MirrorService.viewers > 0 -> tr("Sharing to ${MirrorService.viewers} screen" + (if (MirrorService.viewers > 1) "s" else ""), "正在分享到 ${MirrorService.viewers} 個螢幕")
            else -> tr("Sharing. Open this in the car's browser:", "正在分享。請在汽車瀏覽器開啟：")
        }
        val carUrl = Net.carUrl()
        if (running && carUrl != null) {
            address.text = carUrl
            address.textSize = 22f
            val others = addrs.filter { !it.carReachable }
            otherAddress.text = when {
                Net.directCarNetwork() -> tr("This network uses addresses Tesla accepts, so no VPN is needed.", "此網絡使用 Tesla 接受的地址，無需 VPN。")
                others.isEmpty() -> ""
                else -> tr("Phones, tablets, laptops: ", "手機、平板、電腦：") + others.joinToString("  ") { it.url }
            }
        } else {
            address.text = when {
                addrs.isEmpty() -> tr("Turn on your hotspot to get an address", "請開啟熱點以取得地址")
                running -> addrs.joinToString("\n") { it.url }
                else -> tr("Tap Start sharing to get the car address", "按「開始分享」以取得車用地址")
            }
            address.textSize = 18f
            otherAddress.text = if (running && Prefs.carLink(this)) tr("Tesla connection is off or was not allowed, so a Tesla can't open this address.", "Tesla 連接已關閉或未獲允許，Tesla 無法開啟此地址。") else ""
        }
        pin.text = Prefs.pin(this)
        startBtn.text = if (MirrorService.running) tr("Stop sharing", "停止分享") else tr("Start sharing", "開始分享")
        startBtn.isEnabled = !switching
        switchBtn.text = if (switching) tr("Stop Switch stream", "停止串流 Switch") else tr("Stream Switch to car", "串流 Switch 到汽車")
        switchBtn.isEnabled = !MirrorService.running
        if (switching) switchStatus.text = SwitchRelayService.status

        val touchOn = TouchService.instance != null
        touchStatus.text = if (touchOn) tr("On. Tap, swipe, pinch, and Back/Home work from the car.", "已開啟。可在汽車上點按、滑動、縮放，以及使用返回／主畫面。")
                           else tr("Off. The car can watch but not control the phone.", "已關閉。汽車只能觀看，不能控制手機。")
        touchBtn.visibility = if (touchOn) View.GONE else View.VISIBLE
    }

    private fun toggle() {
        if (MirrorService.running) {
            startService(Intent(this, MirrorService::class.java).setAction(MirrorService.ACTION_STOP))
            ui.postDelayed({ refresh() }, 300)
            return
        }
        Prefs.setLastMode(this, "phone")
        withCarLink { requestCapture() }
    }

    /** Starts the Tesla connection first (asking for VPN consent once), then runs [then]. */
    private fun withCarLink(then: () -> Unit) {
        if (Prefs.carLink(this) && !Net.directCarNetwork()) {
            val consent = VpnService.prepare(this)
            if (consent != null) { afterVpn = then; askVpn(consent); return }
            startService(Intent(this, CarTunnelService::class.java))
        }
        then()
    }

    private fun toggleSwitch() {
        if (SwitchRelayService.running) {
            startService(Intent(this, SwitchRelayService::class.java).setAction(SwitchRelayService.ACTION_STOP))
            switchStatus.text = ""
            ui.postDelayed({ refresh() }, 300)
            return
        }
        val ip = switchIp.text.toString().trim()
        if (!Regex("^\\d{1,3}(\\.\\d{1,3}){3}$").matches(ip)) {
            switchStatus.text = tr("Enter the Switch's IP address, or tap Find my Switch.", "請輸入 Switch 的 IP 地址，或按「尋找我的 Switch」。")
            return
        }
        Prefs.setSwitchIp(this, ip)
        Prefs.setLastMode(this, "switch")
        withCarLink {
            startForegroundService(Intent(this, SwitchRelayService::class.java).putExtra(SwitchRelayService.EXTRA_IP, ip))
            ui.postDelayed({ refresh() }, 500)
        }
    }

    private fun findSwitch() {
        switchStatus.text = tr("Searching the hotspot for a Switch running SysDVR…", "正在熱點中尋找運行 SysDVR 的 Switch…")
        Thread {
            val ip = SwitchRelayService.findSwitch()
            ui.post {
                if (ip != null) { switchIp.setText(ip); Prefs.setSwitchIp(this, ip); switchStatus.text = tr("Found a Switch at $ip.", "已找到 Switch：$ip。") }
                else switchStatus.text = tr("No Switch found. Check it's on this hotspot, SysDVR is in Simple network mode, and a game is running.",
                                       "找不到 Switch。請確認它已連接此熱點、SysDVR 設為 Simple network mode，並且遊戲正在運行。")
            }
        }.start()
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
            // VPN consent: continue either way; without it only non-Tesla screens can connect.
            if (resultCode == RESULT_OK) startService(Intent(this, CarTunnelService::class.java))
            val next = afterVpn; afterVpn = null
            next?.invoke()
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
