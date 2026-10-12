# Windows: adding a virtual monitor

Windows only creates a real "extended" monitor through a display driver (an Indirect Display Driver, IDD).
Writing and signing a kernel-trusted driver needs Microsoft's driver-signing process, so DriveDesk reuses an
existing signed, open-source one instead of shipping its own.

## Recommended: Virtual Display Driver (open source)

1. Download the latest release from the GitHub project **VirtualDrivers / Virtual-Display-Driver**.
2. Run its installer (or the companion control app) as administrator.
3. In its settings, add a custom resolution that matches your car screen, then enable one monitor:
   | Car                          | Resolution  |
   |------------------------------|-------------|
   | Model 3 / Model Y            | 1920 × 1200 |
   | Model S / X (2021+)          | 2200 × 1300 |
   | Cybertruck                   | 2650 × 1440 |
   | Model S / X (pre-2021, portrait) | 1200 × 1920 |
4. Open **Settings > System > Display**. You should see a new monitor. Choose **Extend these displays**,
   drag it to sit where the car screen physically is relative to your laptop.
5. For readability from the driver's seat, set **Scale** on that monitor to 125% or 150%.
   This makes Windows render larger, sharp text (much better than zooming a blurry video).
6. Start DriveDesk. The new monitor appears in the display list; select it as the default.

## Alternatives
- **Parsec Virtual Display Driver** (installed with Parsec).
- **Amyuni usbmmidd** (older; command-line enable/disable).

Any of these work: DriveDesk simply captures whichever monitor you pick.

## No driver? Mirror mode
Without a virtual monitor you can still pick your main display and DriveDesk will mirror it.

## Work laptops
Installing drivers usually needs admin rights. On a company-managed machine, get IT approval first.
