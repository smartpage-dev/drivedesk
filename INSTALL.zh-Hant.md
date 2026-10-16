# 安裝 DriveDesk

[English](INSTALL.md) ｜ 中文

揀選你想在汽車螢幕上顯示的內容。請先泊好車，行車時汽車瀏覽器不能使用。

DriveDesk 會跟隨裝置的語言自動顯示中文或英文。電腦版可在視窗右上角的「Language / 語言」切換；汽車畫面可在頂部工具列切換。

| 我想顯示… | 安裝在 | 車上需要電腦？ |
|---|---|---|
| Mac（作為第二個螢幕） | Mac | 需要 |
| Windows 電腦（作為第二個螢幕） | Windows 電腦 | 需要 |
| Android 手機 | Android 手機 | 不需要 |
| iPhone | Mac（見下面「iPhone」） | 需要 |
| Nintendo Switch（自製韌體） | Android 手機 + Switch 上的 SysDVR | 不需要 |

安裝檔可在本項目的 **Releases** 頁面下載，或使用 DriveDesk 起始頁（`https://<擁有者>.github.io/drivedesk`），它會自動推薦適合你裝置的版本。如果仍未有人製作安裝檔，請先按本指南最後的「製作安裝檔」操作。

**在車上，一個地址通用所有模式。** 手機 app、Switch 模式，以及 Mac／Windows 熱點，都使用同一個車用地址：`http://100-99-0-1.sslip.io:8787`。在汽車瀏覽器開啟一次後按星號儲存；或儲存 DriveDesk 起始頁，上面有一個大大的「連接」按鈕。

---

## 最簡單的設定：車內路由器（如有，建議使用）

Tesla 瀏覽器會封鎖路由器一般使用的地址範圍（`192.168.x.x`、`10.x.x.x`、`172.16–31.x.x`）。如果你車上有自己的 Wi-Fi 路由器（例如 4G SIM 卡路由器），只需更改一次它的網絡範圍。之後，連接它的所有裝置（汽車、電腦、手機、Switch）都可以直接互相連接，本指南其餘部分的熱點及 VPN 步驟都可以略過。

1. 開啟路由器的管理頁面，找出 **LAN** 設定（有時稱為 LAN IP、DHCP 或「區域網絡」）。
2. 設定：
   - **路由器（LAN）IP：** `198.18.0.1`
   - **子網路遮罩：** `255.255.255.0`
   - **DHCP 範圍：** `198.18.0.100` 至 `198.18.0.200`

   4G 路由器請避免使用 `100.64.x.x` 至 `100.127.x.x`：流動網絡商通常用這些地址作路由器本身的上網連線，兩者會衝突。
3. 儲存。路由器會重新啟動，管理頁面會變成 `http://198.18.0.1`。請重新連接你的裝置。
4. 可選但實用：在路由器的 DHCP 設定中，為 Switch 及電腦或手機設定固定地址（「靜態租約」或「地址保留」），車用地址便不會改變。

之後正常使用 DriveDesk 即可。它會偵測到這是汽車可連接的網絡，略過熱點及 VPN 步驟，並顯示橙色的車用地址，例如電腦會是 `http://198-18-0-20.sslip.io`。

如果路由器不接受這個地址（有些只容許 `192.168`／`10`／`172.16` 範圍），便不能用這個方法。運行 OpenWrt 的路由器（包括 GL.iNet 型號，在其進階設定中）可以設定。

如果橙色地址在車上無法開啟，可能是路由器的 DNS 封鎖了它。請關閉「DNS rebinding protection」（DNS 重新綁定保護），或把 `sslip.io` 加入例外。

---

## Mac

