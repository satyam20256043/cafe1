@echo off
title Cafe Command HQ — UI Installer
color 0A

echo ================================================
echo   ☕ CAFE COMMAND HQ: UI FILE INSTALLER
echo ================================================
echo.

set PROJECT_DIR=C:\Users\pc\.gemini\antigravity\scratch\cafe-ai-bot
set PUBLIC_DIR=%PROJECT_DIR%\public
set DOWNLOADS=%USERPROFILE%\Downloads

echo [1/4] Checking project folder...
if not exist "%PROJECT_DIR%" (
    echo [ERROR] Project folder not found: %PROJECT_DIR%
    echo Please make sure the cafe-ai-bot project exists.
    pause
    exit /b 1
)
echo       Found: %PROJECT_DIR%

echo.
echo [2/4] Creating public folder if missing...
if not exist "%PUBLIC_DIR%" (
    mkdir "%PUBLIC_DIR%"
    echo       Created: %PUBLIC_DIR%
) else (
    echo       Already exists: %PUBLIC_DIR%
)

echo.
echo [3/4] Copying UI files from Downloads...

if exist "%DOWNLOADS%\index.html" (
    copy /Y "%DOWNLOADS%\index.html" "%PUBLIC_DIR%\index.html" >nul
    echo       index.html   copied successfully
) else (
    echo [WARN] index.html not found in Downloads. Skipping.
)

if exist "%DOWNLOADS%\manager.html" (
    copy /Y "%DOWNLOADS%\manager.html" "%PUBLIC_DIR%\manager.html" >nul
    echo       manager.html copied successfully
) else (
    echo [WARN] manager.html not found in Downloads. Skipping.
)

echo.
echo [4/4] Verifying files...
set ALL_OK=1

if exist "%PUBLIC_DIR%\index.html" (
    echo       [OK] index.html
) else (
    echo       [MISSING] index.html
    set ALL_OK=0
)

if exist "%PUBLIC_DIR%\manager.html" (
    echo       [OK] manager.html
) else (
    echo       [MISSING] manager.html
    set ALL_OK=0
)

echo.
if "%ALL_OK%"=="1" (
    echo ================================================
    echo   SUCCESS! Both files installed.
    echo   Now run Run_CafeHQ.bat and open:
    echo   http://localhost:3050
    echo ================================================
) else (
    echo ================================================
    echo   INCOMPLETE — some files were not found in
    echo   Downloads. Make sure you downloaded both
    echo   index.html and manager.html first.
    echo ================================================
)

echo.
pause
