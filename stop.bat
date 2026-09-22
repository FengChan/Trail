@echo off
set PORT=8123

for /f "tokens=5" %%p in ('netstat -ano ^| findstr :%PORT% ^| findstr LISTENING') do (
  taskkill /PID %%p /F >nul 2>nul
)

echo Service on port %PORT% stopped.
timeout /t 2 >nul