1. 下載適合你 Mac 的 `.dmg`：M1 或更新晶片選 **arm64**，Intel 晶片選 **x64**。（按蘋果選單 > 關於這部 Mac 可以查看。）
2. 開啟檔案，把 **DriveDesk** 拖到「應用程式」（Applications）。
3. 開啟 DriveDesk。如果 macOS 表示無法驗證開發者：開啟**系統設定 > 隱私權與安全性（Privacy & Security）**，向下捲動，按**仍要打開（Open Anyway）**。
4. DriveDesk 會顯示「**完成設定**」清單。逐一按下按鈕，直至所有圓點變成綠色：
   - **螢幕錄製權限**：開啟 DriveDesk，然後結束並重新開啟 DriveDesk。
   - **輔助使用權限**：開啟 DriveDesk。
   - **虛擬顯示器**：會自動加入。
5. 前往下面「連接汽車」。

## Windows

1. 下載並執行 `DriveDesk-…-win-x64.exe`。如果 Windows 顯示「Windows 已保護您的電腦」，按**其他資訊 > 仍要執行**。要求權限時按**是**（這會加入防火牆規則，讓汽車可以連接）。
2. DriveDesk 開啟後，會立即以**鏡像**方式顯示你的螢幕。
3. 可選，如要真正的第二個螢幕：在設定清單按「**下載驅動程式**」，安裝虛擬顯示器驅動程式，然後在 Windows 的「顯示器」設定把該顯示器的**縮放比例**設為 150%，在駕駛座也能看清文字。
4. 前往下面「連接汽車」。

## 連接汽車（Mac 或 Windows）

Tesla 瀏覽器會封鎖 `192.168.x.x` 這類家用網絡地址，所以即使汽車和電腦在同一個網絡，汽車也無法經一般家用 Wi-Fi 連接電腦。解決方法是讓汽車連接電腦開設的熱點。DriveDesk 的「**連接你的 Tesla**」部分會一步步引導你，以下是相同的步驟。

**Mac**
1. 用 USB 線連接 iPhone 並開啟「**個人熱點**」，讓 Mac 經 USB 上網（亦可用有線網絡）。汽車只會連接有互聯網的熱點。
2. 在 DriveDesk 按「**準備車用熱點**」，然後輸入 Mac 密碼。這個步驟只需做一次。
3. 開啟**系統設定 > 一般 > 共享 > 互聯網共享（Internet Sharing）**。由 **iPhone USB** 共享到 **Wi-Fi**，設定網絡名稱及密碼，然後開啟。如果本身已開啟，請先關閉再重新開啟。
4. 在汽車上連接該 Wi-Fi 網絡。
5. DriveDesk 會顯示橙色的車用地址，例如 `http://100-99-0-1.sslip.io:8787`。在汽車瀏覽器輸入這個地址，再輸入 PIN 碼。

**Windows**
1. 在 DriveDesk 按「**準備車用熱點**」，並在權限提示按**是**。這個步驟只需做一次。
2. 開啟**設定 > 網絡和互聯網 > 流動熱點（Mobile hotspot）**，設定網絡名稱及密碼，然後開啟。如果本身已開啟，請先關閉再重新開啟。
3. 在汽車上連接該 Wi-Fi 網絡。
4. 在汽車瀏覽器輸入 DriveDesk 顯示的橙色車用地址，再輸入 PIN 碼。

如果汽車仍然無法連接，請在 DriveDesk 選擇另一個「**熱點地址範圍**」，再按一次「**準備車用熱點**」，然後重新啟動熱點。

提示：車用地址使用免費的公開域名服務（sslip.io），把熱點地址變成汽車瀏覽器接受的名稱。你的畫面影像不會經過它，只會在電腦與汽車之間傳送。

**第二個螢幕還是複製畫面？** 在「**串流的顯示器**」下，選擇「**延伸**」把汽車用作獨立螢幕（把視窗拖過去），或選擇「**鏡像**」顯示與主螢幕相同的畫面。在 Mac 上亦可選擇汽車螢幕位於你螢幕的哪一邊。

---

## Android 手機（無需電腦）

