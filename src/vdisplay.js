'use strict';
/**
 * macOS: spawns native/macos/build/vdisplay, which creates a CGVirtualDisplay that lives
 * exactly as long as the helper process. Killing the helper removes the display.
 * Windows: virtual displays come from an Indirect Display Driver (see native/windows/README.md).
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

let proc = null;
let state = { running: false, displayId: null, error: null, width: null, height: null };

function helperPath() {
  const packaged = process.resourcesPath ? path.join(process.resourcesPath, 'vdisplay') : null;
  if (packaged && fs.existsSync(packaged)) return packaged;
  return path.join(__dirname, '..', 'native', 'macos', 'build', 'vdisplay');
}

function start({ width = 2200, height = 1300, scale = 1.5 } = {}) {
  if (process.platform !== 'darwin') {
    state = { ...state, error: 'On Windows, add the virtual display with a virtual display driver (see native/windows/README.md).' };
    return Promise.resolve({ ok: false, error: state.error });
  }
  const bin = helperPath();
  if (!fs.existsSync(bin)) {
    state = { ...state, error: 'Helper not built. Run: npm run build:mac-helper' };
    return Promise.resolve({ ok: false, error: state.error });
  }
  stop();
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    proc = spawn(bin, ['--width', String(width), '--height', String(height), '--scale', String(scale), '--name', 'DriveDesk Display'], { stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stdout.on('data', (buf) => {
      const m = /READY (\d+)/.exec(String(buf));
      if (m) {
        state = { running: true, displayId: Number(m[1]), error: null, width, height };
        done({ ok: true, displayId: state.displayId });
      }
    });
    proc.stderr.on('data', (buf) => { state.error = String(buf).trim(); });
    proc.on('exit', (code) => {
      proc = null;
      state = { ...state, running: false, displayId: null, error: code ? (state.error || `Helper exited with code ${code}`) : null };
      done({ ok: false, error: state.error });
    });
    setTimeout(() => done({ ok: false, error: 'Timed out waiting for the virtual display.' }), 8000);
  });
}

function stop() {
  if (proc) { try { proc.kill('SIGTERM'); } catch {} proc = null; }
  state = { ...state, running: false, displayId: null };
}

module.exports = { start, stop, status: () => ({ ...state, supported: process.platform === 'darwin' }) };
