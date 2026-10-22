@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
where node.exe >nul 2>nul
if errorlevel 1 goto missing_node
node "%~dp0staff-tool\launch.cjs"
if errorlevel 1 goto failed
exit /b 0
:missing_node
echo Node.js 22.5 or newer is required.
:failed
echo.
echo The tool could not open. See the message above.
pause
exit /b 1
