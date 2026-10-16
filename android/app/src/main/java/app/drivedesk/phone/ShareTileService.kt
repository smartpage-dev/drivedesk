package app.drivedesk.phone

import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService

/**
 * Quick Settings tile: one tap in the notification shade starts or stops DriveDesk,
 * using whichever mode (phone screen or Nintendo Switch) was used last.
 */
class ShareTileService : TileService() {
    override fun onStartListening() { update() }

    override fun onClick() {
        if (MirrorService.running || SwitchRelayService.running) {
            if (MirrorService.running) startService(Intent(this, MirrorService::class.java).setAction(MirrorService.ACTION_STOP))
            if (SwitchRelayService.running) startService(Intent(this, SwitchRelayService::class.java).setAction(SwitchRelayService.ACTION_STOP))
            qsTile?.let { it.state = Tile.STATE_INACTIVE; it.updateTile() }
            return
        }
        // Starting needs the app's screen for the Android consent prompts.
        val open = Intent(this, MainActivity::class.java)
            .putExtra(MainActivity.EXTRA_AUTOSTART, true)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        if (Build.VERSION.SDK_INT >= 34) {
            startActivityAndCollapse(PendingIntent.getActivity(this, 5, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
        } else {
            @Suppress("DEPRECATION")
            startActivityAndCollapse(open)
        }
    }

    private fun update() {
        val tile = qsTile ?: return
        val on = MirrorService.running || SwitchRelayService.running
        tile.state = if (on) Tile.STATE_ACTIVE else Tile.STATE_INACTIVE
        tile.label = "DriveDesk"
        if (Build.VERSION.SDK_INT >= 29) tile.subtitle = when {
            SwitchRelayService.running -> "Switch"
            MirrorService.running -> tr("Sharing", "分享中")
            else -> tr("Off", "關閉")
        }
        tile.updateTile()
    }
}
