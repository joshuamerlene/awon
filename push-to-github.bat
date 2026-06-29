@echo off
cd /d "%~dp0"
SET GIT="C:\Program Files\Git\cmd\git.exe"

echo === Awon — Stage, Commit, Push ===

REM Remove ALL stale git locks
IF EXIST ".git\index.lock"           del /f ".git\index.lock"
IF EXIST ".git\HEAD.lock"            del /f ".git\HEAD.lock"
IF EXIST ".git\refs\heads\main.lock" del /f ".git\refs\heads\main.lock"
IF EXIST ".git\config.lock"          del /f ".git\config.lock"
echo Git locks cleared.

REM Stage all changes
%GIT% add -A

REM Commit
%GIT% commit -m "Awon upgrade: brand DNA, Printify, store agent, content queue, autonomous inner work loop"

REM Set remote and push (PAT stored in config\.env, not here)
FOR /F "tokens=1,2 delims==" %%A IN ('findstr "GITHUB_PAT" "%~dp0config\.env" 2^>nul') DO SET GITHUB_PAT=%%B
IF "%GITHUB_PAT%"=="" (
  echo ERROR: Add GITHUB_PAT=ghp_... to config\.env then re-run.
  pause & exit /b 1
)
%GIT% remote remove origin 2>nul
%GIT% remote add origin https://%GITHUB_PAT%@github.com/joshuamerlene/awon.git
%GIT% branch -M main
%GIT% push -u origin main
SET GITHUB_PAT=

echo.
echo Done. Railway will auto-deploy in ~60 seconds.
pause
