@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Не найден Node.js. Установите Node.js или откройте index.html на ноутбуке.
  pause
  exit /b 1
)
start "" "http://localhost:8765"
node server.js
pause
