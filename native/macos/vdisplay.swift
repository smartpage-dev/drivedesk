// vdisplay — creates a macOS virtual display that exists while this process runs.
// Usage: vdisplay --width 2200 --height 1300 --scale 1.5 --name "DriveDesk Display"
//
// Modes offered to macOS (pick in System Settings > Displays):
//   • "larger text" mode = width/scale × height/scale, rendered HiDPI  (default, sharp + readable from the seat)
//   • native mode        = width × height
//   • 2× mode            = width/2 × height/2
import Foundation
import CoreGraphics

func argValue(_ name: String) -> String? {
    let args = CommandLine.arguments
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
}

let width  = Int(argValue("--width") ?? "") ?? 2200
let height = Int(argValue("--height") ?? "") ?? 1300
let scale  = max(1.0, Double(argValue("--scale") ?? "") ?? 1.5)
let name   = argValue("--name") ?? "DriveDesk Display"

// Assume ~150 ppi (Tesla 17" 2200x1300 is ~150 ppi). Affects macOS's default UI sizing.
let ppi = 150.0
let mmW = Double(width) / ppi * 25.4
let mmH = Double(height) / ppi * 25.4

let descriptor = CGVirtualDisplayDescriptor()
descriptor.setDispatchQueue(DispatchQueue.main)
descriptor.name = name
descriptor.maxPixelsWide = UInt32(width * 2)
descriptor.maxPixelsHigh = UInt32(height * 2)
descriptor.sizeInMillimeters = CGSize(width: mmW, height: mmH)
descriptor.vendorID = 0x4444
descriptor.productID = 0x0D0D
descriptor.serialNum = UInt32(truncatingIfNeeded: width &* 10000 &+ height)
descriptor.terminationHandler = { _, _ in
    FileHandle.standardError.write("Virtual display terminated by system\n".data(using: .utf8)!)
    exit(2)
}

let display = CGVirtualDisplay(descriptor: descriptor)
guard display.displayID != 0 else {
    FileHandle.standardError.write("Failed to create virtual display\n".data(using: .utf8)!)
    exit(1)
}

func mode(_ w: Double, _ h: Double) -> CGVirtualDisplayMode {
    CGVirtualDisplayMode(width: UInt(w.rounded()), height: UInt(h.rounded()), refreshRate: 60)
}

let settings = CGVirtualDisplaySettings()
settings.hiDPI = 1
var modes = [mode(Double(width) / scale, Double(height) / scale)]
if scale != 1.0 { modes.append(mode(Double(width), Double(height))) }
if scale != 2.0 { modes.append(mode(Double(width) / 2, Double(height) / 2)) }
settings.modes = modes

guard display.apply(settings) else {
    FileHandle.standardError.write("Failed to apply display settings\n".data(using: .utf8)!)
    exit(1)
}

print("READY \(display.displayID)")
fflush(stdout)

// Exit cleanly on SIGTERM/SIGINT; the display disappears with the process.
signal(SIGTERM) { _ in exit(0) }
signal(SIGINT) { _ in exit(0) }

// Keep `display` alive for the life of the process.
withExtendedLifetime(display) {
    dispatchMain()
}
