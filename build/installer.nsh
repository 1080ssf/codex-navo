!macro customInit
  ; The app keeps a tray process and a local service process. Stop both before
  ; replacing installed files so a manually launched installer cannot get stuck.
  nsExec::ExecToLog 'taskkill /F /T /IM "Codex Navo.exe"'
  Pop $0
  Sleep 350
!macroend
