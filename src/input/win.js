'use strict';
const koffi = require('koffi');

const user32 = koffi.load('user32.dll');
const SetCursorPos = user32.func('int __stdcall SetCursorPos(int x, int y)');
const mouse_event = user32.func('void __stdcall mouse_event(uint32_t flags, uint32_t dx, uint32_t dy, int32_t data, uintptr_t extra)');

const F = {
  leftDown: 0x0002, leftUp: 0x0004, rightDown: 0x0008, rightUp: 0x0010,
  wheel: 0x0800, hwheel: 0x1000
};
// Touch pixels -> wheel units. 120 = one notch; most modern apps accept smaller values for smooth scrolling.
const WHEEL_PER_PX = 3;
let accY = 0, accX = 0;

module.exports = {
  move(x, y) { SetCursorPos(Math.round(x), Math.round(y)); },
  down(button) { mouse_event(button === 'right' ? F.rightDown : F.leftDown, 0, 0, 0, 0); },
  up(button) { mouse_event(button === 'right' ? F.rightUp : F.leftUp, 0, 0, 0, 0); },
  scroll(dx, dy) {
    accY += dy * WHEEL_PER_PX; accX += dx * WHEEL_PER_PX;
    const y = Math.trunc(accY), x = Math.trunc(accX);
    if (y) { mouse_event(F.wheel, 0, 0, y, 0); accY -= y; }
    if (x) { mouse_event(F.hwheel, 0, 0, -x, 0); accX -= x; }
  }
};
