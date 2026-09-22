@echo off
chcp 65001 >nul
cd /d "%~dp0"
set PORT=8123
set PS=powershell -WindowStyle Hidden -ExecutionPolicy Bypass -NoProfile -Command

rem If already running, just open the browser (no second copy).
netstat -ano | findstr :%PORT% | findstr LISTENING >nul
if %errorlevel%==0 goto open

where node >nul 2>nul
if %errorlevel%==0 (
  %PS% "Start-Process -FilePath 'node' -ArgumentList 'server.js','%PORT%' -WindowStyle Hidden"
  goto open
)

where python >nul 2>nul
if %errorlevel%==0 (
  %PS% "Start-Process -FilePath 'python' -ArgumentList '-m','http.server','%PORT%' -WindowStyle Hidden"
  goto open
)

echo Node.js or Python not found. Please install one of them.
pause
exit /b 1

:open
start "" http://127.0.0.1:%PORT%
exit /b
