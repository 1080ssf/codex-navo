!macro customInit
  ; The app keeps a tray process and a local service process. Stop both before
  ; replacing installed files so a manually launched installer cannot get stuck.
  ; Kill Navo processes by image name without walking their child trees. Codex
  ; desktop may have been launched by Navo and must remain running during update.
  nsExec::ExecToLog 'taskkill /F /IM "Codex Navo.exe"'
  Pop $0
  Sleep 350
!macroend
