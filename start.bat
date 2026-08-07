@echo off
title Codex Switchboard
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found. Install Node.js 20 or newer.
  pause
  exit /b 1
)
node launcher.js
if errorlevel 1 (
  pause
  exit /b 1
)
echo Launcher started successfully.
ping 127.0.0.1 -n 3 >nul
