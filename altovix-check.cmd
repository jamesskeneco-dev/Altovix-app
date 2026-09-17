@echo off
rem Double-click: check every stop, buy trigger and watch rule now (Schwab prices) and alert the phone.
rem Windows Task Scheduler runs it with the word "scheduled" - then it is silent and logs to data\check-log.txt.
cd /d "%~dp0"
title Altovix - market check
if not exist data mkdir data
if /i "%~1"=="scheduled" (
  call npm run --silent check -- --quiet >> "data\check-log.txt" 2>&1
  exit
)
call npm run --silent check
echo.
echo (You can close this window.)
pause >nul
