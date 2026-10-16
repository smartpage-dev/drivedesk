package app.drivedesk.phone

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.Surface

/**
 * Encodes whatever is drawn on [surface] to H.264 and pushes it to the [StreamHub].
 * No B-frames (so decode order = display order), long GOP with on-demand keyframes.
 */
class VideoEncoder(
    val width: Int,
    val height: Int,
    private val bitrate: Int,
    private val fps: Int,
    private val hub: StreamHub
) : KeySource {
    private lateinit var codec: MediaCodec
    lateinit var surface: Surface
        private set
    @Volatile private var running = false
    private var thread: Thread? = null

    private fun format(strict: Boolean) = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, width, height).apply {
        setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
        setInteger(MediaFormat.KEY_BIT_RATE, bitrate)
        setInteger(MediaFormat.KEY_FRAME_RATE, fps)
        setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 10)
        // Keep frames flowing on a static screen so the car's player never starves.
        setLong(MediaFormat.KEY_REPEAT_PREVIOUS_FRAME_AFTER, 100_000)
        if (strict) {
            setInteger(MediaFormat.KEY_PRIORITY, 0) // realtime
            setInteger(MediaFormat.KEY_PROFILE, MediaCodecInfo.CodecProfileLevel.AVCProfileBaseline)
            setInteger(MediaFormat.KEY_LEVEL, MediaCodecInfo.CodecProfileLevel.AVCLevel41)
            if (Build.VERSION.SDK_INT >= 29) setInteger(MediaFormat.KEY_MAX_B_FRAMES, 0)
        }
    }

    /** Throws if this device's encoder can't handle the size; caller retries smaller. */
    fun start() {
        codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
        try {
            try {
                codec.configure(format(true), null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
            } catch (e: Exception) {
                Log.w("DriveDesk", "strict encoder config failed, retrying defaults", e)
                codec.reset()
                codec.configure(format(false), null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
            }
            surface = codec.createInputSurface()
            codec.start()
        } catch (e: Exception) {
            codec.release() // size not supported on this phone; caller retries smaller
            throw e
        }
        running = true
        hub.onNewStream(width, height, this)
        thread = Thread({ drain() }, "encoder").apply { start() }
    }

    override fun requestKeyFrame() {
        try {
            codec.setParameters(Bundle().apply { putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0) })
        } catch (_: Exception) { }
    }

    private fun drain() {
        val info = MediaCodec.BufferInfo()
        while (running) {
            val idx = try { codec.dequeueOutputBuffer(info, 100_000) } catch (_: Exception) { break }
            when {
                idx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                    // Some encoders only report SPS/PPS here instead of as a config buffer.
                    val f = codec.outputFormat
                    val sps = f.getByteBuffer("csd-0")?.duplicate(); val pps = f.getByteBuffer("csd-1")?.duplicate()
                    if (sps != null && pps != null) {
                        val spsLen = sps.remaining(); val ppsLen = pps.remaining()
                        val b = ByteArray(spsLen + ppsLen)
                        sps.get(b, 0, spsLen); pps.get(b, spsLen, ppsLen)
                        hub.onConfig(b)
                    }
                }
                idx >= 0 -> {
                    val buf = codec.getOutputBuffer(idx)
                    if (buf != null && info.size > 0) {
                        val bytes = ByteArray(info.size)
                        buf.position(info.offset); buf.limit(info.offset + info.size); buf.get(bytes)
                        if ((info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0) hub.onConfig(bytes)
                        else hub.onFrame(bytes, info.presentationTimeUs, (info.flags and MediaCodec.BUFFER_FLAG_KEY_FRAME) != 0)
                    }
                    codec.releaseOutputBuffer(idx, false)
                    if ((info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) break
                }
            }
        }
    }

    fun stop() {
        running = false
        thread?.join(500)
        try { codec.stop() } catch (_: Exception) { }
        try { codec.release() } catch (_: Exception) { }
        try { surface.release() } catch (_: Exception) { }
    }
}
