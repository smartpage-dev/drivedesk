'use strict';
// Requires: System Settings > Privacy & Security > Accessibility > enable for DriveDesk/Electron.
const koffi = require('koffi');

const CG = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics');
const CF = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');

koffi.struct('CGPoint', { x: 'double', y: 'double' });
const CGEventCreateMouseEvent = CG.func('void *CGEventCreateMouseEvent(void *source, uint32_t type, CGPoint pos, uint32_t button)');
const CGEventCreateScrollWheelEvent2 = CG.func('void *CGEventCreateScrollWheelEvent2(void *source, uint32_t units, uint32_t wheelCount, int32_t w1, int32_t w2, int32_t w3)');
const CGEventSetIntegerValueField = CG.func('void CGEventSetIntegerValueField(void *event, uint32_t field, int64_t value)');
const CGEventPost = CG.func('void CGEventPost(uint32_t tap, void *event)');
const CFRelease = CF.func('void CFRelease(void *cf)');

const kCGHIDEventTap = 0;
const kCGMouseEventClickState = 1;
const kCGScrollEventUnitPixel = 0;
const T = { leftDown: 1, leftUp: 2, rightDown: 3, rightUp: 4, moved: 5, leftDragged: 6, rightDragged: 7 };
const BTN = { left: 0, right: 1 };

let pos = { x: 0, y: 0 };
let last = { t: 0, x: 0, y: 0, button: null, count: 0 };

function post(type, button, clickState) {
  const ev = CGEventCreateMouseEvent(null, type, pos, BTN[button] || 0);
  if (!ev) return;
  if (clickState) CGEventSetIntegerValueField(ev, kCGMouseEventClickState, clickState);
  CGEventPost(kCGHIDEventTap, ev);
  CFRelease(ev);
}

module.exports = {
  move(x, y, held) {
    pos = { x, y };
    // While a button is held macOS expects *Dragged* events, otherwise window drags don't work.
    const type = held.has('left') ? T.leftDragged : held.has('right') ? T.rightDragged : T.moved;
    post(type, held.has('right') ? 'right' : 'left');
  },
  down(button) {
    const now = Date.now();
    const near = Math.abs(pos.x - last.x) < 6 && Math.abs(pos.y - last.y) < 6;
    last.count = (now - last.t < 400 && near && last.button === button) ? Math.min(last.count + 1, 3) : 1;
    last = { t: now, x: pos.x, y: pos.y, button, count: last.count };
    post(button === 'right' ? T.rightDown : T.leftDown, button, last.count);
  },
  up(button) {
    post(button === 'right' ? T.rightUp : T.leftUp, button, last.count || 1);
  },
  scroll(dx, dy) {
    const ev = CGEventCreateScrollWheelEvent2(null, kCGScrollEventUnitPixel, 2, Math.round(dy), Math.round(dx), 0);
    if (!ev) return;
    CGEventPost(kCGHIDEventTap, ev);
    CFRelease(ev);
  }
};
