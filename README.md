# DriveDesk

Show your **Mac, Windows PC, or Android phone** on your Tesla's touchscreen (or any tablet/laptop browser), with touch control. Everything stays on your local network: no account, no cloud relay.

**Just want to use it?** See [INSTALL.md](INSTALL.md).

```
 Mac / PC (Electron)                               Car browser
 virtual display -> capture -> WebRTC ───────────▶ <video>
 CGEvent / user32 input  ◀── WebSocket (touch) ─── gestures

 Android phone (native)                            Car browser
 MediaProjection -> H.264 (hardware) ──WebSocket─▶ fMP4 muxer -> MSE <video>
 Accessibility gestures  ◀── WebSocket (touch) ─── gestures
         phone hotspot = the network, no laptop needed

 iPhone ── iPhone Mirroring / AirPlay ──▶ Mac ──▶ DriveDesk (desktop) ──▶ car
```

## What's in the repo

| Path | What it is |
|---|---|
| `src/` | Desktop app (Electron): server, WebRTC sender, input injection, control window, car viewer page |
| `native/macos/` | Swift helper that creates the macOS virtual display (private `CGVirtualDisplay` API) |
| `native/windows/` | How to add a virtual monitor on Windows (uses an existing signed driver) |
| `android/` | Android app (Kotlin, no third-party libraries): capture, encoder, HTTP/WebSocket server, touch service, car viewer page |
| `build/` | Installer pieces: Windows firewall rule, macOS ad-hoc signing |
| `.github/workflows/release.yml` | Builds the `.dmg`, `.exe`, and `.apk` automatically |

## Tesla connection: why a hotspot is needed
Tesla's browser refuses connections to RFC 1918 private addresses (10.x, 172.16–31.x, 192.168.x), which is what every home router and phone hotspot hands out. DriveDesk therefore has the laptop run the hotspot (macOS Internet Sharing / Windows Mobile Hotspot) on a range outside RFC 1918 (`100.99.0.x` by default, `198.18.0.x` as an alternative), and gives the car a hostname for it through sslip.io (`100-99-0-1.sslip.io` resolves to `100.99.0.1`). Setup code is in `src/carnet.js`. SideDisplay documents the same underlying restriction and the same hotspot-based approach.

## Design choices
- **Local only, PIN protected.** 6-digit PIN, lockout after 5 wrong attempts. The car remembers the PIN.
- **Readable from the driver's seat.** Text is enlarged by the OS (macOS HiDPI modes / Windows scaling), so it stays sharp.
- **Short address.** The desktop app tries port 80 so the car only needs `http://192.168.x.x` (falls back to `:8787`).
- **Zero-click macOS setup.** The virtual display is recreated at launch; a checklist walks through the two permissions.
- **Android without a laptop.** The phone is the hotspot, the server, and the encoder. It uses plain H.264 over WebSocket into Media Source Extensions instead of WebRTC, because ICE negotiation over phone hotspots is unreliable and this path needs no libraries.
- **Android touch control** via Accessibility gestures: tap, long-press, swipe, two-finger pinch, plus Back/Home/Recent apps buttons in the car toolbar.

## Building installers (the easy way)
Step-by-step instructions (browser only, no command line) are in [INSTALL.md > Make the download files](INSTALL.md#make-the-download-files-one-time-for-whoever-publishes-drivedesk). In short: put the project on GitHub, run **Actions > Build installers**, and publish a Release so anyone can download.

Without signing secrets the builds still work, but users see the usual warnings (macOS "Open Anyway", Windows SmartScreen "Run anyway", Android "install unknown apps"). Removing those requires an Apple Developer ID ($99/year, plus notarization), a Windows code-signing certificate, and an Android release keystore; the workflow reads them from repository secrets listed at the top of `release.yml`.

## Building locally

Desktop (Node.js 18+):
```bash
npm install
npm run build:mac-helper   # macOS only, needs Xcode Command Line Tools
npm start                  # run from source
npm run dist:mac           # or dist:win, to make an installer
```

Android (Android Studio, or JDK 17 + Android SDK + Gradle 8.9+):
```bash
cd android
gradle assembleDebug       # -> app/build/outputs/apk/debug/app-debug.apk
```

## Status: what's verified and what isn't
- **Verified here:** all JavaScript passes syntax checks. The car-side **fMP4 muxer** (`android/app/src/main/assets/web/phone.js`) was tested end-to-end: a real H.264 stream was muxed and decoded by ffmpeg with all 90 frames pixel-identical to the source.
- **Not run anywhere yet:** the Electron app, the Swift helper, the Kotlin app (no Android SDK or Kotlin compiler was available to compile it), the GitHub workflow, and anything on a real Tesla.
- **Highest-risk items to test first:**
  - Whether the car accepts the `100.99.0.x` hotspot range and sslip.io hostnames (the alternative range is selectable in the UI), and whether the macOS `com.apple.nat` keys and the Windows `ScopeAddress` registry value still change the hotspot range on current OS versions.
  - The Android app: phone hotspots use private addresses, so it is expected to hit the same Tesla block until it gets its own workaround.
  - macOS `CGVirtualDisplay` is undocumented; header and HiDPI behaviour are reconstructed from open-source projects.
  - Android encoder behaviour varies by phone maker; the app retries smaller sizes and simpler settings if the first configuration fails.
  - Tesla browser MSE/WebRTC playback varies by car computer and software version.
  - Port 80 binding without admin rights: expected to work on recent macOS and on Windows unless another program uses it; the app falls back to 8787 either way.
  - Ad-hoc signing via `build/adhoc-sign.js` and notarization via environment variables in electron-builder.
- **Platform limits (by design of the OS, not fixable in DriveDesk):** iOS apps can't receive remote touches; Android apps with FLAG_SECURE (banking, streaming) appear black; Android 13+ requires "Allow restricted settings" for sideloaded accessibility services; Google Play restricts Accessibility API use, so a Play Store release would likely need touch control removed or justified.

## Ideas for next steps
- iPhone without a laptop: a native iOS app with a ReplayKit broadcast extension (view only). Distribution needs TestFlight or the App Store to be "simple for everyone".
- Real-time Android drags (continued strokes) instead of replaying swipes on release.
- Keyboard text entry from the car.

## Safety
Use only while parked.

## License
MIT
