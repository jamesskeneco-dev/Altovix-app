@echo off
rem Double-click this file to sign in to Schwab. It works from anywhere:
rem it switches to the folder this file lives in before running the login.
cd /d "%~dp0"
title Altovix - Schwab login
call npm run schwab -- login
echo.
echo (You can close this window.)
pause >nul
