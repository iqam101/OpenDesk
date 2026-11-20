@echo off
title OpenDesk - Remote Desktop Server
echo ========================================================
echo        Starting OpenDesk (AnyDesk Alternative)
echo ========================================================
cd /d "%~dp0"
python server.py
pause
