; Extra NSIS steps for electron-builder (wired up via build.nsis.include).
;
; The app registers itself to start at login with app.setLoginItemSettings,
; which writes HKCU\...\Run\"EE Connections" (name set in main.js). The
; uninstaller doesn't know about that value, so remove it here to avoid a dead
; login entry. Skip on updates: an in-place upgrade runs the old uninstaller,
; and the new version should keep starting at login.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "EE Connections"
  ${endIf}
!macroend
