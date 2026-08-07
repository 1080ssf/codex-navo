@echo off
setlocal
cd /d "%~dp0"
set "CODEX_MANAGER_ROOT=%~dp0"

if not exist "%~dp0node_modules\electron\dist\electron.exe" (
  echo [ERROR] Electron runtime is missing.
  echo Run npm install in this folder first.
  pause
  exit /b 1
)

start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0desktop-src"
endlocal
