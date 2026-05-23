@echo off
title Cafe Command HQ Launcher
cd /d C:\Users\pc\.gemini\antigravity\scratch\cafe-ai-bot
echo ===================================================
echo   ☕ CAFE COMMAND HQ: SAAS WHATSAPP BOT PLATFORM
echo ===================================================
echo.
echo Starting the Express + Socket.io + Bot Server...
echo.
npm start
if errorlevel 1 (
    echo.
    echo [ERROR] Failed to start Cafe Command HQ.
    echo Ensure Node.js is installed and ports are open.
)
pause
