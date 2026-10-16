'use strict';
/**
 * DriveDesk host (Electron main process)
 *
 *  Tesla browser  ──HTTP──▶  this server (serves viewer page)
 *                 ──WS────▶  signaling + touch/mouse input
 *                 ◀─WebRTC─  video of the chosen display (sent by control window renderer)
 *
 * Nothing leaves your local network: no cloud relay, no account.
 */
const { app, BrowserWindow, ipcMain, desktopCapturer, screen, session, powerSaveBlocker, systemPreferences, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const input = require('./input');
const vdisplay = require('./vdisplay');
const carnet = require('./carnet');

// Expose real LAN IPs in ICE candidates. Chromium hides them behind mDNS names by default,
// and the Tesla browser can't always resolve those on a phone hotspot.
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');
// Keep capturing/encoding at full speed even when the control window is hidden or covered.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

// Port: env var > setting in the UI > automatic (80 so the address needs no ":port", else 8787).
function portList() {
  if (process.env.DRIVEDESK_PORT) return [Number(process.env.DRIVEDESK_PORT)];
  if (config.port) return [config.port];
  return [80, 8787];
}
let PORT = null;

// ---- UI language
function uiLang() {
  if (config.lang === 'en' || config.lang === 'zh') return config.lang;
  return String(app.getLocale() || '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
}
const tr = (en, zh) => (uiLang() === 'zh' ? zh : en);
/** Translates the fixed English messages that come from helper modules. */
function trMsg(msg) {
  if (!msg || uiLang() !== 'zh') return msg;
  const known = [
    [/^On Windows, add the virtual display/, '在 Windows 上，請用虛擬顯示器驅動程式加入虛擬顯示器（見 native/windows/README.md）。'],
    [/^Helper not built/, '輔助程式未建置。請執行：npm run build:mac-helper'],
    [/^Timed out waiting for the virtual display/, '等待虛擬顯示器逾時。'],
    [/^Helper exited with code (\d+)/, '輔助程式已結束（代碼 $1）。'],
    [/^Input injection is only implemented/, '只支援在 macOS 及 Windows 上控制滑鼠。'],
    [/^Could not load native input bindings/, '無法載入滑鼠控制元件（koffi）。']
  ];
  for (const [re, zh] of known) if (re.test(msg)) return msg.replace(re, zh).replace(/^(.*?。).*$/s, '$1');
  return msg;
}
/** Port used in car addresses: the shared 8787 whenever it's available. */
function carPort() { return PORT === 8787 || PORT2 === 8787 ? 8787 : PORT; }
const VIEWER_DIR = path.join(__dirname, 'viewer');
const MAX_SESSIONS = 3;

// ---------- persisted config ----------
const configPath = () => path.join(app.getPath('userData'), 'config.json');
const defaults = {
  pin: newPin(),
  defaultDisplayId: null,
  fps: 60,
  bitrateMbps: 12,
  codec: 'H264',          // H264 | VP9 | VP8 | AV1  (negotiation falls back automatically)
  scrollSpeed: 1.0,
  vd: { width: 2200, height: 1300, scale: 1.5, position: 'right' }, // Model S/X 2021+ default
  port: null,            // null = automatic
  mode: 'extend',        // 'extend' (car is a second screen) | 'mirror' (car copies the main screen)
  carRange: '100.99.0.1', // hotspot range outside RFC 1918, which Tesla's browser blocks
  lang: 'auto'           // 'auto' (follow the system) | 'en' | 'zh' (Traditional Chinese)
};
let config = { ...defaults };

function newPin() { return String(crypto.randomInt(0, 1000000)).padStart(6, '0'); }
function loadConfig() {
  try { config = { ...defaults, ...JSON.parse(fs.readFileSync(configPath(), 'utf8')) }; }
  catch { config = { ...defaults }; saveConfig(); }
}
function saveConfig() {
  try { fs.mkdirSync(path.dirname(configPath()), { recursive: true }); fs.writeFileSync(configPath(), JSON.stringify(config, null, 2)); }
  catch (e) { console.error('config save failed', e); }
}

// ---------- state ----------
let win = null;
const sessions = new Map(); // id -> { ws, ip, displayId, viewport, stats }
const pinFails = new Map(); // ip -> { count, until }
let powerBlockId = null;

function lanUrls() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, ...carnet.describe(a.address, PORT, carPort()) });
    }
  }
  return out;
}

function displayList() {
  const primaryId = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((d, i) => ({
    id: d.id,
    index: i,
    label: d.label || `Display ${i + 1}`,
    bounds: d.bounds,
    scaleFactor: d.scaleFactor,
    primary: d.id === primaryId,
    internal: !!d.internal,
    virtualGuess: /drivedesk|virtual|idd|vdd|parsec|dummy/i.test(d.label || '')
  }));
}

