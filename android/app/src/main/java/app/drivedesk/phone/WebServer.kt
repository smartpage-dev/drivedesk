package app.drivedesk.phone

import android.content.Context
import android.util.Base64
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingDeque

/**
 * Serves the car-side viewer page from assets/web and runs the WebSocket that carries
 * video (phone -> car) and touch/keys (car -> phone). Local network only.
 */
class WebServer(
    private val ctx: Context,
    private val hub: StreamHub,
    private val onControl: (JSONObject, Client) -> Unit,
    private val source: String = "phone"   // "phone" (screen mirroring) or "switch" (Nintendo Switch relay)
) {
    private var server: ServerSocket? = null
    private val pool = Executors.newCachedThreadPool()
    private val fails = ConcurrentHashMap<String, Pair<Int, Long>>() // ip -> (count, lockedUntil)
    @Volatile private var running = false

    fun start() {
        val s = ServerSocket()
        s.reuseAddress = true
        s.bind(InetSocketAddress(PORT))
        server = s
        running = true
        Thread({
            while (running) {
                val sock = try { s.accept() } catch (_: Exception) { break }
                sock.tcpNoDelay = true
                pool.execute { handle(sock) }
            }
        }, "http-accept").start()
    }

    fun stop() {
        running = false
        try { server?.close() } catch (_: Exception) { }
        pool.shutdownNow()
    }

    private fun handle(sock: Socket) {
        try {
            val input = DataInputStream(BufferedInputStream(sock.getInputStream()))
            val out = BufferedOutputStream(sock.getOutputStream())
            val lines = readHead(input) ?: return sock.close()
            val path = lines.first().split(" ").getOrNull(1)?.substringBefore('?') ?: "/"
            val headers = lines.drop(1).mapNotNull {
                val i = it.indexOf(':'); if (i > 0) it.substring(0, i).trim().lowercase() to it.substring(i + 1).trim() else null
            }.toMap()

            if (path == "/ws" && headers["upgrade"]?.lowercase() == "websocket") {
                val key = headers["sec-websocket-key"] ?: return sock.close()
                websocket(sock, input, out, key)
            } else {
                serveAsset(path, out)
                sock.close()
            }
        } catch (_: Exception) {
            try { sock.close() } catch (_: Exception) { }
        }
    }

    private fun readHead(input: DataInputStream): List<String>? {
        val sb = StringBuilder()
        while (sb.length < 16384) {
            val c = input.read()
            if (c < 0) return null
            sb.append(c.toChar())
            if (sb.endsWith("\r\n\r\n")) return sb.split("\r\n").filter { it.isNotEmpty() }
        }
        return null
    }

    private val assets = mapOf(
        "/" to ("web/index.html" to "text/html; charset=utf-8"),
        "/index.html" to ("web/index.html" to "text/html; charset=utf-8"),
        "/phone.js" to ("web/phone.js" to "application/javascript; charset=utf-8"),
        "/viewer.css" to ("web/viewer.css" to "text/css; charset=utf-8")
    )

    private fun serveAsset(path: String, out: OutputStream) {
        val entry = assets[path]
        if (entry == null) {
            out.write("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".toByteArray()); out.flush(); return
        }
        val body = ctx.assets.open(entry.first).use { it.readBytes() }
        out.write(("HTTP/1.1 200 OK\r\nContent-Type: ${entry.second}\r\nContent-Length: ${body.size}\r\n" +
            "Cache-Control: no-store\r\nConnection: close\r\n\r\n").toByteArray())
        out.write(body)
        out.flush()
    }

    private fun websocket(sock: Socket, input: DataInputStream, out: BufferedOutputStream, key: String) {
        val accept = Base64.encodeToString(
            MessageDigest.getInstance("SHA-1").digest((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").toByteArray()),
            Base64.NO_WRAP
        )
        out.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
            "Sec-WebSocket-Accept: $accept\r\n\r\n").toByteArray())
        out.flush()

        val conn = WsConnection(sock, input, out)
        val ip = sock.inetAddress?.hostAddress ?: "?"
        var client: Client? = null
        try {
            while (true) {
                val (op, data) = conn.read() ?: break
                if (op != WsConnection.TEXT) continue
                val msg = try { JSONObject(String(data)) } catch (_: Exception) { continue }

                if (client == null) {
                    if (msg.optString("t") != "hello") break
                    val f = fails[ip]
                    if (f != null && f.second > System.currentTimeMillis()) {
                        val secs = (f.second - System.currentTimeMillis()) / 1000 + 1
                        conn.send(WsConnection.TEXT, """{"t":"error","code":"locked","retryInSec":$secs}""".toByteArray()); break
                    }
                    if (msg.optString("pin") != Prefs.pin(ctx)) {
                        val count = (f?.first ?: 0) + 1
                        fails[ip] = if (count >= 5) 0 to System.currentTimeMillis() + 60_000 else count to 0L
                        conn.send(WsConnection.TEXT, """{"t":"error","code":"pin"}""".toByteArray()); break
                    }
                    fails.remove(ip)
                    if (hub.count() >= 3) { conn.send(WsConnection.TEXT, """{"t":"error","code":"full"}""".toByteArray()); break }
                    val c = Client(conn)
                    c.text(JSONObject().put("t", "welcome").put("source", source)
                        .put("touch", source == "phone" && TouchService.instance != null).toString())
                    hub.add(c)
                    client = c
                } else {
                    onControl(msg, client)
                }
            }
        } catch (_: Exception) {
        } finally {
            client?.let { hub.remove(it); it.close() } ?: conn.close()
        }
    }
}

