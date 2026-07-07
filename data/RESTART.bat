@echo off
title Cafe HQ — Restart
color 0A
echo.
echo  ============================================
echo   Cafe Command HQ — Server Restart
echo  ============================================
echo.

echo  Stopping any server on port 3010...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3010" ^| findstr "LISTENING" 2^>nul') do (
    taskkill /F /PID %%a >nul 2>&1
    echo   Stopped PID %%a
)
echo  Stopping any server on port 3080...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3080" ^| findstr "LISTENING" 2^>nul') do (
    taskkill /F /PID %%a >nul 2>&1
    echo   Stopped PID %%a
)
timeout /t 2 /nobreak >nul

echo.
echo  Starting server...
cd /d C:\Users\pc\.claude\sessions\cafe-ai-bot
set PORT=3010
node data\server.js

pause