function pickDefaultDisplay(exclude = []) {
  const list = displayList();
  const byId = (id) => list.find((d) => d.id === id);
  if (config.defaultDisplayId && byId(config.defaultDisplayId) && !exclude.includes(config.defaultDisplayId)) return byId(config.defaultDisplayId);
  const free = list.filter((d) => !exclude.includes(d.id));
  return free.find((d) => d.virtualGuess) || free.find((d) => !d.primary && !d.internal) || free.find((d) => !d.primary) || list.find((d) => d.primary);
}

function getDisplay(id) { return screen.getAllDisplays().find((d) => d.id === id) || null; }

function publicState() {
  return {
    platform: process.platform,
    port: PORT,
    urls: lanUrls(),
    pin: config.pin,
    settings: { defaultDisplayId: config.defaultDisplayId, fps: config.fps, bitrateMbps: config.bitrateMbps, codec: config.codec, scrollSpeed: config.scrollSpeed, vd: config.vd, port: config.port, mode: config.mode, carRange: config.carRange, lang: config.lang },
    lang: uiLang(),
    carRanges: carnet.ranges(uiLang()),
    portFromEnv: !!process.env.DRIVEDESK_PORT,
    displays: displayList(),
    sessions: [...sessions.entries()].map(([id, s]) => ({ id, ip: s.ip, displayId: s.displayId, viewport: s.viewport, stats: s.stats || null })),
    vd: { ...vdisplay.status(), error: trMsg(vdisplay.status().error) },
    inputReady: input.ready,
    inputError: trMsg(input.error) || null,
    setup: setupChecks(),
    launchAtLogin: app.getLoginItemSettings().openAtLogin
  };
}

// ---------- first-run checklist ----------
function setupChecks() {
  const items = [];
  if (process.platform === 'darwin') {
    const screenOk = systemPreferences.getMediaAccessStatus('screen') === 'granted';
    const axOk = systemPreferences.isTrustedAccessibilityClient(false);
    items.push({ id: 'screen', ok: screenOk, title: tr('Screen Recording permission', '螢幕錄製權限'), fix: tr('Open settings', '開啟設定'),
      detail: tr('Needed to stream the display. After turning it on, quit and reopen DriveDesk.', '串流畫面需要此權限。開啟後，請結束並重新開啟 DriveDesk。') });
    items.push({ id: 'accessibility', ok: axOk, title: tr('Accessibility permission', '輔助使用權限'), fix: tr('Allow', '允許'),
      detail: tr('Needed so taps on the car screen can click on your Mac.', '讓汽車螢幕上的點按可以操作你的 Mac。') });
    const vd = vdisplay.status();
    items.push({ id: 'vd', ok: vd.running, title: tr('Virtual display', '虛擬顯示器'), fix: tr('Add display', '加入顯示器'),
      detail: trMsg(vd.error) || tr('Gives the car its own screen instead of a copy of yours.', '讓汽車擁有獨立螢幕，而不是複製你的畫面。') });
  } else if (process.platform === 'win32') {
    const hasVirtual = displayList().some((d) => d.virtualGuess || (!d.primary && !d.internal));
    items.push({ id: 'driver', ok: hasVirtual, title: tr('Virtual monitor (optional)', '虛擬顯示器（可選）'), fix: tr('Get driver', '下載驅動程式'),
      detail: tr('Without it, the car mirrors your main screen. With it, the car becomes a second screen.', '未安裝時，汽車會鏡像顯示主螢幕；安裝後，汽車會成為第二個螢幕。') });
  }
  const urls = lanUrls();
  items.push({ id: 'network', ok: urls.some((u) => u.carReachable), title: tr('Car-compatible network', '汽車可連接的網絡'), fix: null,
    detail: urls.length ? tr('Tesla blocks home-network addresses like 192.168.x.x. Set up the car hotspot below.', 'Tesla 會封鎖 192.168.x.x 這類家用網絡地址。請在下方設定車用熱點。')
                        : tr('Not connected to any network.', '未連接任何網絡。') });
  return items;
}

