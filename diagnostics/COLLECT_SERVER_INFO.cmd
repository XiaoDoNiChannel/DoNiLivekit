@echo off
chcp 65001 >nul
title DoNiChannel Server Network Diagnostic
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0COLLECT_SERVER_INFO.ps1"
