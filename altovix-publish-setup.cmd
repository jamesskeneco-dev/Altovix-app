@echo off
rem Double-click ONCE: gives this PC the GitHub key it needs to publish your numbers to the phone app.
cd /d "%~dp0"
title Altovix - connect the phone app
if not exist data mkdir data
call npm run --silent check -- --publish-setup
echo.
echo (You can close this window.)
pause >nul
