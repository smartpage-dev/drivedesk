/* DriveDesk phone viewer (runs in the Tesla browser).
   The phone sends raw H.264; this file wraps each frame in a tiny fragmented-MP4 segment and
   plays it through Media Source Extensions, chasing the live edge to keep latency low.
   ES5-only so it runs on older in-car browser builds. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var store = {
    get: function (k, d) { try { var v = localStorage.getItem('ddp-' + k); return v === null ? d : v; } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem('ddp-' + k, v); } catch (e) {} },
    del: function (k) { try { localStorage.removeItem('ddp-' + k); } catch (e) {} }
  };
  var video = $('video'), surface = $('surface');
  var ws = null, authed = false, retryMs = 1000, retryTimer = null, touchOn = false;

  // =====================================================================
  // fMP4 muxer
  // =====================================================================
  var TIMESCALE = 90000;

  function bytes(parts) {
    var len = 0, i, p;
    for (i = 0; i < parts.length; i++) len += parts[i].length;
    var out = new Uint8Array(len), off = 0;
    for (i = 0; i < parts.length; i++) {
      p = parts[i];
      if (p instanceof Uint8Array) out.set(p, off); else for (var j = 0; j < p.length; j++) out[off + j] = p[j];
      off += p.length;
    }
    return out;
  }
  function u8(n) { return [n & 255]; }
  function u16(n) { return [(n >>> 8) & 255, n & 255]; }
  function u32(n) { return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]; }
  function u64(n) { var hi = Math.floor(n / 4294967296), lo = n - hi * 4294967296; return u32(hi).concat(u32(lo)); }
  function str(s) { var a = []; for (var i = 0; i < s.length; i++) a.push(s.charCodeAt(i)); return a; }
  function zeros(n) { var a = []; for (var i = 0; i < n; i++) a.push(0); return a; }
  function box(type) {
    var parts = Array.prototype.slice.call(arguments, 1);
    var body = bytes(parts);
    return bytes([u32(body.length + 8), str(type), body]);
  }
  var MATRIX = [].concat(u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000));

  function initSegment(w, h, sps, pps) {
    var avcC = box('avcC', [1, sps[1], sps[2], sps[3], 0xFF, 0xE1], u16(sps.length), sps, [1], u16(pps.length), pps);
    var avc1 = box('avc1', zeros(6), u16(1), zeros(16), u16(w), u16(h), u32(0x00480000), u32(0x00480000),
      u32(0), u16(1), zeros(32), u16(0x18), u16(0xFFFF), avcC);
    var stbl = box('stbl', box('stsd', u32(0), u32(1), avc1), box('stts', u32(0), u32(0)), box('stsc', u32(0), u32(0)),
      box('stsz', u32(0), u32(0), u32(0)), box('stco', u32(0), u32(0)));
    var minf = box('minf', box('vmhd', u32(1), zeros(8)), box('dinf', box('dref', u32(0), u32(1), box('url ', u32(1)))), stbl);
    var mdia = box('mdia',
      box('mdhd', u32(0), u32(0), u32(0), u32(TIMESCALE), u32(0), u16(0x55c4), u16(0)),
      box('hdlr', u32(0), u32(0), str('vide'), zeros(12), str('VideoHandler'), [0]),
      minf);
    var tkhd = box('tkhd', u32(3), u32(0), u32(0), u32(1), u32(0), u32(0), zeros(8), u16(0), u16(0), u16(0), u16(0),
      MATRIX, u32(w * 65536), u32(h * 65536));
    var mvhd = box('mvhd', u32(0), u32(0), u32(0), u32(1000), u32(0), u32(0x00010000), u16(0x0100), u16(0), zeros(8),
      MATRIX, zeros(24), u32(2));
    var mvex = box('mvex', box('trex', u32(0), u32(1), u32(1), u32(0), u32(0), u32(0)));
    var ftyp = box('ftyp', str('isom'), u32(0x200), str('isom'), str('iso2'), str('avc1'), str('mp41'));
    return bytes([ftyp, box('moov', mvhd, box('trak', tkhd, mdia), mvex)]);
  }

  function fragment(seq, dts, duration, key, data) {
    var flags = key ? 0x02000000 : 0x01010000;
    function build(offset) {
      return box('moof',
        box('mfhd', u32(0), u32(seq)),
        box('traf',
          box('tfhd', u32(0x020000), u32(1)),
          box('tfdt', u32(0x01000000), u64(dts)),
          box('trun', u32(0x000701), u32(1), u32(offset), u32(duration), u32(data.length), u32(flags))));
    }
    var moof = build(0);
    moof = build(moof.length + 8);
    return bytes([moof, box('mdat', data)]);
  }

  // Annex-B (00 00 01 start codes) -> NAL units
  function splitNals(b) {
    var out = [], i = 0, start = -1, n = b.length;
    while (i + 2 < n) {
      if (b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 1) {
        if (start >= 0) { var end = i; while (end > start && b[end - 1] === 0) end--; out.push(b.subarray(start, end)); }
        i += 3; start = i;
      } else i++;
    }
    if (start >= 0 && start < n) out.push(b.subarray(start, n));
    if (!out.length && n) out.push(b);
    return out;
  }
  function hex2(n) { return ('0' + n.toString(16)).slice(-2); }

  // =====================================================================
  // Low-latency MSE player
  // =====================================================================
  var player = {
    w: 0, h: 0, sps: null, pps: null, key: '', ms: null, sb: null, queue: [], seq: 1, dts: 0,
    lastPts: null, waitKey: true, frames: 0, fps: 0,

    setSize: function (w, h) {
      if (w === this.w && h === this.h) return;
      this.w = w; this.h = h;
      this.key = ''; // force re-init at next SPS/PPS (e.g. phone rotated)
    },

    onConfig: function (data) {
      var nals = splitNals(data), sps = null, pps = null;
      for (var i = 0; i < nals.length; i++) {
        var t = nals[i][0] & 31;
        if (t === 7) sps = nals[i]; else if (t === 8) pps = nals[i];
      }
      if (sps && pps) this.init(sps, pps);
    },

    init: function (sps, pps) {
      var k = Array.prototype.join.call(sps, ',') + '|' + Array.prototype.join.call(pps, ',') + '|' + this.w + 'x' + this.h;
      if (k === this.key) return;
      this.key = k; this.sps = sps; this.pps = pps;
      var codec = 'video/mp4; codecs="avc1.' + hex2(sps[1]) + hex2(sps[2]) + hex2(sps[3]) + '"';
      if (!window.MediaSource || !MediaSource.isTypeSupported(codec)) {
        status('This browser cannot play the phone\u2019s video (' + codec + ').'); return;
      }
      var self = this;
      this.sb = null; this.queue = []; this.seq = 1; this.dts = 0; this.lastPts = null; this.waitKey = true;
      var ms = new MediaSource();
      this.ms = ms;
      ms.addEventListener('sourceopen', function () {
        if (self.ms !== ms) return;
        var sb = ms.addSourceBuffer(codec);
        sb.mode = 'sequence';
        sb.addEventListener('updateend', function () { self.pump(); });
        self.sb = sb;
        self.queue.push(initSegment(self.w || 720, self.h || 1280, self.sps, self.pps));
        self.pump();
        send({ t: 'key-request' });
      });
      if (video.src) URL.revokeObjectURL(video.src);
      video.src = URL.createObjectURL(ms);
      var p = video.play(); if (p && p.catch) p.catch(function () {});
    },

    onFrame: function (data, pts, key) {
      var nals = splitNals(data), sps = null, pps = null, parts = [], size = 0, i, t;
      for (i = 0; i < nals.length; i++) {
        t = nals[i][0] & 31;
        if (t === 7) { sps = nals[i]; continue; }
        if (t === 8) { pps = nals[i]; continue; }
        if (t === 9) continue; // access unit delimiter
        parts.push(u32(nals[i].length)); parts.push(nals[i]); size += 4 + nals[i].length;
      }
      if (sps && pps) this.init(sps, pps); // in-band config
      if (!this.sb || !size) return;
      if (this.waitKey && !key) return;
      this.waitKey = false;
      if (this.queue.length > 45) { // we fell behind: skip to the next keyframe
        this.queue = []; this.waitKey = true; send({ t: 'key-request' }); return;
      }
      var d = this.lastPts === null ? 1500 : Math.round((pts - this.lastPts) * TIMESCALE / 1e6);
      d = Math.max(450, Math.min(d, 4500)); // 5..50 ms
      this.lastPts = pts;
      this.queue.push(fragment(this.seq++, this.dts, d, key, bytes(parts)));
      this.dts += d;
      this.frames++;
      this.pump();
    },

    pump: function () {
      var sb = this.sb;
      if (!sb || sb.updating || !this.queue.length) return;
      try { sb.appendBuffer(this.queue.shift()); }
      catch (e) {
        if (e.name === 'QuotaExceededError') this.trim(true);
        else { this.key = ''; this.waitKey = true; }
      }
    },

    trim: function (force) {
      var sb = this.sb;
      if (!sb || sb.updating || !video.buffered.length) return;
      var start = video.buffered.start(0), keep = video.currentTime - 3;
      if (keep - start > (force ? 0.5 : 15)) { try { sb.remove(start, keep); } catch (e) {} }
    },

    // Keep playback right at the newest frame.
    chase: function () {
      if (!video.buffered.length) return;
      var end = video.buffered.end(video.buffered.length - 1);
      var lag = end - video.currentTime;
      if (lag > 0.35) { video.currentTime = end - 0.03; video.playbackRate = 1; }
      else if (lag > 0.1) video.playbackRate = 1.25;
      else video.playbackRate = 1;
      if (video.paused) { var p = video.play(); if (p && p.catch) p.catch(function () {}); }
      this.trim(false);
    }
  };
  setInterval(function () { player.chase(); }, 100);
  setInterval(function () { player.fps = player.frames; player.frames = 0; }, 1000);

  // =====================================================================
  // Screens, PIN, connection
  // =====================================================================
  function show(which, text) {
    $('pin-screen').hidden = which !== 'pin';
    $('stage').hidden = which !== 'stage' && which !== 'status';
    $('status').hidden = which !== 'status';
    if (text) $('status-text').textContent = text;
  }
  function status(text) { show('status', text); }

  var entered = '', PIN_LEN = 6;
  function renderDots() {
    var h = '';
    for (var i = 0; i < PIN_LEN; i++) h += '<span class="' + (i < entered.length ? 'on' : '') + '"></span>';
    $('pin-dots').innerHTML = h;
  }
  function buildKeypad() {
    var keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'Clear', '0', 'Delete'];
    var pad = $('keypad'); pad.innerHTML = '';
    keys.forEach(function (k) {
      var b = document.createElement('button');
      b.textContent = k; if (k.length > 1) b.className = 'aux';
      b.addEventListener('click', function () {
        if (k === 'Clear') entered = ''; else if (k === 'Delete') entered = entered.slice(0, -1);
        else if (entered.length < PIN_LEN) entered += k;
        $('pin-msg').textContent = ''; renderDots();
        if (entered.length === PIN_LEN) { store.set('pin', entered); entered = ''; renderDots(); connect(); }
      });
      pad.appendChild(b);
    });
    renderDots();
  }
  function askPin(msg) { authed = false; clearTimeout(retryTimer); show('pin'); $('pin-msg').textContent = msg || ''; }

  function send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }

  function connect() {
    var pin = store.get('pin', '');
    if (!pin) return askPin();
    clearTimeout(retryTimer);
    if (ws) { try { ws.onclose = null; ws.close(); } catch (e) {} }
    status('Connecting to your phone…');
    ws = new WebSocket('ws://' + location.host + '/ws');
    ws.binaryType = 'arraybuffer';
    ws.onopen = function () { send({ t: 'hello', pin: pin }); };
    ws.onmessage = function (ev) {
      if (typeof ev.data !== 'string') {
        var dv = new DataView(ev.data), flags = dv.getUint8(0);
        var pts = dv.getUint32(1) * 4294967296 + dv.getUint32(5);
        var data = new Uint8Array(ev.data, 9);
        if (flags & 1) player.onConfig(data); else player.onFrame(data, pts, (flags & 2) !== 0);
        return;
      }
      var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.t === 'error') {
        if (m.code === 'pin') { store.del('pin'); return askPin('That PIN didn\u2019t match. Check the DriveDesk app on your phone.'); }
        if (m.code === 'locked') { store.del('pin'); return askPin('Too many attempts. Try again in ' + m.retryInSec + ' seconds.'); }
        if (m.code === 'full') { authed = false; return status('Three screens are already connected to this phone.'); }
      } else if (m.t === 'welcome') {
        authed = true; retryMs = 1000; setTouch(!!m.touch);
        status('Waiting for video…');
      } else if (m.t === 'meta') {
        player.setSize(m.w, m.h);
      } else if (m.t === 'caps') {
        setTouch(!!m.touch);
      }
    };
    ws.onclose = function () {
      if (!authed && !store.get('pin', '')) return;
      status('Connection lost. Reconnecting…');
      retryTimer = setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, 8000);
    };
  }
  setInterval(function () { send({ t: 'ping' }); }, 5000);
  video.addEventListener('playing', function () { show('stage'); });

  function setTouch(on) {
    touchOn = on;
    var els = document.querySelectorAll('.touch-only');
    for (var i = 0; i < els.length; i++) els[i].hidden = !on;
    $('hint').hidden = on;
    if (!on) setTimeout(function () { $('hint').hidden = true; }, 8000);
  }

  // =====================================================================
  // Gestures -> phone (tap, long-press, swipe, two-finger/pinch)
  // =====================================================================
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function norm(cx, cy) {
    var r = video.getBoundingClientRect(), vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return null;
    var s = Math.min(r.width / vw, r.height / vh), w = vw * s, h = vh * s;
    var ox = r.left + (r.width - w) / 2, oy = r.top + (r.height - h) / 2;
    return [Math.round(clamp01((cx - ox) / w) * 10000) / 10000, Math.round(clamp01((cy - oy) / h) * 10000) / 10000];
  }

  var active = {}, finished = [], t0 = 0, sx = 0, sy = 0, moved = false, longFired = false, longTimer = null;
  function count() { return Object.keys(active).length; }

  surface.addEventListener('pointerdown', function (e) {
    if (!touchOn) { $('hint').hidden = false; setTimeout(function () { $('hint').hidden = true; }, 4000); return; }
    var p = norm(e.clientX, e.clientY); if (!p) return;
    surface.setPointerCapture(e.pointerId);
    active[e.pointerId] = { pts: [p], last: Date.now() };
    if (count() === 1 && !finished.length) {
      t0 = Date.now(); sx = e.clientX; sy = e.clientY; moved = false; longFired = false;
      clearTimeout(longTimer);
      longTimer = setTimeout(function () {
        if (moved || count() !== 1) return;
        longFired = true; ring(sx, sy);
        var q = norm(sx, sy); if (q) send({ t: 'long', x: q[0], y: q[1] });
      }, 500);
    } else clearTimeout(longTimer);
  });

  surface.addEventListener('pointermove', function (e) {
    var a = active[e.pointerId]; if (!a) return;
    if (Math.abs(e.clientX - sx) + Math.abs(e.clientY - sy) > 10) { moved = true; clearTimeout(longTimer); }
    var now = Date.now();
    if (now - a.last >= 16 && a.pts.length < 150) { var p = norm(e.clientX, e.clientY); if (p) { a.pts.push(p); a.last = now; } }
  });

  function end(e) {
    var a = active[e.pointerId]; if (!a) return;
    var p = norm(e.clientX, e.clientY); if (p) a.pts.push(p);
    finished.push(a.pts); delete active[e.pointerId];
    if (count() > 0) return;
    clearTimeout(longTimer);
    var ms = Math.max(50, Math.min(Date.now() - t0, 3000));
    if (longFired) { /* already sent */ }
    else if (finished.length >= 2) send({ t: 'multi', p: finished.slice(0, 2), ms: ms });
    else if (!moved) send({ t: 'tap', x: finished[0][0][0], y: finished[0][0][1] });
    else send({ t: 'swipe', p: finished[0], ms: ms });
    finished = [];
  }
  surface.addEventListener('pointerup', end);
  surface.addEventListener('pointercancel', end);
  surface.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  function ring(x, y) {
    var d = document.createElement('div');
    d.style.cssText = 'position:fixed;left:' + (x - 28) + 'px;top:' + (y - 28) + 'px;width:56px;height:56px;border-radius:50%;border:3px solid #f2a93b;z-index:5;pointer-events:none;transition:opacity .4s,transform .4s;';
    document.body.appendChild(d);
    requestAnimationFrame(function () { d.style.opacity = '0'; d.style.transform = 'scale(1.6)'; });
    setTimeout(function () { d.remove(); }, 450);
  }

  // =====================================================================
  // Toolbar + stats
  // =====================================================================
  var hideTimer = null;
  function showToolbar() { $('toolbar').hidden = false; clearTimeout(hideTimer); hideTimer = setTimeout(function () { $('toolbar').hidden = true; }, 6000); }
  $('handle').addEventListener('click', function () { if ($('toolbar').hidden) showToolbar(); else $('toolbar').hidden = true; });
  $('toolbar').addEventListener('click', function (e) {
    var act = e.target.getAttribute('data-act'); if (!act) return;
    showToolbar();
    if (act === 'back' || act === 'home' || act === 'recents') send({ t: 'key', k: act });
    else if (act === 'stats') { $('stats').hidden = !$('stats').hidden; $('btn-stats').className = $('stats').hidden ? '' : 'on'; }
    else if (act === 'fullscreen') {
      var el = document.documentElement, req = el.requestFullscreen || el.webkitRequestFullscreen;
      if (req) { try { var r = req.call(el); if (r && r.catch) r.catch(function () {}); } catch (x) {} }
    }
    else if (act === 'reconnect') { retryMs = 1000; connect(); }
    else if (act === 'forget') { store.del('pin'); if (ws) { ws.onclose = null; ws.close(); } askPin(); }
  });
  setInterval(function () {
    if ($('stats').hidden) return;
    var lag = video.buffered.length ? Math.round((video.buffered.end(video.buffered.length - 1) - video.currentTime) * 1000) : 0;
    $('stats').textContent = (video.videoWidth || '?') + '\u00d7' + (video.videoHeight || '?') + '  ' + player.fps + ' fps  buffer ' + lag + ' ms';
  }, 1000);

  buildKeypad();
  setTouch(false); $('hint').hidden = true;
  if (store.get('pin', '')) connect(); else askPin();
})();
