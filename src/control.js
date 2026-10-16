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

// ---- Language: English / Traditional Chinese (follows the system unless chosen in the UI)
let LANG = null;
const T = (en, zh) => (LANG === 'zh' ? zh : en);
function applyLang(lang) {
  if (lang === LANG) return;
  LANG = lang;
  document.documentElement.lang = lang === 'zh' ? 'zh-Hant' : 'en';
  document.querySelectorAll('[data-zh]').forEach((el) => {
    if (el.dataset.en === undefined) el.dataset.en = el.innerHTML;
    el.innerHTML = lang === 'zh' ? el.dataset.zh : el.dataset.en;
  });
  document.querySelectorAll('[data-zh-placeholder]').forEach((el) => {
    if (el.dataset.enPlaceholder === undefined) el.dataset.enPlaceholder = el.placeholder;
    el.placeholder = lang === 'zh' ? el.dataset.zhPlaceholder : el.dataset.enPlaceholder;
  });
}

function render(s) {
  state = s;
  applyLang(s.lang || 'en');
  $('lang').value = s.settings.lang || 'auto';
  const pending = (s.setup || []).filter((c) => !c.ok);
  $('setup').hidden = pending.length === 0;
  $('checks').innerHTML = (s.setup || []).map((c) => `<div class="check">
      <span class="dot ${c.ok ? 'ok' : ''}" aria-label="${c.ok ? T('Done', '完成') : T('To do', '待辦')}"></span>
      <div><div>${escapeHtml(c.title)}</div><div class="detail">${escapeHtml(c.detail || '')}</div></div>
      ${!c.ok && c.fix ? `<button data-fix="${c.id}">${escapeHtml(c.fix)}</button>` : ''}
    </div>`).join('');
  document.querySelectorAll('[data-fix]').forEach((b) => { b.onclick = () => host.fixSetup(b.dataset.fix); });
  $('login').checked = !!s.launchAtLogin;
  // Car address first: only addresses outside 192.168/10/172.16 work in Tesla's browser.
  const carOk = s.urls.filter((u) => u.carReachable);
  const blocked = s.urls.filter((u) => !u.carReachable);
  if (s.port === null) {
    $('urls').innerHTML = `<div class="warn">${T("The server isn't running: the port is in use. Pick another port under Quality.", '伺服器未能啟動：連接埠已被佔用。請在「畫質」下選擇其他連接埠。')}</div>`;
  } else if (carOk.length) {
    $('urls').innerHTML = carOk.map((u) => `<div class="car-url" title="${escapeHtml(u.name)}: ${u.ip}">${u.carUrl}</div>`).join('') +
      blocked.map((u) => `<div class="url" style="font-size:14px;color:var(--muted)" title="${escapeHtml(u.name)}">${u.url} ${T('(phones and laptops)', '（手機及電腦用）')}</div>`).join('');
    $('url-hint').textContent = T("Type the orange address in the car's browser while parked. The others work for phones, tablets, and laptops.", '泊好車後，在汽車瀏覽器輸入橙色地址。其他地址適用於手機、平板及電腦。');
  } else if (blocked.length) {
    $('urls').innerHTML = blocked.map((u) => `<div class="url" title="${escapeHtml(u.name)}">${u.url}</div>`).join('');
    $('url-hint').textContent = T('This address works for phones, tablets, and laptops. For a Tesla, set up the car hotspot below.', '此地址適用於手機、平板及電腦。如要用於 Tesla，請在下方設定車用熱點。');
  } else {
    $('urls').innerHTML = `<div class="warn">${T('No network connection. Join a Wi-Fi network or hotspot.', '未連接網絡。請連接 Wi-Fi 或熱點。')}</div>`;
  }
  $('car-net').hidden = carOk.length > 0;
  $('steps-mac').hidden = s.platform !== 'darwin';
  $('steps-win').hidden = s.platform !== 'win32';
  if (blocked[0]) $('blocked-ip').textContent = blocked[0].ip;
  if ($('car-range').dataset.lang !== LANG) {
    $('car-range').dataset.lang = LANG;
    $('car-range').innerHTML = Object.entries(s.carRanges).map(([v, label]) => `<option value="${v}">${escapeHtml(label)}</option>`).join('');
  }
  $('car-range').value = s.settings.carRange;

  // Extend / mirror
  $('mode').value = s.settings.mode || 'extend';
  $('position').value = (s.settings.vd && s.settings.vd.position) || 'right';
  $('position-field').hidden = s.platform !== 'darwin' || $('mode').value === 'mirror';
  $('mode-hint').textContent = $('mode').value === 'mirror'
    ? T('The car shows exactly what is on your main screen.', '汽車會顯示與主螢幕完全相同的畫面。')
    : (s.platform === 'darwin'
        ? T('The car is its own screen: drag windows past the edge of your screen to move them to the car.', '汽車是一個獨立螢幕：把視窗拖過螢幕邊緣，即可移到汽車上。')
        : T('Needs a virtual monitor driver (see the setup list). Without one, the car mirrors your main screen.', '需要虛擬顯示器驅動程式（見設定清單）。未安裝時，汽車會鏡像顯示主螢幕。'));

  // Port
  if (document.activeElement !== $('port')) $('port').value = s.settings.port || '';
  $('port').disabled = $('port-apply').disabled = !!s.portFromEnv;
  $('port-status').textContent = s.port ? T(`Running on port ${s.port}`, `正在使用連接埠 ${s.port}`) : '';
  $('pin').textContent = s.pin;

  $('displays').innerHTML = s.displays.map((d) => {
    const selected = s.settings.defaultDisplayId ? s.settings.defaultDisplayId === d.id : false;
    const tags = [d.primary && T('Main', '主螢幕'), d.internal && T('Built-in', '內置'), d.virtualGuess && T('Virtual', '虛擬')].filter(Boolean).map((t) => `<span class="tag">${t}</span>`).join(' ');
    return `<label class="display ${selected ? 'selected' : ''}">
      <input type="radio" name="disp" value="${d.id}" ${selected ? 'checked' : ''}>
      <div><div>${escapeHtml(d.label)} ${tags}</div>
      <div class="meta">${T(`${d.bounds.width}×${d.bounds.height} points, ${d.scaleFactor}× scale`, `${d.bounds.width}×${d.bounds.height} 點，${d.scaleFactor}× 縮放`)}</div></div></label>`;
  }).join('') + `<p class="hint">${T('If none is selected, DriveDesk picks a virtual or secondary display automatically. Choosing the main display mirrors it.', '如未選擇，DriveDesk 會自動選用虛擬或第二個顯示器。選擇主顯示器即為鏡像。')}</p>`;
  document.querySelectorAll('input[name=disp]').forEach((el) => el.addEventListener('change', () => host.setSettings({ defaultDisplayId: Number(el.value) })));

  $('vd-mac').hidden = s.platform !== 'darwin';
  $('vd-win').hidden = s.platform !== 'win32';
  $('vd-status').innerHTML = s.vd.running
    ? T(`<span class="ok">Virtual display active (${s.vd.width}×${s.vd.height}).</span> Fine-tune text size in System Settings &gt; Displays.`,
        `<span class="ok">虛擬顯示器已啟用（${s.vd.width}×${s.vd.height}）。</span>可在系統設定 &gt; 顯示器微調文字大小。`)
    : (s.vd.error ? `<span class="warn">${escapeHtml(s.vd.error)}</span>` : T('No virtual display yet.', '尚未加入虛擬顯示器。'));

  $('fps').value = String(s.settings.fps);
  $('bitrate').value = String(s.settings.bitrateMbps);
  $('codec').value = s.settings.codec;
  $('scroll').value = String(s.settings.scrollSpeed);
  if (s.settings.vd) { $('scale').value = String(s.settings.vd.scale); const v = `${s.settings.vd.width}x${s.settings.vd.height}`; if ([...$('preset').options].some((o) => o.value === v)) $('preset').value = v; }

  $('sessions').innerHTML = s.sessions.length ? s.sessions.map((x) => {
    const disp = s.displays.find((d) => d.id === x.displayId);
    const st = x.stats;
    const statLine = st ? `${st.width}×${st.height}, ${st.fps} fps, ${(st.kbps / 1000).toFixed(1)} Mbps, ${st.codec || '?'}${st.encoder ? ' (' + st.encoder + ')' : ''}${st.rttMs != null ? ', ' + st.rttMs + ' ms RTT' : ''}${st.limitedBy && st.limitedBy !== 'none' ? T(', limited by ', '，受限於 ') + st.limitedBy : ''}` : T('Connecting…', '連線中…');
    const name = escapeHtml(disp ? disp.label : T('display', '顯示器'));
    return `<div class="session"><div>${T(`${x.ip} showing ${name}`, `${x.ip} 正在顯示 ${name}`)}</div><div class="stats">${statLine}</div></div>`;
  }).join('') : `<div class="empty">${T('No car or tablet connected.', '未有汽車或平板連接。')}</div>`;

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
    if (!v) { $('vd-status').innerHTML = `<span class="warn">${T('Connect the car browser first, then try again.', '請先連接汽車瀏覽器，然後再試。')}</span>`; return; }
    w = Math.round(v.w * v.dpr); h = Math.round(v.h * v.dpr);
  } else {
    [w, h] = $('preset').value.split('x').map(Number);
  }
  $('vd-status').textContent = T('Adding virtual display…', '正在加入虛擬顯示器…');
  const r = await host.createVirtualDisplay({ width: w, height: h, scale: Number($('scale').value) });
  if (!r.ok) $('vd-status').innerHTML = `<span class="warn">${escapeHtml(r.error || T('Failed', '失敗'))}</span>`;
};
$('vd-remove').onclick = () => host.removeVirtualDisplay();
$('login').onchange = (e) => host.setLaunchAtLogin(e.target.checked);

