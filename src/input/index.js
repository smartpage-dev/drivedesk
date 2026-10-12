'use strict';
/**
 * Input injection facade. Coordinates are global desktop coordinates:
 *  - macOS: points (same as Electron DIPs), origin top-left of the main display
 *  - Windows: physical pixels (main.js converts with screen.dipToScreenPoint)
 */
let impl = null;
let error = null;
try {
  if (process.platform === 'darwin') impl = require('./mac');
  else if (process.platform === 'win32') impl = require('./win');
  else error = 'Input injection is only implemented for macOS and Windows.';
} catch (e) {
  error = 'Could not load native input bindings (koffi): ' + e.message;
}

const held = new Set();

module.exports = {
  ready: !!impl,
  error,
  move(x, y) { impl.move(x, y, held); },
  down(button) { held.add(button); impl.down(button); },
  up(button) { held.delete(button); impl.up(button); },
  click(button) { impl.down(button); impl.up(button, { click: true }); },
  scroll(dx, dy) { impl.scroll(dx, dy); },
  releaseAll() { if (!impl) return; for (const b of [...held]) { held.delete(b); try { impl.up(b); } catch {} } }
};
