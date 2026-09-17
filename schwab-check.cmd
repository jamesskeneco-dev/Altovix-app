@echo off
rem Double-click to check the Schwab connection: live quotes, then your account (read-only).
cd /d "%~dp0"
title Altovix - Schwab check
call npm run --silent schwab -- status
call npm run --silent schwab -- quote SPY QQQ
call npm run --silent schwab -- accounts
echo.
echo (You can close this window.)
pause >nul
