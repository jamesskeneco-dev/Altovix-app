@echo off
rem Double-click ONCE: sets up phone alerts (ntfy) and the three automatic daily checks.
cd /d "%~dp0"
title Altovix - setup
if not exist data mkdir data
call npm run --silent check -- --setup
echo.
echo (You can close this window.)
pause >nul
