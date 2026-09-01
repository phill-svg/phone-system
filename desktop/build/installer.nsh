; Custom NSIS hooks for the TCB Phone installer.
;
; The installer asks before putting an icon on the desktop instead of planting one unconditionally,
; so staff who only ever use the tray icon don't end up with one they didn't want.
; nsis.createDesktopShortcut is false in package.json, so electron-builder creates the Start menu
; entry but leaves the desktop to us.

!macro customInstall
  ; electron-updater applies auto-updates by re-running this installer with /S. A message box there
  ; would hang the update behind a dialog nobody is watching, so silent runs skip the question and
  ; leave whatever the user chose the first time. /SD IDNO is the same guard belt-and-braces.
  IfSilent skip_desktop_shortcut
  MessageBox MB_YESNO|MB_ICONQUESTION "Add a ${PRODUCT_NAME} shortcut to your desktop?" /SD IDNO IDNO skip_desktop_shortcut
  ; Same shape as electron-builder's own addDesktopLink: target, no args, icon from the exe itself
  ; at index 0, description last.
  CreateShortCut "$DESKTOP\${PRODUCT_FILENAME}.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 "" "" "${APP_DESCRIPTION}"
  skip_desktop_shortcut:
!macroend

!macro customUnInstall
  ; We create this shortcut ourselves, so electron-builder's own shortcut cleanup doesn't know about
  ; it. Deleting unconditionally also clears one left behind by an installer from before this change,
  ; when createDesktopShortcut was true. Delete on a missing file is a no-op.
  Delete "$DESKTOP\${PRODUCT_FILENAME}.lnk"
!macroend