ipcMain.handle('fix-setup', async (_e, id) => {
  if (id === 'screen') {
    // Calling getSources registers the app in the Screen Recording list, then we open the pane.
    try { await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } }); } catch {}
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
  } else if (id === 'accessibility') {
    systemPreferences.isTrustedAccessibilityClient(true); // shows the system prompt
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
  } else if (id === 'vd') {
    const r = await vdisplay.start(config.vd);
    if (r.ok && r.displayId) { config.defaultDisplayId = r.displayId; saveConfig(); }
  } else if (id === 'driver') {
    shell.openExternal('https://github.com/VirtualDrivers/Virtual-Display-Driver/releases');
  }
  setTimeout(broadcastState, 800);
  return publicState();
});
ipcMain.handle('set-login', (_e, on) => { app.setLoginItemSettings({ openAtLogin: !!on }); return publicState(); });

ipcMain.handle('set-port', async (_e, port) => {
  const p = port === null || port === '' || Number(port) === 0 ? null : Math.round(Number(port));
  if (p !== null && (!(p === 80 || (p >= 1024 && p <= 65535)))) return { ok: false, error: tr('Use 80, or a number from 1024 to 65535.', '請使用 80，或 1024 至 65535 之間的數字。') };
  config.port = p; saveConfig();
  await restartServer();
  return { ok: PORT !== null, port: PORT, error: PORT === null ? tr('That port is in use by another app. Try another.', '該連接埠已被其他程式使用，請試另一個。') : null };
});

ipcMain.handle('car-prepare', async (_e, range) => {
  if (range && carnet.RANGE_IDS.includes(range)) { config.carRange = range; saveConfig(); }
  const r = await carnet.prepareHotspot(config.carRange, uiLang());
  if (r.ok) shell.openExternal(carnet.sharingSettingsUrl());
  setTimeout(broadcastState, 1000);
  return r;
});
ipcMain.handle('open-sharing', () => shell.openExternal(carnet.sharingSettingsUrl()));

ipcMain.handle('set-mode', async (_e, { mode, position }) => {
  if (position) config.vd = { ...config.vd, position };
  if (mode === 'mirror') {
    config.mode = 'mirror';
    await vdisplay.stop();
    config.defaultDisplayId = screen.getPrimaryDisplay().id;
  } else {
    config.mode = 'extend';
    if (config.defaultDisplayId === screen.getPrimaryDisplay().id) config.defaultDisplayId = null;
    if (process.platform === 'darwin') {
      const r = await vdisplay.start(config.vd);
      if (r.ok && r.displayId) config.defaultDisplayId = r.displayId;
    }
  }
  saveConfig();
  setTimeout(broadcastState, 600);
  return publicState();
});
let lastState = '';
function broadcastState() {
  if (!win || win.isDestroyed()) return;
  const st = publicState(), json = JSON.stringify(st);
  if (json === lastState) return; // avoid re-rendering the UI when nothing changed
  lastState = json;
  win.webContents.send('state', st);
}

function updatePowerBlock() {
  if (sessions.size && powerBlockId === null) powerBlockId = powerSaveBlocker.start('prevent-display-sleep');
  if (!sessions.size && powerBlockId !== null) { powerSaveBlocker.stop(powerBlockId); powerBlockId = null; }
}