1. 在手機下載 `DriveDesk-Phone-….apk` 並開啟。如有提示，請允許瀏覽器「**安裝不明應用程式**」。如已安裝舊版 DriveDesk，請先解除安裝。
2. 開啟手機**熱點**。請使用 **5 GHz**；如果手機的熱點設定有 **Wi-Fi 6** 選項，請關閉（Tesla 不支援 Wi-Fi 6 熱點）。
3. 在汽車螢幕的 Wi-Fi 設定中連接該熱點。
4. 開啟 DriveDesk，按「**開始分享**」。
   - 第一次使用時，Android 會要求允許 **VPN 連線**，請按「**確定**」。它只在本機運作：為手機加入一個 Tesla 瀏覽器接受的額外地址，不會經它把任何數據傳到互聯網，亦不影響其他 app。
   - 然後在螢幕分享提示按「**立即開始**」。
5. 在汽車瀏覽器開啟 app 顯示的橙色地址（`http://100-99-0-1.sslip.io:8787`，每次都一樣，可儲存為書籤），再輸入 PIN 碼。

**一按即開始：** 拉下通知欄，按編輯（鉛筆）圖示，把 **DriveDesk** 方塊拖到快速設定。之後按一下即可開始或停止 DriveDesk，會沿用你上次使用的模式（手機或 Switch）。

**可選，在汽車螢幕上操作手機：** 在 app 按「**開啟觸控控制**」，然後在無障礙設定（Accessibility）開啟「**DriveDesk 觸控控制**」。如果開關呈灰色（Android 13 或以上）：按「**開啟應用程式資料**」，按 **⋮** 選單，選擇「**允許受限制的設定**」，然後再試。

注意：分享期間，DriveDesk 的 VPN 會取代你正在使用的其他 VPN。手機聲音仍會經藍牙在汽車播放。部分 app（銀行、Netflix 及其他串流 app）會阻止螢幕分享，畫面會變黑；這是該 app 的設定，無法繞過。

---

## Nintendo Switch（安裝 SysDVR 的自製韌體）

Switch 會把遊戲畫面串流到你的 Android 手機，再由手機傳到汽車。無需電腦或擷取卡，手機螢幕亦可保持關閉。

**你需要**
- 運行 Atmosphère 並安裝了 **SysDVR** 系統模組的 Switch（完整版，不是只支援 USB 的版本）。SysDVR 是免費開源軟件，可在其 GitHub releases 頁面下載。
- DriveDesk Android app。
- 支援錄影的遊戲（長按擷取鍵可錄下片段）。禁止錄影的遊戲不能串流。
- 請檢查 Switch 的系統版本：有報告指 SysDVR 在 23.0.0 版本未能正常運作。

**Switch 一次性設定**
1. 按 SysDVR 的指南把它複製到 SD 卡，然後重新啟動進入 Atmosphère。
2. 在 Homebrew 選單開啟 **SysDVR Settings**，選擇 **Simple network mode**（RTSP 模式），然後重新啟動。

**每次使用**
1. 開啟手機熱點（5 GHz，關閉 Wi-Fi 6），或使用按上面「最簡單的設定」設定好的汽車路由器。
2. 把**汽車**、**Switch**，以及（使用路由器時）**手機**連接到該網絡（Switch：系統設定 > 互聯網）。
3. 在 Switch 上開始遊戲。
4. 在手機的 DriveDesk，於「**Nintendo Switch**」下按「**尋找我的 Switch**」（或從 Switch 的互聯網設定查看並輸入其 IP 地址），然後按「**串流 Switch 到汽車**」。第一次使用時請允許 VPN 要求。
5. 在汽車瀏覽器開啟橙色地址，再輸入 PIN 碼。

可使用分離的 Joy-Con 或 Pro 手掣遊玩。

**在車上播放聲音：** 串流開始後，按汽車螢幕底部的「**輕按以在車上播放聲音**」。汽車瀏覽器需要你按一下才可以播放聲音。之後可在工具列（按頂部的小標籤）開關聲音。遊戲聲音會經汽車喇叭播放，音量由汽車控制。如果聽到兩次聲音，請把 Switch 本身的音量調低；串流的音量可能不受影響。