$('port-apply').onclick = async () => {
  $('port-status').textContent = T('Restarting…', '正在重新啟動…');
  const r = await host.setPort($('port').value.trim());
  $('port-status').innerHTML = r.ok ? T(`Running on port ${r.port}`, `正在使用連接埠 ${r.port}`) : `<span class="warn">${escapeHtml(r.error)}</span>`;
};

$('car-prepare').onclick = async () => {
  $('car-status').textContent = T('Waiting for your password…', '正在等待輸入密碼…');
  const r = await host.carPrepare($('car-range').value);
  $('car-status').innerHTML = r.ok
    ? `<span class="ok">${T('Done.', '完成。')}</span> ${escapeHtml(r.next)} ${T('The orange car address appears at the top once the hotspot is on.', '熱點開啟後，橙色的車用地址會在頂部顯示。')}`
    : `<span class="warn">${escapeHtml(r.error || T('Failed', '失敗'))}</span>`;
};
$('open-sharing').onclick = () => host.openSharing();

async function applyMode() {
  $('mode-hint').textContent = T('Updating…', '更新中…');
  await host.setMode({ mode: $('mode').value, position: $('position').value });
}
$('mode').onchange = applyMode;
$('lang').onchange = (e) => host.setSettings({ lang: e.target.value });
$('position').onchange = applyMode;

host.onState(render);
host.getState().then(render);
