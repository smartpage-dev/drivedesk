'use strict';
/**
 * Tesla's browser refuses to connect to RFC 1918 private addresses (10.x, 172.16-31.x, 192.168.x),
 * which is what home routers and phone hotspots hand out. The workaround (the same idea SideDisplay
 * documents) is to let the car join a hotspot run by this computer, with that hotspot using an
 * address range outside RFC 1918, and to open it through a hostname rather than a raw IP.
 *
 *  macOS:   Internet Sharing range  -> /Library/Preferences/SystemConfiguration/com.apple.nat
 *  Windows: Mobile Hotspot (ICS)    -> HKLM\SYSTEM\CurrentControlSet\Services\SharedAccess\Parameters
 *
 * Hostnames come from sslip.io, a public wildcard DNS service: "100-99-0-1.sslip.io" -> 100.99.0.1.
 */
const { execFile } = require('child_process');

const RANGES = {
  '100.99.0.1': 'Shared range 100.99.0.x (default)',
  '198.18.0.1': 'Benchmark range 198.18.0.x (try if the default fails)'
};

function isPrivate(ip) {
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
function isLinkLocal(ip) { return ip.startsWith('169.254.'); }

/** Turns a LAN address into what the car should type, and whether the car can reach it. */
function describe(ip, port) {
  const suffix = port && port !== 80 ? `:${port}` : '';
  if (isPrivate(ip) || isLinkLocal(ip)) {
    return { ip, carReachable: false, url: `http://${ip}${suffix}`, carUrl: null };
  }
  return { ip, carReachable: true, url: `http://${ip}${suffix}`, carUrl: `http://${ip.replace(/\./g, '-')}.sslip.io${suffix}` };
}

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 120000 }, (err, stdout, stderr) => {
      resolve(err ? { ok: false, error: (stderr || err.message || '').trim() } : { ok: true, out: stdout });
    });
  });
}

/** Asks for the admin password once, then sets the hotspot range. User re-toggles the hotspot afterwards. */
async function prepareHotspot(gateway = '100.99.0.1') {
  if (!RANGES[gateway]) return { ok: false, error: 'Unknown range' };
  const base = gateway.split('.').slice(0, 3).join('.');

  if (process.platform === 'darwin') {
    const cmd = `/usr/bin/defaults write /Library/Preferences/SystemConfiguration/com.apple.nat NAT -dict-add ` +
      `SharingNetworkNumberStart ${base}.1 SharingNetworkNumberEnd ${base}.254 SharingNetworkMask 255.255.255.0`;
    const r = await run('/usr/bin/osascript', ['-e',
      `do shell script "${cmd}" with administrator privileges with prompt "DriveDesk needs to change the Internet Sharing address range so your car can connect."`]);
    if (!r.ok) return { ok: false, error: /User canceled|-128/.test(r.error) ? 'Cancelled' : r.error };
    return { ok: true, next: 'Turn Internet Sharing off and on again in System Settings > General > Sharing.' };
  }

  if (process.platform === 'win32') {
    const key = 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\SharedAccess\\Parameters';
    const inner = `reg add ${key} /v ScopeAddress /t REG_SZ /d ${base}.1 /f & reg add ${key} /v ScopeAddressBackup /t REG_SZ /d ${base}.1 /f`;
    const r = await run('powershell.exe', ['-NoProfile', '-Command',
      `Start-Process -FilePath cmd.exe -ArgumentList '/c ${inner}' -Verb RunAs -Wait -WindowStyle Hidden`]);
    if (!r.ok) return { ok: false, error: /canceled|cancelled/i.test(r.error) ? 'Cancelled' : r.error };
    return { ok: true, next: 'Turn Mobile hotspot off and on again in Settings > Network & internet > Mobile hotspot.' };
  }

  return { ok: false, error: 'Only macOS and Windows are supported.' };
}

function sharingSettingsUrl() {
  return process.platform === 'darwin'
    ? 'x-apple.systempreferences:com.apple.Sharing-Settings.extension'
    : 'ms-settings:network-mobilehotspot';
}

module.exports = { RANGES, isPrivate, describe, prepareHotspot, sharingSettingsUrl };
