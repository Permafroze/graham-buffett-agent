@echo off
echo.
echo  Graham-Buffett Investment Agent
echo  ================================
echo.

:: Check Node.js
node --version >nul 2>&1
if errorlevel 1 (
  echo  ERROR: Node.js is not installed.
  echo  Download it from https://nodejs.org and install, then run this again.
  echo.
  pause
  exit /b 1
)

:: Install dependencies if needed
if not exist node_modules (
  echo  Installing dependencies for the first time...
  echo  This takes about 30 seconds and only happens once.
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo  ERROR: npm install failed. Check your internet connection.
    pause
    exit /b 1
  )
)

echo  Starting the app...
echo  Your browser will open automatically.
echo  To stop the app, close this window.
echo.

node src/server.js
pause
