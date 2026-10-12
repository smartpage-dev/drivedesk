# Install DriveDesk

Pick what you want to show on the car screen. Always park first; the car's browser doesn't work while driving.

| I want to show… | Install on | Needs a laptop in the car? |
|---|---|---|
| My Mac as a second screen | Mac | Yes |
| My Windows PC as a second screen | Windows PC | Yes |
| My Android phone | Android phone | No |
| My iPhone | Mac (see "iPhone" below) | Yes |

Download the files from the project's **Releases** page. If nobody has made the download files yet, follow **Make the download files** at the end of this guide first.

---

## Mac

1. Download the `.dmg` for your Mac: **arm64** if you have an M1 or newer chip, **x64** for Intel. (Apple menu > About This Mac tells you which.)
2. Open it and drag **DriveDesk** to **Applications**.
3. Open DriveDesk. If macOS says it can't verify the developer: open **System Settings > Privacy & Security**, scroll down, click **Open Anyway**.
4. DriveDesk shows a **Finish setup** list. Click each button until every dot is green:
   - **Screen Recording**: turn DriveDesk on, then quit and reopen DriveDesk.
   - **Accessibility**: turn DriveDesk on.
   - **Virtual display**: added automatically.
5. Go to **Connect the car** below.

## Windows

1. Download and run `DriveDesk-…-win-x64.exe`. If Windows shows "Windows protected your PC", click **More info > Run anyway**. Click **Yes** when asked for permission (this adds the firewall rule so the car can connect).
2. DriveDesk opens. It works right away by **mirroring** your screen.
3. Optional, for a true second screen: click **Get driver** in the setup list, install the virtual monitor driver, then set that monitor's **Scale** to 150% in Windows Display settings so text is readable from the driver's seat.
4. Go to **Connect the car** below.

## Connect the car (Mac or Windows)

1. Put the car and laptop on the same network. Easiest: turn on your phone's hotspot and connect both to it.
2. On the car screen, open the **Browser** app and type the address DriveDesk shows, for example `192.168.1.23`.
3. Enter the PIN shown on the laptop. The car remembers it next time.
4. Tap the small tab at the top of the car screen for options.

---

## Android phone (no laptop needed)

1. On the phone, download `DriveDesk-Phone-….apk` and open it. If asked, allow your browser to **install unknown apps**.
2. Open DriveDesk and tap **Start sharing**, then **Start now** on the system prompt.
3. Turn on the phone's **hotspot**. On the car screen, connect to it under Wi-Fi.
4. In the car's browser, type the address shown in the app and enter the PIN.

**Optional, control the phone from the car screen:** tap **Turn on touch control** in the app, then turn on **DriveDesk touch control** in Accessibility. If the switch is greyed out (Android 13 and newer): tap **Open App info**, tap the **⋮** menu, choose **Allow restricted settings**, and try again.

Good to know: phone audio still plays through the car over Bluetooth. Some apps (banking, Netflix and other streaming apps) block screen sharing and appear black; that's the app's choice and can't be bypassed.

---

## iPhone

Apple doesn't let iPhone apps receive taps from another device, and there's no AirPlay in the car, so the iPhone goes through a Mac:

- **With touch control (US and most regions, not the EU):** on a Mac with macOS 15 or newer and an iPhone on iOS 18 or newer, open the **iPhone Mirroring** app. Drag its window onto the **DriveDesk Display**. Tapping it on the car screen clicks the iPhone.
- **View only (works everywhere):** on the iPhone, open Control Center, tap **Screen Mirroring**, and choose your Mac. Drag the mirrored window onto the **DriveDesk Display**.
- **Windows PC:** you need a third-party AirPlay receiver app for Windows; then drag its window onto the virtual monitor. View only.

Tip: the iPhone window is small. In DriveDesk, set **Text size** to **Extra large** to make it bigger on the car screen.

---

## Something not working?