/** RFC 6455 framing. Server frames are unmasked; client frames are masked. */
class WsConnection(private val sock: Socket, private val input: DataInputStream, private val out: BufferedOutputStream) {
    companion object { const val TEXT = 1; const val BINARY = 2; const val CLOSE = 8; const val PING = 9; const val PONG = 10 }

    fun read(): Pair<Int, ByteArray>? {
        var firstOp = -1
        val partial = ByteArrayOutputStream()
        while (true) {
            val b0 = input.read(); if (b0 < 0) return null
            val b1 = input.read(); if (b1 < 0) return null
            val fin = (b0 and 0x80) != 0
            val op = b0 and 0x0f
            var len = (b1 and 0x7f).toLong()
            if (len == 126L) len = input.readUnsignedShort().toLong()
            else if (len == 127L) len = input.readLong()
            if (len < 0 || len > 1_000_000) return null
            val mask = if ((b1 and 0x80) != 0) ByteArray(4).also { input.readFully(it) } else null
            val payload = ByteArray(len.toInt())
            input.readFully(payload)
            if (mask != null) for (i in payload.indices) payload[i] = (payload[i].toInt() xor mask[i and 3].toInt()).toByte()
            when (op) {
                CLOSE -> { try { send(CLOSE, ByteArray(0)) } catch (_: Exception) { }; return null }
                PING -> { send(PONG, payload); continue }
                PONG -> continue
                0 -> { partial.write(payload); if (fin) return firstOp to partial.toByteArray() }
                else -> { if (fin) return op to payload; firstOp = op; partial.write(payload) }
            }
        }
    }

    @Synchronized
    fun send(op: Int, data: ByteArray) {
        out.write(0x80 or op)
        val n = data.size
        when {
            n < 126 -> out.write(n)
            n < 65536 -> { out.write(126); out.write(n shr 8); out.write(n and 0xff) }
            else -> { out.write(127); for (i in 7 downTo 0) out.write(((n.toLong() shr (8 * i)) and 0xff).toInt()) }
        }
        out.write(data)
        out.flush()
    }

    fun close() { try { sock.close() } catch (_: Exception) { } }
}

/** One connected car/tablet. A writer thread keeps a slow viewer from stalling the encoder. */
class Client(private val conn: WsConnection) {
    @Volatile var needKey = true
    @Volatile var wantsAudio = false
    @Volatile private var open = true
    private val queue = LinkedBlockingDeque<Pair<Int, ByteArray>>()
    private val writer = Thread({
        try {
            while (open) {
                val (op, d) = queue.take()
                conn.send(op, d)
            }
        } catch (_: Exception) { close() }
    }, "ws-writer").apply { isDaemon = true; start() }

    fun text(s: String) { queue.offer(WsConnection.TEXT to s.toByteArray()) }
    fun binary(b: ByteArray) { queue.offer(WsConnection.BINARY to b) }

    /** Returns false (and drops the backlog) when the viewer has fallen behind. */
    fun frame(b: ByteArray): Boolean {
        if (queue.size > 60) { queue.clear(); return false }
        queue.offer(WsConnection.BINARY to b)
        return true
    }

    /** Audio is dropped (not queued) when the viewer is behind, so it never delays video. */
    fun audio(b: ByteArray) { if (queue.size < 40) queue.offer(WsConnection.BINARY to b) }

    fun close() {
        open = false
        writer.interrupt()
        conn.close()
    }
}
