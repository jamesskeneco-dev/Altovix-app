@echo off
rem Double-click: one crypto cycle now (exits -> scan -> committee -> guarded entries), then leave the window open.
rem   altovix-crypto.cmd loop      keeps cycling every hour until the window is closed (needs the PC on).
rem   altovix-crypto.cmd scan      just the scanner, no committee, no orders.
rem rules\crypto.json decides whether anything is real: live=false validates every order and sends nothing.
cd /d "%~dp0"
title Altovix - crypto sleeve
if not exist data mkdir data
if /i "%~1"=="loop" (
  call npm run --silent kraken -- run --loop 3600
  goto :end
)
if /i "%~1"=="scan" (
  call npm run --silent kraken -- scan
  goto :end
)
call npm run --silent kraken -- run --once
:end
echo.
echo (You can close this window.)
pause >nul
