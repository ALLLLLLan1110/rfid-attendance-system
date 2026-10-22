@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

where node.exe >nul 2>nul
if errorlevel 1 goto missing_node

rem Reuse the local system if it is already running.
powershell.exe -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8787/' -TimeoutSec 2 | Out-Null; exit 0 } catch { exit 1 }" >nul 2>nul
if not errorlevel 1 goto open_browser

if not exist "reader-bridge\bin\KL9007ReaderBridge.exe" goto build_reader
goto launch_server

:build_reader
echo Building RFID reader component...
call "reader-bridge\build.bat"
if errorlevel 1 goto build_failed

:launch_server
echo Starting local attendance system...
echo Keep the window named "RFID local service" open while using the system.
start "RFID local service" /D "%~dp0." cmd.exe /k "node server.js"
timeout /t 3 /nobreak >nul

:open_browser
set "CHROME=C:\Program Files\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" goto chrome_missing
start "" "%CHROME%" "http://127.0.0.1:8787/"
echo.
echo System address: http://127.0.0.1:8787/
echo If Chrome did not open, copy the address above into Chrome.
echo Keep the local service window open.
pause
exit /b 0

:missing_node
echo Node.js 22.5 or newer was not found in PATH.
echo Install Node.js, then double-click this shortcut again.
pause
exit /b 1

:build_failed
echo The RFID reader component could not be built.
pause
exit /b 1

:chrome_missing
echo Chrome was not found at:
echo C:\Program Files\Google\Chrome\Application\chrome.exe
echo Install Chrome or open http://127.0.0.1:8787/ in your browser.
pause
exit /b 1
