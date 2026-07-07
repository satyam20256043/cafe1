@echo off
echo.
echo ====================================================
echo   Cafe Command HQ — Phase 1+2 Setup
echo ====================================================
echo.

cd /d "%~dp0.."
echo Working from: %CD%
echo.

echo [1/5] Copying db.js...
copy /Y data\db.js db.js
if errorlevel 1 ( echo ERROR copying db.js & pause & exit /b 1 )

echo [2/5] Copying auth.js...
copy /Y data\auth.js auth.js
if errorlevel 1 ( echo ERROR copying auth.js & pause & exit /b 1 )

echo [3/5] Copying backup.js...
copy /Y data\backup.js backup.js
if errorlevel 1 ( echo ERROR copying backup.js & pause & exit /b 1 )

echo [4/5] Copying server.js...
copy /Y data\server.js server.js
if errorlevel 1 ( echo ERROR copying server.js & pause & exit /b 1 )

echo [5/5] Checking npm packages...
node -e "require('better-sqlite3'); require('bcryptjs'); require('jsonwebtoken'); console.log('All packages OK');" 2>nul
if errorlevel 1 (
  echo Installing missing packages...
  npm install better-sqlite3 bcryptjs jsonwebtoken
)

echo.
echo ====================================================
echo   Setup complete!
echo.
echo   Now run:  node server.js
echo.
echo   Then login at:  http://localhost:3010/login
echo     Branch:   indiranagar
echo     Username: owner
echo     Password: cafe1234
echo ====================================================
echo.
pause
