'use strict';
/* global host */

// ======================= WebRTC sender =======================
const sessions = new Map(); // sessionId -> { pc, stream, statsTimer, pendingIce: [] }

function codecOrder(kind, preferred) {
  let caps = null;
  try { caps = RTCRtpSender.getCapabilities(kind); } catch (e) { /* ignore */ }
  if (!caps) return null;
  const want = new RegExp('video/' + preferred + '$', 'i');
  const first = caps.codecs.filter((c) => want.test(c.mimeType));
  // Prefer packetization-mode=1 for H264 (broadest hardware decoder support).
  first.sort((a, b) => (/packetization-mode=1/.test(b.sdpFmtpLine || '') ? 1 : 0) - (/packetization-mode=1/.test(a.sdpFmtpLine || '') ? 1 : 0));
  const rest = caps.codecs.filter((c) => !want.test(c.mimeType));
  return first.concat(rest);
}

// Start fast instead of ramping from ~300 kbps (we're on a LAN). Applied to the remote answer.
function mungeStartBitrate(sdp, kbps) {
  return sdp.replace(/a=fmtp:(\d+) (.*)/g, (line, pt, params) =>
    (/x-google-start-bitrate/.test(params) || /^apt=/.test(params)) ? line : `a=fmtp:${pt} ${params};x-google-start-bitrate=${kbps};x-google-min-bitrate=${Math.round(kbps / 4)}`);
}

async function startSession({ sessionId, sourceId, maxWidth, maxHeight, fps, bitrate, codec }) {
  endSession(sessionId);
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId, maxWidth, maxHeight, maxFrameRate: fps } }
  });
  const track = stream.getVideoTracks()[0];
  track.contentHint = 'detail'; // keep text sharp; drop frames before dropping resolution

  const pc = new RTCPeerConnection({ iceServers: [] }); // LAN only
  const s = { pc, stream, statsTimer: null, pendingIce: [], bitrate, lastBytes: 0, lastTs: 0 };
  sessions.set(sessionId, s);

  const tx = pc.addTransceiver(track, { direction: 'sendonly', streams: [stream] });
  const order = codecOrder('video', codec);
  if (order && tx.setCodecPreferences) { try { tx.setCodecPreferences(order); } catch (e) { console.warn('codec prefs', e); } }

  pc.onicecandidate = (e) => host.sendSignal(sessionId, { candidate: e.candidate ? e.candidate.toJSON() : null });
  pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') pc.restartIce && pc.restartIce(); };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  host.sendSignal(sessionId, { sdp: pc.localDescription.toJSON() });

  s.statsTimer = setInterval(() => collectStats(sessionId), 2000);
}

async function applySenderParams(s) {
  const sender = s.pc.getSenders()[0];
  if (!sender) return;
  const p = sender.getParameters();
  if (!p.encodings || !p.encodings.length) p.encodings = [{}];
  p.encodings[0].maxBitrate = s.bitrate;
  p.degradationPreference = 'maintain-resolution';
  try { await sender.setParameters(p); } catch (e) { console.warn('setParameters', e); }
}

async function onSignal({ sessionId, data }) {
  const s = sessions.get(sessionId);
  if (!s) return;
  if (data.sdp && data.sdp.type === 'answer') {
    const kbps = Math.round(s.bitrate / 1000 * 0.6);
    try { await s.pc.setRemoteDescription({ type: 'answer', sdp: mungeStartBitrate(data.sdp.sdp, kbps) }); }
    catch (e) { await s.pc.setRemoteDescription(data.sdp); } // fall back to unmodified SDP
    for (const c of s.pendingIce.splice(0)) await s.pc.addIceCandidate(c).catch(() => {});
    await applySenderParams(s);
  } else if ('candidate' in data) {
    if (!data.candidate) return;
    if (!s.pc.remoteDescription) s.pendingIce.push(data.candidate);
    else await s.pc.addIceCandidate(data.candidate).catch(() => {});
  }
}

function endSession(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return;
  clearInterval(s.statsTimer);
  s.stream.getTracks().forEach((t) => t.stop());
  s.pc.close();
  sessions.delete(sessionId);
}

async function collectStats(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return;
  const report = await s.pc.getStats();
  let out = null, codec = null, rtt = null;
  report.forEach((r) => {
    if (r.type === 'outbound-rtp' && r.kind === 'video') out = r;
    if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated) rtt = r.currentRoundTripTime;
  });
  if (!out) return;
  if (out.codecId) { const c = report.get(out.codecId); codec = c && c.mimeType.replace('video/', ''); }
  const kbps = s.lastTs ? Math.round(((out.bytesSent - s.lastBytes) * 8) / (out.timestamp - s.lastTs)) : 0;
  s.lastBytes = out.bytesSent; s.lastTs = out.timestamp;
  host.sendStats(sessionId, {
    fps: Math.round(out.framesPerSecond || 0),
    kbps,
    width: out.frameWidth, height: out.frameHeight,
    codec, encoder: out.encoderImplementation || null,
    rttMs: rtt != null ? Math.round(rtt * 1000) : null,
    limitedBy: out.qualityLimitationReason || null
  });
}

host.onSessionStart((d) => startSession(d).catch((e) => console.error('session start failed', e)));
host.onSessionEnd(({ sessionId }) => endSession(sessionId));
host.onSignal((d) => onSignal(d).catch((e) => console.error('signal', e)));

// ======================= UI =======================
const $ = (id) => document.getElementById(id);
let state = null;