**另一個免費可試的方法：** 把 Switch 的藍牙音訊直接與汽車配對。在汽車開啟藍牙畫面並選擇加入新裝置，讓汽車可被搜尋。在 Switch 前往**系統設定 > 藍牙音訊 > 配對裝置**。這個方法未確定能否用於 Tesla。使用藍牙音訊期間，Switch 最多只能連接兩個無線手掣。

**限制**
- 會有少許延遲（大約零點幾秒）。慢節奏遊戲沒有問題，但快節奏動作或節奏遊戲會較明顯。聲音會延遲以大致配合畫面。
- 畫質由 Switch 本身的錄影編碼器決定。如果串流不順暢，請把手機放近 Switch 及汽車。
- 把改機的 Switch 連接互聯網，有被 Nintendo 停用網絡服務的風險。如果你平時讓它保持離線或封鎖 Nintendo 的伺服器，連接熱點前請繼續保持這些保護措施。

---

## iPhone

Apple 不容許 iPhone app 接收其他裝置的點按，汽車亦沒有 AirPlay，所以 iPhone 需要透過 Mac 使用：

- **可觸控操作（美國及大部分地區，歐盟除外）：** 在 macOS 15 或以上的 Mac，配合 iOS 18 或以上的 iPhone，開啟「**iPhone 鏡像輸出**」（iPhone Mirroring）app，把它的視窗拖到 **DriveDesk Display**。在汽車螢幕上點按即可操作 iPhone。
- **只可觀看（所有地區適用）：** 在 iPhone 開啟控制中心，按「**螢幕鏡像輸出**」（Screen Mirroring），選擇你的 Mac，然後把鏡像視窗拖到 **DriveDesk Display**。
- **Windows 電腦：** 需要第三方的 Windows AirPlay 接收 app，然後把它的視窗拖到虛擬顯示器。只可觀看。

提示：iPhone 視窗較細。在 DriveDesk 把「**文字大小**」設為「**特大**」，它在汽車螢幕上會變大。

---

## 有問題？

- **汽車顯示無法連線（ERR_CONNECTION_REFUSED）：** 汽車正在使用它會封鎖的地址。請按上面「連接汽車」操作，並使用橙色的車用地址。
- **汽車一直顯示「等待影像中」：** 在 Mac 上，請在**系統設定 > 隱私權與安全性 > 本地網絡（Local Network）**允許 DriveDesk，然後在汽車的工具列按「**重新連線**」。
- **「PIN 碼不正確」：** 請使用你正在連接的裝置（電腦或手機）上顯示的 PIN 碼，兩者並不相同。
- **文字太細：** Mac 請在 DriveDesk 選擇「**大**」文字大小；Windows 請把虛擬顯示器的縮放比例設為 150%。
- **公司電腦：** 公司管理的電腦可能會阻止安裝驅動程式、更改權限或防火牆設定。請先詢問你的 IT 部門。

---

## 製作安裝檔（只需做一次，由發佈 DriveDesk 的人負責）

GitHub 可以用它自己的電腦替你製作 Mac、Windows 及 Android 安裝檔，所以你不需要同時擁有這三類裝置，只需要網頁瀏覽器。你大約需要花 15 分鐘，另加等待製作的時間。

### 1. 把項目放上 GitHub
1. 如未有帳戶，請在 **github.com** 免費註冊。
2. 按右上角的 **+** > **New repository**，命名為 `drivedesk`。
   - 如要讓任何人都可以下載 DriveDesk，請選擇 **Public**。（Private 亦可，但只有你邀請的人才可下載，而且製作會使用每月的免費製作時數，Mac 製作用得最快。最新上限請查看 GitHub 的收費頁面。）
   - 不要勾選「Add a README」。按 **Create repository**。