- **Car shows "Waiting for video" forever:** some hotspots block devices from talking to each other. Try a different hotspot, or share the laptop's own connection as a hotspot and connect the car to that.
- **"That PIN didn't match":** use the PIN on the device you're connecting to (laptop or phone); they're different.
- **Text too small:** on Mac pick **Large** text size in DriveDesk; on Windows set the virtual monitor's Scale to 150%.
- **Work computer:** company-managed laptops may block driver installs, permissions, or firewall changes. Ask your IT team first.

---

## Make the download files (one time, for whoever publishes DriveDesk)

GitHub can build the Mac, Windows, and Android installers for you on its own computers, so you don't need all three kinds of device. You only need a web browser. It takes about 15 minutes of your time, plus waiting for the builds.

### 1. Put the project on GitHub
1. Create a free account at **github.com** if you don't have one.
2. Click **+** (top right) > **New repository**. Name it `drivedesk`.
   - Choose **Public** if anyone should be able to download DriveDesk. (Private works too, but only people you invite can download, and builds count against your free monthly build minutes; Mac builds use them fastest. GitHub's billing page has current limits.)
   - Leave "Add a README" unticked. Click **Create repository**.
3. Unzip `drivedesk.zip` on your computer.
4. On the new repository page, click **uploading an existing file**.
5. Open the unzipped `drivedesk` folder and drag **everything inside it** (not the folder itself) onto the upload page. You should see `src`, `android`, `native`, `build`, `.github`, `package.json`, and the guides.
   - **On a Mac**, the `.github` folder is hidden. In Finder, press **Cmd + Shift + .** (period) to show it, then include it.
6. Click **Commit changes**.
7. Check that the file `.github/workflows/release.yml` appears in the repository. If it's missing (some browsers skip hidden folders):
   - Click **Add file > Create new file**.
   - Type the name exactly as `.github/workflows/release.yml`. The slashes create the folders.
   - Open `release.yml` from the unzipped folder in a text editor, then copy and paste its contents.
   - Click **Commit changes**.

### 2. Run the build
1. Click the **Actions** tab. If GitHub asks, click **I understand my workflows, go ahead and enable them**.
2. Click **Build installers** in the left list.
3. Click **Run workflow** (right side), then the green **Run workflow** button.
4. Wait. A yellow dot means building; a green check means done. The Mac build is the slowest.

### 3. Get the files
1. Click the finished run.
2. Scroll to **Artifacts** at the bottom. Download **mac**, **windows**, and **android**.
3. Each download is a `.zip`. Unzip it to get the `.dmg`, `.exe`, or `.apk`.

These downloads only work for people signed in to GitHub, and they're deleted after 90 days. To share DriveDesk with everyone, do step 4.

### 4. Publish a public download page (Release)
1. On the repository page, click **Releases** (right side) > **Draft a new release**.
2. Click **Choose a tag**, type `v0.2.0`, and click **Create new tag: v0.2.0 on publish**.
3. Title it `DriveDesk 0.2.0` and click **Publish release**.
4. Publishing the tag starts the build automatically (check the **Actions** tab). When it finishes, the installers are attached to the Release.
5. Share the Release link. Anyone can download from it, no GitHub account needed.

For a later version, change the version number in `package.json` and `android/app/build.gradle.kts`, upload the changed files, and publish a new Release with a new tag (for example `v0.2.1`).

### If a build fails
A red **X** means a step failed. Click the failed run, then the red job (mac, windows, or android), then the red step to see the error. Copy the last 30 or so lines of the error. That's what someone fixing it will need.

### Optional: remove the security warnings
Without signing, people see "Open Anyway" on Mac, "Run anyway" on Windows, and "install unknown apps" on Android. Installs still work. To remove the Mac and Windows warnings, you need an Apple Developer ID (paid yearly) and a Windows code-signing certificate. Add them under **Settings > Secrets and variables > Actions > New repository secret**, using the names listed at the top of `release.yml`. The next build signs automatically.

For Android, a release keystore stops the "different key" problem when updating the app. Without one, users must uninstall the old version before installing a newer build.