// ---------- HTTP (viewer page) ----------
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/viewer.js': ['viewer.js', 'application/javascript; charset=utf-8'],
  '/viewer.css': ['viewer.css', 'text/css; charset=utf-8']
};
function handleHttp(req, res) {
  const url = new URL(req.url, 'http://x');
  const entry = STATIC[url.pathname];
  if (!entry) { res.writeHead(404); return res.end('Not found'); }
  fs.readFile(path.join(VIEWER_DIR, entry[0]), (err, buf) => {
    if (err) { res.writeHead(500); return res.end('Error'); }
    res.writeHead(200, { 'Content-Type': entry[1], 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}
const server = http.createServer(handleHttp);
// Always also listen on 8787, so every DriveDesk (Mac, PC, Android) can share one car address:
// http://100-99-0-1.sslip.io:8787 on the DriveDesk hotspot range. Saved once as a car favourite.
const UNIVERSAL_PORT = 8787;
const server2 = http.createServer(handleHttp);
let PORT2 = null;

// ---------- WebSocket (signaling + input) ----------
const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
for (const srv of [server, server2]) {
  srv.on('upgrade', (req, socket, head) => {
    if (new URL(req.url, 'http://x').pathname !== '/ws') return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
}
// ws re-emits HTTP server errors (e.g. port 80 refused); handled by listen() fallback, so just log here.
wss.on('error', (e) => console.warn('ws:', e.code || e.message));

wss.on('connection', (ws, req) => {
  const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  let sessionId = null;
  try { req.socket.setNoDelay(true); } catch {}

  const send = (obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ---- authentication ----
    if (!sessionId) {
      if (msg.t !== 'hello') return ws.close();
      const fail = pinFails.get(ip);
      if (fail && fail.until > Date.now()) { send({ t: 'error', code: 'locked', retryInSec: Math.ceil((fail.until - Date.now()) / 1000) }); return ws.close(); }
      if (String(msg.pin) !== config.pin) {
        const f = pinFails.get(ip) || { count: 0, until: 0 };
        f.count += 1;
        if (f.count >= 5) { f.until = Date.now() + 60_000; f.count = 0; }
        pinFails.set(ip, f);
        send({ t: 'error', code: 'pin' });
        return ws.close();
      }
      pinFails.delete(ip);
      if (sessions.size >= MAX_SESSIONS) { send({ t: 'error', code: 'full' }); return ws.close(); }

      const taken = [...sessions.values()].map((s) => s.displayId);
      const wanted = msg.displayId ? displayList().find((d) => d.id === Number(msg.displayId)) : null;
      const target = wanted || pickDefaultDisplay(taken);

      sessionId = crypto.randomUUID();
      sessions.set(sessionId, { ws, ip, displayId: target.id, viewport: msg.viewport || null, stats: null });
      send({ t: 'welcome', sessionId, displayId: target.id, displays: displayList().map(({ id, label, primary }) => ({ id, label, primary })) });
      updatePowerBlock();
      await startSession(sessionId);
      broadcastState();
      return;
    }

    const s = sessions.get(sessionId);
    if (!s) return;

    switch (msg.t) {
      case 'signal':
        win && win.webContents.send('signal', { sessionId, data: msg.data });
        break;
      case 'viewport':
        s.viewport = msg.viewport; broadcastState();
        break;
      case 'switch-display': {
        const d = displayList().find((x) => x.id === Number(msg.displayId));
        if (!d) break;
        s.displayId = d.id;
        win && win.webContents.send('session-end', { sessionId });
        send({ t: 'restart', displayId: d.id });
        await startSession(sessionId);
        broadcastState();
        break;
      }
      default:
        handleInput(s, msg);
    }
  });

  ws.on('close', () => {
    if (!sessionId) return;
    sessions.delete(sessionId);
    input.releaseAll();
    win && win.webContents.send('session-end', { sessionId });
    updatePowerBlock();
    broadcastState();
  });
});

async function startSession(sessionId) {
  const s = sessions.get(sessionId);
  if (!s || !win) return;
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
  const list = displayList();
  let source = sources.find((src) => String(src.display_id) === String(s.displayId));
  if (!source) {
    // Some Windows setups return empty display_id; fall back to the same index ordering.
    const idx = list.findIndex((d) => d.id === s.displayId);
    source = sources[idx] || sources[0];
  }
  const d = getDisplay(s.displayId) || screen.getPrimaryDisplay();
  const vp = s.viewport || {};
  // Cap capture size at the viewer's real pixel size: sharp text, no wasted bandwidth.
  const maxW = Math.round((vp.w || d.size.width) * (vp.dpr || 1));
  const maxH = Math.round((vp.h || d.size.height) * (vp.dpr || 1));
  win.webContents.send('session-start', {
    sessionId,
    sourceId: source.id,
    maxWidth: Math.max(640, Math.min(maxW, 3840)),
    maxHeight: Math.max(360, Math.min(maxH, 2160)),
    fps: config.fps,
    bitrate: config.bitrateMbps * 1_000_000,
    codec: config.codec
  });
}

// ---------- input mapping ----------
function toGlobalPoint(displayId, nx, ny) {
  const d = getDisplay(displayId);
  if (!d) return null;
  const b = d.bounds;
  const x = b.x + Math.min(Math.max(nx, 0), 0.9999) * b.width;
  const y = b.y + Math.min(Math.max(ny, 0), 0.9999) * b.height;
  if (process.platform === 'win32') {
    // Windows APIs want physical pixels; Electron gives DIPs.
    const p = screen.dipToScreenPoint({ x, y });
    return { x: Math.round(p.x), y: Math.round(p.y) };
  }
  return { x, y };
}

function cursorNow() {
  const p = screen.getCursorScreenPoint();
  if (process.platform === 'win32') { const q = screen.dipToScreenPoint(p); return { x: q.x, y: q.y }; }
  return p;
}

function handleInput(s, msg) {
  if (!input.ready) return;
  const btn = msg.b === 2 ? 'right' : 'left';
  switch (msg.t) {
    case 'move': { const p = toGlobalPoint(s.displayId, msg.x, msg.y); if (p) input.move(p.x, p.y); break; }
    case 'rel': { const c = cursorNow(); input.move(c.x + msg.dx, c.y + msg.dy); break; }
    case 'down': input.down(btn); break;
    case 'up': input.up(btn); break;
    case 'click': {
      if (typeof msg.x === 'number') { const p = toGlobalPoint(s.displayId, msg.x, msg.y); if (p) input.move(p.x, p.y); }
      input.click(btn);
      break;
    }
    case 'scroll': input.scroll((msg.dx || 0) * config.scrollSpeed, (msg.dy || 0) * config.scrollSpeed); break;
  }
}

// ---------- IPC with control window ----------
ipcMain.on('signal', (_e, { sessionId, data }) => {
  const s = sessions.get(sessionId);
  if (s && s.ws.readyState === 1) s.ws.send(JSON.stringify({ t: 'signal', data }));
});
ipcMain.on('stats', (_e, { sessionId, stats }) => {
  const s = sessions.get(sessionId);
  if (s) { s.stats = stats; broadcastState(); }
});
ipcMain.handle('get-state', () => publicState());
ipcMain.handle('set-settings', (_e, patch) => {
  const allowed = ['defaultDisplayId', 'fps', 'bitrateMbps', 'codec', 'scrollSpeed', 'vd', 'lang'];
  for (const k of allowed) if (k in patch) config[k] = patch[k];
  saveConfig(); broadcastState();
  return publicState();
});
ipcMain.handle('regen-pin', () => { config.pin = newPin(); saveConfig(); broadcastState(); return config.pin; });
ipcMain.handle('vd-create', async (_e, opts) => {
  const result = await vdisplay.start({ ...config.vd, ...(opts || {}) });
  if (result.ok) {
    config.vd = { ...config.vd, ...(opts || {}) };
    config.mode = 'extend';
    if (result.displayId) config.defaultDisplayId = result.displayId;
    saveConfig();
  }
  setTimeout(broadcastState, 500);
  return { ...result, error: trMsg(result.error) };
});
ipcMain.handle('vd-remove', () => { vdisplay.stop(); setTimeout(broadcastState, 500); return true; });

// ---------- app lifecycle ----------
function createWindow() {
  win = new BrowserWindow({
    width: 760, height: 820, minWidth: 560,
    title: 'DriveDesk',
    backgroundColor: '#1c2733',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  });
  win.loadFile(path.join(__dirname, 'control.html'));
}

app.whenReady().then(() => {
  loadConfig();
  // Allow screen capture only for our own control window.
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(wc === (win && win.webContents) && permission === 'media'));
  createWindow();
  listen(0);
  for (const ev of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(ev, broadcastState);
  // Zero-click setup on macOS: bring back the virtual display from last time.
  if (process.platform === 'darwin' && config.mode !== 'mirror') vdisplay.start(config.vd).then((r) => { if (r.ok && r.displayId) { config.defaultDisplayId = r.displayId; saveConfig(); } broadcastState(); });
  setInterval(broadcastState, 3000); // pick up permission / network changes
});

function listen(i, done) {
  const ports = portList();
  const port = ports[i];
  const onError = (err) => {
    if (i + 1 < ports.length) { console.warn(`port ${port} unavailable (${err.code}), trying ${ports[i + 1]}`); listen(i + 1, done); }
    else { console.error('Could not start server', err); PORT = null; broadcastState(); if (done) done(); }
  };
  server.once('error', onError);
  server.listen(port, '0.0.0.0', () => {
    PORT = port;
    server.removeListener('error', onError);
    console.log('DriveDesk listening on', lanUrls().map((u) => u.url).join(', '));
    listenSecondary();
    broadcastState();
    if (done) done();
  });
}

function listenSecondary() {
  if (PORT === UNIVERSAL_PORT || PORT2 !== null || process.env.DRIVEDESK_PORT) return;
  const onErr = (e) => console.warn(`shared port ${UNIVERSAL_PORT} unavailable (${e.code})`);
  server2.once('error', onErr);
  server2.listen(UNIVERSAL_PORT, '0.0.0.0', () => { server2.removeListener('error', onErr); PORT2 = UNIVERSAL_PORT; broadcastState(); });
}

/** Re-binds the server after the port setting changes. Connected screens reconnect automatically. */
function restartServer() {
  return new Promise((resolve) => {
    for (const s of sessions.values()) { try { s.ws.close(); } catch {} }
    PORT = null;
    if (PORT2 !== null) { PORT2 = null; server2.close(); if (server2.closeAllConnections) server2.closeAllConnections(); }
    server.close(() => listen(0, resolve));
    // close() waits for open keep-alive sockets; don't hang forever on them.
    if (server.closeAllConnections) server.closeAllConnections();
  });
}

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { vdisplay.stop(); input.releaseAll(); });
