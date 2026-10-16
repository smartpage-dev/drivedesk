package app.drivedesk.phone

import android.util.Base64
import android.util.Log
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.Socket

/**
 * Receives a Nintendo Switch's game video from the SysDVR homebrew sysmodule
 * ("Simple network mode", an RTSP server on port 6666) and pushes it into [StreamHub].
 *
 * Standard protocols only: RTSP (RFC 2326) with RTP interleaved over TCP, and the
 * H.264 RTP payload format (RFC 6184: single NAL, STAP-A, FU-A). The Switch already
 * encodes H.264, so frames are passed to the car without re-encoding.
 */
class SwitchSource(
    private val host: String,
    private val hub: StreamHub,
    private val onStatus: (String) -> Unit
) : KeySource {
    companion object {
        const val PORT = 6666
        private val START = byteArrayOf(0, 0, 0, 1)
    }

    @Volatile private var running = false
    private var thread: Thread? = null
    private var socket: Socket? = null

    fun start() {
        running = true
        thread = Thread({ loop() }, "switch-rtsp").apply { start() }
    }

    fun stop() {
        running = false
        try { socket?.close() } catch (_: Exception) { }
        thread?.interrupt()
    }

    /** SysDVR's encoder decides keyframe timing; new viewers wait for the next one. */
    override fun requestKeyFrame() {}

    private fun loop() {
        while (running) {
            try {
                onStatus(tr("Connecting to Switch at $host…", "正在連接 Switch（$host）…"))
                session()
            } catch (e: Exception) {
                if (!running) break
                Log.w("DriveDesk", "switch stream", e)
                onStatus(tr("Can't reach the Switch (${e.message ?: "error"}). Retrying…", "無法連接 Switch（${e.message ?: "錯誤"}），正在重試…"))
            }
            try { Thread.sleep(2000) } catch (_: InterruptedException) { break }
        }
    }

    // ---------------------------------------------------------------- RTSP
    private var cseq = 0
    private lateinit var out: OutputStream
    private lateinit var input: DataInputStream

    private class Response(val status: Int, val headers: Map<String, String>, val body: String)

    @Synchronized
    private fun send(method: String, url: String, extra: String = ""): Int {
        cseq++
        val req = "$method $url RTSP/1.0\r\nCSeq: $cseq\r\nUser-Agent: DriveDesk\r\n$extra\r\n"
        out.write(req.toByteArray()); out.flush()
        return cseq
    }

    private fun readLine(): String {
        val sb = StringBuilder()
        while (true) {
            val c = input.read()
            if (c < 0) throw java.io.EOFException("Switch closed the connection")
            if (c == '\n'.code) return sb.toString().trimEnd('\r')
            sb.append(c.toChar())
            if (sb.length > 8192) throw IllegalStateException("bad RTSP line")
        }
    }

    /** Reads an RTSP response whose first byte ('R') has already been consumed if [firstByte] is set. */
    private fun readResponse(firstByte: Int? = null): Response {
        val statusLine = (firstByte?.toChar()?.toString() ?: "") + readLine()
        val status = statusLine.split(" ").getOrNull(1)?.toIntOrNull() ?: 0
        val headers = mutableMapOf<String, String>()
        while (true) {
            val l = readLine()
            if (l.isEmpty()) break
            val i = l.indexOf(':')
            if (i > 0) headers[l.substring(0, i).trim().lowercase()] = l.substring(i + 1).trim()
        }
        val len = headers["content-length"]?.toIntOrNull() ?: 0
        val body = if (len > 0) ByteArray(len).also { input.readFully(it) }.toString(Charsets.UTF_8) else ""
        return Response(status, headers, body)
    }

    private fun request(method: String, url: String, extra: String = ""): Response {
        send(method, url, extra)
        val r = readResponse()
        if (r.status != 200) throw IllegalStateException("$method failed: RTSP ${r.status}")
        return r
    }

    private fun session() {
        val base = "rtsp://$host:$PORT/"
        val s = Socket()
        socket = s
        s.tcpNoDelay = true
        s.connect(InetSocketAddress(host, PORT), 4000)
        s.soTimeout = 15000
        out = s.getOutputStream()
        input = DataInputStream(BufferedInputStream(s.getInputStream(), 1 shl 16))
        cseq = 0

        try { send("OPTIONS", base); readResponse() } catch (e: java.net.SocketTimeoutException) { throw e } catch (_: IllegalStateException) { }
        val desc = request("DESCRIBE", base, "Accept: application/sdp\r\n")
        val contentBase = desc.headers["content-base"] ?: base
        val tracks = parseSdp(desc.body)
        val video = tracks.firstOrNull { it.kind == "video" } ?: throw IllegalStateException("no video track from SysDVR")

        // Parameter sets from the SDP, so the car can start decoding at the first keyframe.
        video.spropSps?.let { sps -> video.spropPps?.let { pps -> hub.onConfig(START + sps + START + pps) } }
        hub.onNewStream(1280, 720, this)

        var sessionId: String? = null
        var channel = 0
        var channelOfVideo = 0
        var channelOfAudio = -1
        val audio = tracks.firstOrNull { it.kind == "audio" && it.encoding.equals("L16", true) && it.rate > 0 }
        audio?.let { hub.onAudioFormat(it.rate, it.channels) }
        // Set up every track like common players do (some servers only PLAY once all are set up).
        for (t in tracks) {
            val url = resolve(contentBase, t.control)
            val sessHeader = sessionId?.let { "Session: $it\r\n" } ?: ""
            val r = request("SETUP", url, "Transport: RTP/AVP/TCP;unicast;interleaved=$channel-${channel + 1}\r\n$sessHeader")
            if (sessionId == null) sessionId = r.headers["session"]?.substringBefore(';')
            if (t === video) channelOfVideo = channel
            if (t === audio) channelOfAudio = channel
            channel += 2
        }
        val sid = sessionId ?: throw IllegalStateException("no RTSP session")
        request("PLAY", contentBase, "Session: $sid\r\nRange: npt=0.000-\r\n")
        onStatus(tr("Streaming from Switch", "正在接收 Switch 的串流"))

        // Keep the session alive.
        val keepAlive = Thread({
            try { while (running && !s.isClosed) { Thread.sleep(20000); send("GET_PARAMETER", contentBase, "Session: $sid\r\n") } }
            catch (_: Exception) { }
        }, "rtsp-keepalive").apply { isDaemon = true; start() }

        try {
            readInterleaved(channelOfVideo, channelOfAudio)
        } finally {
            keepAlive.interrupt()
            try { s.close() } catch (_: Exception) { }
        }
    }

    private fun resolve(base: String, control: String?): String = when {
        control == null || control == "*" -> base
        control.startsWith("rtsp://") -> control
        else -> base.trimEnd('/') + "/" + control
    }

    private class Track(val kind: String, val control: String?, val spropSps: ByteArray?, val spropPps: ByteArray?,
                        val encoding: String?, val rate: Int, val channels: Int)

    private fun parseSdp(sdp: String): List<Track> {
        val tracks = mutableListOf<Track>()
        var kind: String? = null; var control: String? = null; var sps: ByteArray? = null; var pps: ByteArray? = null
        var enc: String? = null; var rate = 0; var ch = 1
        fun flush() { kind?.let { tracks += Track(it, control, sps, pps, enc, rate, ch) } }
        for (raw in sdp.lines()) {
            val l = raw.trim()
            when {
                l.startsWith("m=") -> { flush(); kind = l.substring(2).substringBefore(' '); control = null; sps = null; pps = null; enc = null; rate = 0; ch = 1 }
                l.startsWith("a=rtpmap:") -> {
                    // e.g. "a=rtpmap:97 L16/48000/2"
                    val parts = l.substringAfter(' ').split('/')
                    enc = parts.getOrNull(0); rate = parts.getOrNull(1)?.toIntOrNull() ?: 0; ch = parts.getOrNull(2)?.toIntOrNull() ?: 1
                }
                l.startsWith("a=control:") && kind != null -> control = l.substringAfter("a=control:").trim()
                l.startsWith("a=fmtp:") && l.contains("sprop-parameter-sets=") -> {
                    val sets = l.substringAfter("sprop-parameter-sets=").substringBefore(';').split(',')
                    try {
                        sps = Base64.decode(sets.getOrNull(0) ?: "", Base64.DEFAULT)
                        pps = sets.getOrNull(1)?.let { Base64.decode(it, Base64.DEFAULT) }
                    } catch (_: Exception) { }
                }
            }
        }
        flush()
        return tracks
    }

    // ---------------------------------------------------------------- RTP / H.264
    private val au = ByteArrayOutputStream(256 * 1024)
    private var fu: ByteArrayOutputStream? = null
    private var auTs = -1L
    private var auKey = false
    private var lastTs = -1L
    private var tsHigh = 0L
    private var configKey = ""

    private fun readInterleaved(videoChannel: Int, audioChannel: Int) {
        while (running) {
            val b = input.read()
            if (b < 0) throw java.io.EOFException("stream ended")
            if (b == '$'.code) {
                val ch = input.readUnsignedByte()
                val len = input.readUnsignedShort()
                val pkt = ByteArray(len)
                input.readFully(pkt)
                if (ch == videoChannel) onRtp(pkt)
                else if (ch == audioChannel) onAudioRtp(pkt)
            } else if (b == 'R'.code) {
                readResponse(b) // reply to keep-alive
            }
            // any other byte: resync until the next '$'
        }
    }

    private fun onRtp(p: ByteArray) {
        if (p.size < 12 || (p[0].toInt() ushr 6) != 2) return
        val padding = (p[0].toInt() and 0x20) != 0
        val ext = (p[0].toInt() and 0x10) != 0
        val cc = p[0].toInt() and 0x0f
        val marker = (p[1].toInt() and 0x80) != 0
        val ts = ((p[4].toLong() and 0xff) shl 24) or ((p[5].toLong() and 0xff) shl 16) or
                 ((p[6].toLong() and 0xff) shl 8) or (p[7].toLong() and 0xff)
        var off = 12 + 4 * cc
        if (ext && off + 4 <= p.size) off += 4 + 4 * (((p[off + 2].toInt() and 0xff) shl 8) or (p[off + 3].toInt() and 0xff))
        var end = p.size
        if (padding) end -= p[p.size - 1].toInt() and 0xff
        if (off >= end) return

        if (auTs != -1L && ts != auTs) flushAu() // timestamp changed without a marker
        auTs = ts

        val type = p[off].toInt() and 0x1f
        when (type) {
            in 1..23 -> nal(p, off, end - off)
            24 -> { // STAP-A
                var i = off + 1
                while (i + 2 <= end) {
                    val size = ((p[i].toInt() and 0xff) shl 8) or (p[i + 1].toInt() and 0xff)
                    i += 2
                    if (size <= 0 || i + size > end) break
                    nal(p, i, size); i += size
                }
            }
            28 -> { // FU-A
                if (end - off < 2) return
                val hdr = p[off + 1].toInt()
                val startBit = (hdr and 0x80) != 0
                val endBit = (hdr and 0x40) != 0
                if (startBit) {
                    fu = ByteArrayOutputStream(64 * 1024).also {
                        it.write(((p[off].toInt() and 0xe0) or (hdr and 0x1f)))
                    }
                }
                fu?.write(p, off + 2, end - off - 2)
                if (endBit) { fu?.let { val b = it.toByteArray(); nal(b, 0, b.size) }; fu = null }
            }
        }
        if (marker) flushAu()
    }

    /** L16 PCM: strip the RTP header and pass samples through; the car decodes them. */
    private fun onAudioRtp(p: ByteArray) {
        if (p.size < 12 || (p[0].toInt() ushr 6) != 2) return
        val padding = (p[0].toInt() and 0x20) != 0
        val ext = (p[0].toInt() and 0x10) != 0
        var off = 12 + 4 * (p[0].toInt() and 0x0f)
        if (ext && off + 4 <= p.size) off += 4 + 4 * (((p[off + 2].toInt() and 0xff) shl 8) or (p[off + 3].toInt() and 0xff))
        var end = p.size
        if (padding) end -= p[p.size - 1].toInt() and 0xff
        if (end > off) hub.onAudio(p.copyOfRange(off, end))
    }

    private fun nal(b: ByteArray, off: Int, len: Int) {
        if (len <= 0) return
        val t = b[off].toInt() and 0x1f
        if (t == 5) auKey = true
        au.write(START); au.write(b, off, len)
    }

    private fun flushAu() {
        if (au.size() == 0) { auTs = -1; return }
        val bytes = au.toByteArray()
        au.reset()
        val key = auKey
        auKey = false

        // 32-bit RTP timestamp -> continuous microseconds
        if (lastTs >= 0 && auTs < lastTs && lastTs - auTs > 0x80000000L) tsHigh += 0x100000000L
        lastTs = auTs
        val ptsUs = (tsHigh + auTs) * 1_000_000L / 90_000L
        auTs = -1

        if (key) publishConfig(bytes)
        hub.onFrame(bytes, ptsUs, key)
    }

    /** Sends SPS/PPS found in-band to the hub so newly connected cars get them. */
    private fun publishConfig(annexB: ByteArray) {
        var sps: ByteArray? = null; var pps: ByteArray? = null
        var i = 0
        val starts = mutableListOf<Int>()
        while (i + 3 < annexB.size) {
            if (annexB[i].toInt() == 0 && annexB[i + 1].toInt() == 0 && annexB[i + 2].toInt() == 0 && annexB[i + 3].toInt() == 1) { starts += i + 4; i += 4 } else i++
        }
        for ((k, s) in starts.withIndex()) {
            val e = if (k + 1 < starts.size) starts[k + 1] - 4 else annexB.size
            when (annexB[s].toInt() and 0x1f) { 7 -> sps = annexB.copyOfRange(s, e); 8 -> pps = annexB.copyOfRange(s, e) }
        }
        val a = sps; val b = pps
        if (a != null && b != null) {
            val k = a.contentToString() + b.contentToString()
            if (k != configKey) { configKey = k; hub.onConfig(START + a + START + b) }
        }
    }
}