function render(s) {
  state = s;
  const pending = (s.setup || []).filter((c) => !c.ok);
  $('setup').hidden = pending.length === 0;
  $('checks').innerHTML = (s.setup || []).map((c) => `<div class="check">
      <span class="dot ${c.ok ? 'ok' : ''}" aria-label="${c.ok ? 'Done' : 'To do'}"></span>
      <div><div>${escapeHtml(c.title)}</div><div class="detail">${escapeHtml(c.detail || '')}</div></div>
      ${!c.ok && c.fix ? `<button data-fix="${c.id}">${escapeHtml(c.fix)}</button>` : ''}
    </div>`).join('');
  document.querySelectorAll('[data-fix]').forEach((b) => { b.onclick = () => host.fixSetup(b.dataset.fix); });
  $('login').checked = !!s.launchAtLogin;
  $('urls').innerHTML = s.urls.length
    ? s.urls.map((u) => `<div class="url" title="${u.name}">${u.url}</div>`).join('')
    : '<div class="warn">No network connection. Join a Wi-Fi network or hotspot.</div>';
  $('pin').textContent = s.pin;

  $('displays').innerHTML = s.displays.map((d) => {
    const selected = s.settings.defaultDisplayId ? s.settings.defaultDisplayId === d.id : false;
    const tags = [d.primary && 'Main', d.internal && 'Built-in', d.virtualGuess && 'Virtual'].filter(Boolean).map((t) => `<span class="tag">${t}</span>`).join(' ');
    return `<label class="display ${selected ? 'selected' : ''}">
      <input type="radio" name="disp" value="${d.id}" ${selected ? 'checked' : ''}>
      <div><div>${escapeHtml(d.label)} ${tags}</div>
      <div class="meta">${d.bounds.width}×${d.bounds.height} points, ${d.scaleFactor}× scale</div></div></label>`;
  }).join('') + '<p class="hint">If none is selected, DriveDesk picks a virtual or secondary display automatically. Choosing the main display mirrors it.</p>';
  document.querySelectorAll('input[name=disp]').forEach((el) => el.addEventListener('change', () => host.setSettings({ defaultDisplayId: Number(el.value) })));

  $('vd-mac').hidden = s.platform !== 'darwin';
  $('vd-win').hidden = s.platform !== 'win32';
  $('vd-status').innerHTML = s.vd.running
    ? `<span class="ok">Virtual display active (${s.vd.width}×${s.vd.height}).</span> Fine-tune text size in System Settings &gt; Displays.`
    : (s.vd.error ? `<span class="warn">${escapeHtml(s.vd.error)}</span>` : 'No virtual display yet.');

  $('fps').value = String(s.settings.fps);
  $('bitrate').value = String(s.settings.bitrateMbps);
  $('codec').value = s.settings.codec;
  $('scroll').value = String(s.settings.scrollSpeed);
  if (s.settings.vd) { $('scale').value = String(s.settings.vd.scale); const v = `${s.settings.vd.width}x${s.settings.vd.height}`; if ([...$('preset').options].some((o) => o.value === v)) $('preset').value = v; }

  $('sessions').innerHTML = s.sessions.length ? s.sessions.map((x) => {
    const disp = s.displays.find((d) => d.id === x.displayId);
    const st = x.stats;
    const statLine = st ? `${st.width}×${st.height}, ${st.fps} fps, ${(st.kbps / 1000).toFixed(1)} Mbps, ${st.codec || '?'}${st.encoder ? ' (' + st.encoder + ')' : ''}${st.rttMs != null ? ', ' + st.rttMs + ' ms RTT' : ''}${st.limitedBy && st.limitedBy !== 'none' ? ', limited by ' + st.limitedBy : ''}` : 'Connecting…';
    return `<div class="session"><div>${x.ip} showing ${escapeHtml(disp ? disp.label : 'display')}</div><div class="stats">${statLine}</div></div>`;
  }).join('') : '<div class="empty">No car or tablet connected.</div>';

  $('input-error').hidden = s.inputReady;
  $('input-error').textContent = s.inputError || '';
}

function escapeHtml(t) { return String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

$('regen').onclick = () => host.regeneratePin();
$('fps').onchange = (e) => host.setSettings({ fps: Number(e.target.value) });
$('bitrate').onchange = (e) => host.setSettings({ bitrateMbps: Number(e.target.value) });
$('codec').onchange = (e) => host.setSettings({ codec: e.target.value });
$('scroll').onchange = (e) => host.setSettings({ scrollSpeed: Number(e.target.value) });

$('vd-create').onclick = async () => {
  let w, h;
  if ($('preset').value === 'viewer') {
    const v = state && state.sessions[0] && state.sessions[0].viewport;
    if (!v) { $('vd-status').innerHTML = '<span class="warn">Connect the car browser first, then try again.</span>'; return; }
    w = Math.round(v.w * v.dpr); h = Math.round(v.h * v.dpr);
  } else {
    [w, h] = $('preset').value.split('x').map(Number);
  }
  $('vd-status').textContent = 'Adding virtual display…';
  const r = await host.createVirtualDisplay({ width: w, height: h, scale: Number($('scale').value) });
  if (!r.ok) $('vd-status').innerHTML = `<span class="warn">${escapeHtml(r.error || 'Failed')}</span>`;
};
$('vd-remove').onclick = () => host.removeVirtualDisplay();
$('login').onchange = (e) => host.setLaunchAtLogin(e.target.checked);

host.onState(render);
host.getState().then(render);