3. 在電腦解壓 `drivedesk.zip`。
4. 在新的 repository 頁面按 **uploading an existing file**。
5. 開啟解壓後的 `drivedesk` 資料夾，把**裡面所有內容**（不是資料夾本身）拖到上載頁面。你應該會看到 `src`、`android`、`native`、`build`、`docs`、`.github`、`package.json` 及各份指南。
   - **在 Mac 上**，`.github` 資料夾是隱藏的。在 Finder 按 **Cmd + Shift + .**（句號）顯示它，然後一併拖入。
6. 按 **Commit changes**。
7. 確認 repository 內有 `.github/workflows/release.yml` 這個檔案。如果沒有（部分瀏覽器會略過隱藏資料夾）：
   - 按 **Add file > Create new file**。
   - 名稱準確輸入 `.github/workflows/release.yml`，斜線會自動建立資料夾。
   - 用文字編輯器開啟解壓資料夾中的 `release.yml`，複製全部內容並貼上。
   - 按 **Commit changes**。

### 2. 開始製作
1. 按 **Actions** 分頁。如 GitHub 詢問，按 **I understand my workflows, go ahead and enable them**。
2. 在左邊清單按 **Build installers**。
3. 按右邊的 **Run workflow**，再按綠色的 **Run workflow** 按鈕。
4. 等待。黃色圓點代表製作中，綠色剔號代表完成。Mac 製作最慢。

### 3. 取得檔案
1. 按已完成的那一次製作。
2. 捲動到底部的 **Artifacts**，下載 **mac**、**windows** 及 **android**。
3. 每個下載都是 `.zip`，解壓後便得到 `.dmg`、`.exe` 或 `.apk`。

這些下載只限已登入 GitHub 的人使用，並會在 90 天後刪除。如要與所有人分享 DriveDesk，請做第 4 步。

### 4. 發佈公開下載頁面（Release）
1. 在 repository 頁面按右邊的 **Releases** > **Draft a new release**。
2. 按 **Choose a tag**，輸入 `v0.3.0`，再按 **Create new tag: v0.3.0 on publish**。
3. 標題填 `DriveDesk 0.3.0`，按 **Publish release**。
4. 發佈 tag 會自動開始製作（可在 **Actions** 分頁查看）。完成後，安裝檔會附加到該 Release。
5. 分享 Release 連結。任何人都可以下載，無需 GitHub 帳戶。

推出新版本時，請更改 `package.json` 及 `android/app/build.gradle.kts` 內的版本號碼，上載更改了的檔案，再用新的 tag（例如 `v0.3.1`）發佈新的 Release。

### 5. 開啟 DriveDesk 起始頁（可選，建議）
項目的 `docs` 資料夾內有一個起始頁。在車上，它會顯示大大的「**連接**」按鈕；在手機或電腦上，它會提供適合的下載。
1. 在 repository 開啟 **Settings > Pages**。
2. 在 **Build and deployment** 下，把 **Source** 設為 **Deploy from a branch**，選擇 **main** 及 **/docs**，然後按 **Save**。
3. 大約一分鐘後，起始頁會在 `https://<你的 GitHub 名稱>.github.io/drivedesk` 上線。可以分享這個連結，代替 Releases 頁面。

### 如果製作失敗
紅色 **X** 代表某個步驟失敗。按該次製作，再按紅色的工作（mac、windows 或 android），然後按紅色的步驟查看錯誤。複製錯誤最後約 30 行，修正問題時需要這些資料。

### 可選：移除安全警告
未經簽署時，用戶會在 Mac 看到「仍要打開」、在 Windows 看到「仍要執行」、在 Android 看到「安裝不明應用程式」。安裝仍然可以進行。如要移除 Mac 及 Windows 的警告，你需要 Apple Developer ID（每年收費）及 Windows 程式碼簽署憑證。把它們加入 **Settings > Secrets and variables > Actions > New repository secret**，名稱請參考 `release.yml` 頂部列出的項目。下一次製作便會自動簽署。

Android 方面，使用正式版簽署金鑰（release keystore）可以避免更新時出現「金鑰不同」的問題。未設定時，用戶安裝新版本前必須先解除安裝舊版。
