@echo off
setlocal
set "NODE_BIN=%ROSETTA_NODE_BIN%"
if not defined NODE_BIN set "NODE_BIN=node.exe"
if exist "%NODE_BIN%" goto :has_node
where node.exe >nul 2>nul
if errorlevel 1 goto :no_node
:has_node
if "%~1"=="--dry-run" goto :run_direct
if "%~1"=="--smoke" goto :run_direct
wscript.exe //nologo "%~dp0src\desktop\start-hidden.vbs" %*
if errorlevel 1 goto :run_direct
exit /b 0
:run_direct
"%NODE_BIN%" "%~dp0src\desktop\launcher.cjs" %*
exit /b %errorlevel%
:no_node
echo [Rosetta] Node.js 20+ not found. Please install Node.js from https://nodejs.org/ or set ROSETTA_NODE_BIN.
exit /b 1
