@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not defined DONICHANNEL_LOG_MAX_MB set "DONICHANNEL_LOG_MAX_MB=10"
if not defined DONICHANNEL_LOG_FILE_COUNT set "DONICHANNEL_LOG_FILE_COUNT=5"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-CenterServer.ps1"
echo.
pause
