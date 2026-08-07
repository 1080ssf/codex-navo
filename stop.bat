@echo off
title Stop Codex Switchboard
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found.
  pause
  exit /b 1
)
node stop.js
if errorlevel 1 (
  pause
  exit /b 1
)
ping 127.0.0.1 -n 3 >nul
