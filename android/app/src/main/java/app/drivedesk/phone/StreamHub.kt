package app.drivedesk.phone

import java.nio.ByteBuffer
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Wire format to the viewer:
 *   text   {"t":"meta","w":W,"h":H}             new stream size (start / rotation)
 *   binary [flags:u8][ptsMicros:u64 BE][H.264 Annex-B bytes]
 *          flags bit0 = codec config (SPS/PPS), bit1 = keyframe
 */
class StreamHub {
    private val clients = CopyOnWriteArrayList<Client>()
    @Volatile private var meta: String? = null
    @Volatile private var config: ByteArray? = null
    @Volatile var encoder: VideoEncoder? = null
    @Volatile private var lastKeyRequest = 0L

    fun count() = clients.size

    fun onNewStream(w: Int, h: Int, enc: VideoEncoder) {
        meta = """{"t":"meta","w":$w,"h":$h}"""
        config = null
        encoder = enc
        for (c in clients) { c.text(meta!!); c.needKey = true }
    }

    fun onConfig(bytes: ByteArray) {
        val pkt = packet(1, 0, bytes)
        config = pkt
        for (c in clients) c.binary(pkt)
    }

    fun onFrame(bytes: ByteArray, ptsUs: Long, key: Boolean) {
        if (clients.isEmpty()) return
        val pkt = packet(if (key) 2 else 0, ptsUs, bytes)
        for (c in clients) {
            if (c.needKey && !key) continue
            if (!c.frame(pkt)) {
                // Viewer fell behind: resend stream header and resume at the next keyframe.
                meta?.let { c.text(it) }
                config?.let { c.binary(it) }
                c.needKey = true
                requestKeyFrame()
            } else if (key) {
                c.needKey = false
            }
        }
    }

    fun add(c: Client) {
        meta?.let { c.text(it) }
        config?.let { c.binary(it) }
        c.needKey = true
        clients.add(c)
        requestKeyFrame()
    }

    fun remove(c: Client) { clients.remove(c) }

    fun closeAll() { for (c in clients) c.close(); clients.clear() }

    fun requestKeyFrame() {
        val now = System.currentTimeMillis()
        if (now - lastKeyRequest < 300) return
        lastKeyRequest = now
        encoder?.requestKeyFrame()
    }

    private fun packet(flags: Int, pts: Long, data: ByteArray): ByteArray =
        ByteBuffer.allocate(9 + data.size).put(flags.toByte()).putLong(pts).put(data).array()
}
