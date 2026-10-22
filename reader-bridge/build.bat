@echo off
setlocal
chcp 65001 >nul
set "ROOT=%~dp0.."
set "OUT=%~dp0bin"
if not exist "%OUT%" mkdir "%OUT%"

"C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe" /nologo /target:exe /platform:x86 /optimize+ /out:"%OUT%\KL9007ReaderBridge.exe" /reference:"%ROOT%\vendor\UHFReader18CSharp.dll" "%~dp0Program.cs"
if errorlevel 1 exit /b 1

copy /y "%ROOT%\vendor\UHFReader18CSharp.dll" "%OUT%\UHFReader18CSharp.dll" >nul
copy /y "%ROOT%\vendor\Basic.dll" "%OUT%\Basic.dll" >nul
echo 读卡桥接程序构建完成：%OUT%\KL9007ReaderBridge.exe
