; Lets the car reach DriveDesk without a firewall prompt.
; Windows often marks a new hotspot as a "Public" network, so the rule covers private and public.
; Access is still protected by DriveDesk's PIN, and only while the app is running.
!macro customInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="DriveDesk"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="DriveDesk" dir=in action=allow program="$INSTDIR\DriveDesk.exe" enable=yes profile=private,public'
!macroend

!macro customUnInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="DriveDesk"'
!macroend
