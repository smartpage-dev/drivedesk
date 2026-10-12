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

// Expose real LAN IPs in ICE candidates. Chromium hides them behind mDNS names by default,
// and the Tesla browser can't always resolve those on a phone hotspot.
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');
// Keep capturing/encoding at full speed even when the control window is hidden or covered.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

// Try port 80 first so the car only needs "http://192.168.x.x"; fall back to 8787.
const PORTS = process.env.DRIVEDESK_PORT ? [Number(process.env.DRIVEDESK_PORT)] : [80, 8787];
let PORT = null;
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
  vd: { width: 2200, height: 1300, scale: 1.5 } // Model S/X 2021+ default
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
      if (a.family === 'IPv4' && !a.internal) out.push({ name, url: PORT === 80 ? `http://${a.address}` : `http://${a.address}:${PORT}` });
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
    settings: { defaultDisplayId: config.defaultDisplayId, fps: config.fps, bitrateMbps: config.bitrateMbps, codec: config.codec, scrollSpeed: config.scrollSpeed, vd: config.vd },
    displays: displayList(),
    sessions: [...sessions.entries()].map(([id, s]) => ({ id, ip: s.ip, displayId: s.displayId, viewport: s.viewport, stats: s.stats || null })),
    vd: vdisplay.status(),
    inputReady: input.ready,
    inputError: input.error || null,
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
    items.push({ id: 'screen', ok: screenOk, title: 'Screen Recording permission', fix: 'Open settings', detail: 'Needed to stream the display. After turning it on, quit and reopen DriveDesk.' });
    items.push({ id: 'accessibility', ok: axOk, title: 'Accessibility permission', fix: 'Allow', detail: 'Needed so taps on the car screen can click on your Mac.' });
    const vd = vdisplay.status();
    items.push({ id: 'vd', ok: vd.running, title: 'Virtual display', fix: 'Add display', detail: vd.error || 'Gives the car its own screen instead of a copy of yours.' });
  } else if (process.platform === 'win32') {
    const hasVirtual = displayList().some((d) => d.virtualGuess || (!d.primary && !d.internal));
    items.push({ id: 'driver', ok: hasVirtual, title: 'Virtual monitor (optional)', fix: 'Get driver', detail: 'Without it, the car mirrors your main screen. With it, the car becomes a second screen.' });
  }
  items.push({ id: 'network', ok: lanUrls().length > 0, title: 'Network connection', fix: null, detail: 'Join the same Wi-Fi or hotspot as the car.' });
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
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const entry = STATIC[url.pathname];
  if (!entry) { res.writeHead(404); return res.end('Not found'); }
  fs.readFile(path.join(VIEWER_DIR, entry[0]), (err, buf) => {
    if (err) { res.writeHead(500); return res.end('Error'); }
    res.writeHead(200, { 'Content-Type': entry[1], 'Cache-Control': 'no-store' });
    res.end(buf);
  });
});

// ---------- WebSocket (signaling + input) ----------
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 1 << 20 });
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
  const allowed = ['defaultDisplayId', 'fps', 'bitrateMbps', 'codec', 'scrollSpeed', 'vd'];
  for (const k of allowed) if (k in patch) config[k] = patch[k];
  saveConfig(); broadcastState();
  return publicState();
});
ipcMain.handle('regen-pin', () => { config.pin = newPin(); saveConfig(); broadcastState(); return config.pin; });
ipcMain.handle('vd-create', async (_e, opts) => {
  const result = await vdisplay.start(opts || config.vd);
  if (result.ok) {
    config.vd = { ...config.vd, ...(opts || {}) };
    if (result.displayId) config.defaultDisplayId = result.displayId;
    saveConfig();
  }
  setTimeout(broadcastState, 500);
  return result;
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
  if (process.platform === 'darwin') vdisplay.start(config.vd).then((r) => { if (r.ok && r.displayId) { config.defaultDisplayId = r.displayId; saveConfig(); } broadcastState(); });
  setInterval(broadcastState, 3000); // pick up permission / network changes
});

function listen(i) {
  const port = PORTS[i];
  const onError = (err) => {
    if (i + 1 < PORTS.length) { console.warn(`port ${port} unavailable (${err.code}), trying ${PORTS[i + 1]}`); listen(i + 1); }
    else console.error('Could not start server', err);
  };
  server.once('error', onError);
  server.listen(port, '0.0.0.0', () => {
    PORT = port;
    server.removeListener('error', onError);
    console.log('DriveDesk listening on', lanUrls().map((u) => u.url).join(', '));
    broadcastState();
  });
}

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { vdisplay.stop(); input.releaseAll(); });
