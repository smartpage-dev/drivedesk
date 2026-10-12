'use strict';
/**
 * macOS: spawns native/macos/build/vdisplay, which creates a CGVirtualDisplay that lives
 * exactly as long as the helper process. Killing the helper removes the display.
 * Windows: virtual displays come from an Indirect Display Driver (see native/windows/README.md).
 */
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

let proc = null;
let state = { running: false, displayId: null, error: null, width: null, height: null };
let chain = Promise.resolve(); // serialize start/stop so two requests never overlap

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function helperPath() {
  const packaged = process.resourcesPath ? path.join(process.resourcesPath, 'vdisplay') : null;
  if (packaged && fs.existsSync(packaged)) return packaged;
  return path.join(__dirname, '..', 'native', 'macos', 'build', 'vdisplay');
}

function waitExit(child, ms) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
    const t = setTimeout(resolve, ms);
    child.once('exit', () => { clearTimeout(t); resolve(); });
  });
}

/** Helpers left behind by a crashed or replaced DriveDesk keep their display alive and block a new one. */
function killStrayHelpers() {
  try { execFileSync('/usr/bin/pkill', ['-x', 'vdisplay'], { stdio: 'ignore' }); return true; } catch { return false; }
}

async function stopNow() {
  const child = proc;
  proc = null;
  state = { ...state, running: false, displayId: null };
  if (child) {
    try { child.kill('SIGTERM'); } catch {}
    await waitExit(child, 2000);
  }
}

function spawnHelper(bin, { width, height, scale, position }) {
  return new Promise((resolve) => {
    let settled = false;
    let stderr = '';
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    const child = spawn(bin, ['--width', String(width), '--height', String(height), '--scale', String(scale),
      '--position', String(position), '--name', 'DriveDesk Display'], { stdio: ['ignore', 'pipe', 'pipe'] });
    proc = child;
    child.stdout.on('data', (buf) => {
      const m = /READY (\d+)/.exec(String(buf));
      if (m && proc === child) {
        state = { running: true, displayId: Number(m[1]), error: null, width, height };
        done({ ok: true, displayId: state.displayId });
      }
    });
    child.stderr.on('data', (buf) => { stderr += String(buf); });
    child.on('exit', (code) => {
      if (proc === child) { // ignore exits of helpers we already replaced
        proc = null;
        state = { ...state, running: false, displayId: null, error: code ? (stderr.trim() || `Helper exited with code ${code}`) : null };
      }
      done({ ok: false, error: stderr.trim() || `Helper exited with code ${code}` });
    });
    setTimeout(() => done({ ok: false, error: 'Timed out waiting for the virtual display.' }), 8000);
  });
}

async function startNow({ width = 2200, height = 1300, scale = 1.5, position = 'right' } = {}) {
  if (process.platform !== 'darwin') {
    state = { ...state, error: 'On Windows, add the virtual display with a virtual display driver (see native/windows/README.md).' };
    return { ok: false, error: state.error };
  }
  const bin = helperPath();
  if (!fs.existsSync(bin)) {
    state = { ...state, error: 'Helper not built. Run: npm run build:mac-helper' };
    return { ok: false, error: state.error };
  }
  const opts = { width, height, scale, position };
  for (let attempt = 1; attempt <= 3; attempt++) {
    await stopNow();
    if (killStrayHelpers()) await sleep(800); // give macOS time to remove the old display
    const r = await spawnHelper(bin, opts);
    if (r.ok) return r;
    state = { ...state, error: r.error };
    await sleep(1000 * attempt);
  }
  return { ok: false, error: state.error };
}

function start(opts) {
  const p = chain.then(() => startNow(opts));
  chain = p.catch(() => {});
  return p;
}

function stop() {
  const p = chain.then(() => stopNow());
  chain = p.catch(() => {});
  return p;
}

module.exports = { start, stop, status: () => ({ ...state, supported: process.platform === 'darwin' }) };
