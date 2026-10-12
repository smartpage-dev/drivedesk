/* DriveDesk viewer. Runs in the Tesla browser (Chromium). Written without optional chaining
   or other newer syntax so it also works on older in-car browser builds. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var store = {
    get: function (k, d) { try { var v = localStorage.getItem('dd-' + k); return v === null ? d : v; } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem('dd-' + k, v); } catch (e) {} },
    del: function (k) { try { localStorage.removeItem('dd-' + k); } catch (e) {} }
  };

  var ws = null, pc = null, authed = false, retryMs = 1000, retryTimer = null;
  var displays = [], displayId = Number(store.get('display', 0)) || null;
  var mode = store.get('mode', 'touch');          // 'touch' | 'trackpad'
  var invert = store.get('invert', '0') === '1';  // false = natural (content follows finger)
  var video = $('video'), surface = $('surface');

  // ---------------- screens ----------------
  function show(which, text) {
    $('pin-screen').hidden = which !== 'pin';
    $('stage').hidden = which !== 'stage' && which !== 'status';
    $('status').hidden = which !== 'status';
    if (text) $('status-text').textContent = text;
  }

  // ---------------- PIN keypad ----------------
  var entered = '';
  var PIN_LEN = 6;
  function renderDots() {
    var html = '';
    for (var i = 0; i < PIN_LEN; i++) html += '<span class="' + (i < entered.length ? 'on' : '') + '"></span>';
    $('pin-dots').innerHTML = html;
  }
  function buildKeypad() {
    var keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'Clear', '0', 'Delete'];
    var pad = $('keypad');
    pad.innerHTML = '';
    keys.forEach(function (k) {
      var b = document.createElement('button');
      b.textContent = k;
      if (k.length > 1) b.className = 'aux';
      b.addEventListener('click', function () {
        if (k === 'Clear') entered = '';
        else if (k === 'Delete') entered = entered.slice(0, -1);
        else if (entered.length < PIN_LEN) entered += k;
        $('pin-msg').textContent = '';
        renderDots();
        if (entered.length === PIN_LEN) { store.set('pin', entered); entered = ''; renderDots(); connect(); }
      });
      pad.appendChild(b);
    });
    renderDots();
  }
  function askPin(msg) {
    authed = false;
    clearTimeout(retryTimer);
    show('pin');
    $('pin-msg').textContent = msg || '';
  }

  // ---------------- signaling ----------------
  function viewport() { return { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1 }; }
  function send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }

  function connect() {
    var pin = store.get('pin', '');
    if (!pin) return askPin();
    clearTimeout(retryTimer);
    if (ws) { try { ws.onclose = null; ws.close(); } catch (e) {} }
    closePc();
    show('status', 'Connecting…');

    ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
    ws.onopen = function () { send({ t: 'hello', pin: pin, viewport: viewport(), displayId: displayId }); };
    ws.onmessage = function (ev) {
      var msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.t === 'error') {
        if (msg.code === 'pin') { store.del('pin'); return askPin('That PIN didn’t match. Check your computer and try again.'); }
        if (msg.code === 'locked') { store.del('pin'); return askPin('Too many attempts. Try again in ' + msg.retryInSec + ' seconds.'); }
        if (msg.code === 'full') { authed = false; return show('status', 'Three screens are already connected. Disconnect one to use this screen.'); }
      } else if (msg.t === 'welcome') {
        authed = true; retryMs = 1000;
        displays = msg.displays || [];
        displayId = msg.displayId; store.set('display', displayId);
        updateToolbar();
        show('status', 'Waiting for video…');
      } else if (msg.t === 'restart') {
        displayId = msg.displayId; store.set('display', displayId);
        closePc(); show('status', 'Switching display…');
      } else if (msg.t === 'signal') {
        onSignal(msg.data);
      }
    };
    ws.onclose = function () {
      closePc();
      if (!authed && !store.get('pin', '')) return;
      show('status', 'Connection lost. Reconnecting…');
      retryTimer = setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, 8000);
    };
  }

  function ensurePc() {
    if (pc) return pc;
    pc = new RTCPeerConnection({ iceServers: [] });
    pc.onicecandidate = function (e) { send({ t: 'signal', data: { candidate: e.candidate ? e.candidate.toJSON() : null } }); };
    pc.ontrack = function (e) {
      try { e.receiver.playoutDelayHint = 0; } catch (x) {}
      try { e.receiver.jitterBufferTarget = 0; } catch (x) {}
      video.srcObject = e.streams[0] || new MediaStream([e.track]);
      var p = video.play(); if (p && p.catch) p.catch(function () {});
    };
    pc.onconnectionstatechange = function () {
      if (pc && pc.connectionState === 'failed') { show('status', 'Video connection failed. Retrying…'); ws && ws.close(); }
    };
    return pc;
  }
  function closePc() { if (pc) { try { pc.close(); } catch (e) {} pc = null; } video.srcObject = null; }

  function onSignal(data) {
    var p = ensurePc();
    if (data.sdp && data.sdp.type === 'offer') {
      p.setRemoteDescription(data.sdp)
        .then(function () { return p.createAnswer(); })
        .then(function (a) { return p.setLocalDescription(a); })
        .then(function () { send({ t: 'signal', data: { sdp: p.localDescription.toJSON() } }); })
        .catch(function (e) { show('status', 'Could not start video: ' + e.message); });
    } else if (data.candidate) {
      p.addIceCandidate(data.candidate).catch(function () {});
    }
  }

  video.addEventListener('playing', function () { show('stage'); });

  var resizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { send({ t: 'viewport', viewport: viewport() }); }, 300);
  });

  // ---------------- coordinates ----------------
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function norm(cx, cy) {
    var r = video.getBoundingClientRect();
    var vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return null;
    var s = Math.min(r.width / vw, r.height / vh);
    var w = vw * s, h = vh * s;
    var ox = r.left + (r.width - w) / 2, oy = r.top + (r.height - h) / 2;
    return { x: clamp01((cx - ox) / w), y: clamp01((cy - oy) / h) };
  }

  // ---------------- input batching (one send per frame) ----------------
  var pendingMove = null, pendingRel = { dx: 0, dy: 0 }, pendingScroll = { dx: 0, dy: 0 }, rafOn = false;
  function schedule() { if (!rafOn) { rafOn = true; requestAnimationFrame(flush); } }
  function flush() {
    rafOn = false;
    if (pendingMove) { send({ t: 'move', x: pendingMove.x, y: pendingMove.y }); pendingMove = null; }
    if (pendingRel.dx || pendingRel.dy) { send({ t: 'rel', dx: Math.round(pendingRel.dx), dy: Math.round(pendingRel.dy) }); pendingRel = { dx: 0, dy: 0 }; }
    if (pendingScroll.dx || pendingScroll.dy) { send({ t: 'scroll', dx: pendingScroll.dx, dy: pendingScroll.dy }); pendingScroll = { dx: 0, dy: 0 }; }
  }
  function moveTo(cx, cy, now) {
    var n = norm(cx, cy); if (!n) return;
    if (now) { pendingMove = null; send({ t: 'move', x: n.x, y: n.y }); } else { pendingMove = n; schedule(); }
  }

  // ---------------- gestures ----------------
  // Touch mode:    tap = click, drag = click-drag, long-press = right-click,
  //                two-finger drag = scroll, two-finger tap = right-click
  // Trackpad mode: move = move cursor, tap = click, long-press then move = drag,
  //                two-finger drag = scroll, two-finger tap = right-click
  var pts = {}, g = null, longTimer = null;
  var LONG_MS = 500, SLOP = 9;

  function count() { return Object.keys(pts).length; }
  function centroid() {
    var x = 0, y = 0, n = 0;
    for (var k in pts) { x += pts[k].x; y += pts[k].y; n++; }
    return { x: x / n, y: y / n };
  }
  function ring(x, y) {
    var d = document.createElement('div');
    d.style.cssText = 'position:fixed;left:' + (x - 28) + 'px;top:' + (y - 28) + 'px;width:56px;height:56px;border-radius:50%;border:3px solid #f2a93b;z-index:5;pointer-events:none;transition:opacity .4s,transform .4s;';
    document.body.appendChild(d);
    requestAnimationFrame(function () { d.style.opacity = '0'; d.style.transform = 'scale(1.6)'; });
    setTimeout(function () { d.remove(); }, 450);
  }

  surface.addEventListener('pointerdown', function (e) {
    if (e.pointerType === 'mouse') return mouseDown(e);
    surface.setPointerCapture(e.pointerId);
    pts[e.pointerId] = { x: e.clientX, y: e.clientY };
    var n = count();
    if (n === 1) {
      g = { kind: 'one', sx: e.clientX, sy: e.clientY, lx: e.clientX, ly: e.clientY, t0: Date.now(), moved: false, dragging: false, long: false };
      clearTimeout(longTimer);
      longTimer = setTimeout(onLong, LONG_MS);
    } else if (n === 2) {
      clearTimeout(longTimer);
      if (g && g.dragging) { flush(); send({ t: 'up', b: 0 }); }
      var c = centroid();
      g = { kind: 'two', lx: c.x, ly: c.y, t0: Date.now(), travel: 0 };
      if (mode === 'touch') moveTo(c.x, c.y, true);
    }
  });

  function onLong() {
    if (!g || g.kind !== 'one' || g.moved) return;
    g.long = true;
    ring(g.sx, g.sy);
    if (mode === 'touch') {
      var n = norm(g.sx, g.sy);
      if (n) send({ t: 'click', x: n.x, y: n.y, b: 2 });
    } else {
      send({ t: 'down', b: 0 }); g.dragging = true; // drag lock
    }
  }

  surface.addEventListener('pointermove', function (e) {
    if (e.pointerType === 'mouse') return mouseMove(e);
    if (!pts[e.pointerId] || !g) return;
    pts[e.pointerId] = { x: e.clientX, y: e.clientY };

    if (g.kind === 'one') {
      var dist = Math.abs(e.clientX - g.sx) + Math.abs(e.clientY - g.sy);
      if (!g.moved && dist > SLOP) { g.moved = true; if (!g.long) clearTimeout(longTimer); }
      if (mode === 'touch') {
        if (g.long) return;
        if (g.moved && !g.dragging) { moveTo(g.sx, g.sy, true); send({ t: 'down', b: 0 }); g.dragging = true; }
        if (g.dragging) moveTo(e.clientX, e.clientY);
      } else if (g.moved) {
        var dx = e.clientX - g.lx, dy = e.clientY - g.ly;
        var speed = Math.sqrt(dx * dx + dy * dy);
        var accel = 1.4 + Math.min(speed / 12, 2.2);
        pendingRel.dx += dx * accel; pendingRel.dy += dy * accel; schedule();
      }
      g.lx = e.clientX; g.ly = e.clientY;
    } else if (g.kind === 'two' && count() === 2) {
      var c = centroid();
      var sdx = c.x - g.lx, sdy = c.y - g.ly;
      g.travel += Math.abs(sdx) + Math.abs(sdy);
      var sign = invert ? -1 : 1;
      pendingScroll.dx += sdx * sign; pendingScroll.dy += sdy * sign; schedule();
      g.lx = c.x; g.ly = c.y;
    }
  });

  function pointerEnd(e) {
    if (e.pointerType === 'mouse') return mouseUp(e);
    if (!pts[e.pointerId]) return;
    delete pts[e.pointerId];
    var n = count();
    if (!g) return;

    if (g.kind === 'one' && n === 0) {
      clearTimeout(longTimer);
      if (g.dragging) { flush(); send({ t: 'up', b: 0 }); }
      else if (!g.moved && !g.long) {
        if (mode === 'touch') { var p = norm(g.sx, g.sy); if (p) send({ t: 'click', x: p.x, y: p.y, b: 0 }); }
        else send({ t: 'click', b: 0 });
      }
      g = null;
    } else if (g.kind === 'two') {
      if (g.travel < 12 && Date.now() - g.t0 < 350) {
        if (mode === 'touch') { var c = { x: g.lx, y: g.ly }; var q = norm(c.x, c.y); if (q) send({ t: 'click', x: q.x, y: q.y, b: 2 }); }
        else send({ t: 'click', b: 2 });
      }
      g = { kind: 'done' }; // ignore the remaining finger until all fingers lift
      if (n === 0) g = null;
    } else if (n === 0) {
      g = null;
    }
  }
  surface.addEventListener('pointerup', pointerEnd);
  surface.addEventListener('pointercancel', pointerEnd);

  // Mouse (testing from a laptop/desktop browser)
  function mouseDown(e) { moveTo(e.clientX, e.clientY, true); send({ t: 'down', b: e.button === 2 ? 2 : 0 }); }
  function mouseMove(e) { moveTo(e.clientX, e.clientY); }
  function mouseUp(e) { flush(); send({ t: 'up', b: e.button === 2 ? 2 : 0 }); }
  surface.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  surface.addEventListener('wheel', function (e) {
    e.preventDefault();
    pendingScroll.dx -= e.deltaX; pendingScroll.dy -= e.deltaY; schedule();
  }, { passive: false });

  // ---------------- toolbar ----------------
  var hideTimer = null;
  function showToolbar() {
    $('toolbar').hidden = false;
    clearTimeout(hideTimer);
    hideTimer = setTimeout(function () { $('toolbar').hidden = true; }, 6000);
  }
  $('handle').addEventListener('click', function () { if ($('toolbar').hidden) showToolbar(); else $('toolbar').hidden = true; });

  function updateToolbar() {
    $('btn-mode').textContent = mode === 'touch' ? 'Mode: touch' : 'Mode: trackpad';
    $('btn-invert').textContent = invert ? 'Scroll: reversed' : 'Scroll: natural';
    var cur = null;
    for (var i = 0; i < displays.length; i++) if (displays[i].id === displayId) cur = i;
    $('btn-display').textContent = 'Display ' + (cur === null ? '?' : cur + 1) + ' of ' + displays.length;
    $('btn-display').hidden = displays.length < 2;
    $('btn-stats').className = $('stats').hidden ? '' : 'on';
  }

  $('toolbar').addEventListener('click', function (e) {
    var act = e.target.getAttribute('data-act');
    if (!act) return;
    showToolbar();
    if (act === 'mode') { mode = mode === 'touch' ? 'trackpad' : 'touch'; store.set('mode', mode); }
    else if (act === 'invert') { invert = !invert; store.set('invert', invert ? '1' : '0'); }
    else if (act === 'display' && displays.length > 1) {
      var idx = 0;
      for (var i = 0; i < displays.length; i++) if (displays[i].id === displayId) idx = i;
      var next = displays[(idx + 1) % displays.length];
      send({ t: 'switch-display', displayId: next.id });
    }
    else if (act === 'stats') { $('stats').hidden = !$('stats').hidden; }
    else if (act === 'fullscreen') {
      var el = document.documentElement;
      var req = el.requestFullscreen || el.webkitRequestFullscreen;
      if (req) { try { var r = req.call(el); if (r && r.catch) r.catch(function () {}); } catch (x) {} }
    }
    else if (act === 'reconnect') { retryMs = 1000; connect(); }
    else if (act === 'forget') { store.del('pin'); if (ws) { ws.onclose = null; ws.close(); } closePc(); askPin(); }
    updateToolbar();
  });

  // ---------------- receiver stats ----------------
  var lastBytes = 0, lastTs = 0;
  setInterval(function () {
    if ($('stats').hidden || !pc) return;
    pc.getStats().then(function (rep) {
      var inb = null, rtt = null;
      rep.forEach(function (r) {
        if (r.type === 'inbound-rtp' && r.kind === 'video') inb = r;
        if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated) rtt = r.currentRoundTripTime;
      });
      if (!inb) return;
      var kbps = lastTs ? Math.round(((inb.bytesReceived - lastBytes) * 8) / (inb.timestamp - lastTs)) : 0;
      lastBytes = inb.bytesReceived; lastTs = inb.timestamp;
      var codec = inb.codecId && rep.get(inb.codecId) ? rep.get(inb.codecId).mimeType.replace('video/', '') : '?';
      var jb = inb.jitterBufferEmittedCount ? Math.round((inb.jitterBufferDelay / inb.jitterBufferEmittedCount) * 1000) : null;
      $('stats').textContent = (inb.frameWidth || '?') + '×' + (inb.frameHeight || '?') + '  ' + Math.round(inb.framesPerSecond || 0) + ' fps  ' +
        (kbps / 1000).toFixed(1) + ' Mbps  ' + codec + (inb.decoderImplementation ? ' (' + inb.decoderImplementation + ')' : '') +
        (rtt !== null ? '  RTT ' + Math.round(rtt * 1000) + ' ms' : '') + (jb !== null ? '  buffer ' + jb + ' ms' : '');
    }).catch(function () {});
  }, 1000);

  // ---------------- boot ----------------
  buildKeypad();
  updateToolbar();
  if (store.get('pin', '')) connect(); else askPin();
})();
