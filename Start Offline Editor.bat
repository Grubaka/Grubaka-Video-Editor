@echo off
setlocal
cd /d "%~dp0"
if exist "editor\server.js" cd /d "%~dp0editor"
if not exist "server.js" (
  echo Editor files were not found. Keep this launcher with the editor folder.
  pause
  exit /b 1
)
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node.js, then run this launcher again.
  pause
  exit /b 1
)
if not defined PORT set "PORT=8765"
start "" "http://localhost:%PORT%"
node server.js
pause
