@echo off
cd /d "%~dp0"
SET GIT="C:\Program Files\Git\cmd\git.exe"

echo === Awon — Fix blocked commit and push cleanly ===

REM Clear ALL stale git locks
IF EXIST ".git\index.lock"           del /f ".git\index.lock"
IF EXIST ".git\HEAD.lock"            del /f ".git\HEAD.lock"
IF EXIST ".git\refs\heads\main.lock" del /f ".git\refs\heads\main.lock"
IF EXIST ".git\config.lock"          del /f ".git\config.lock"
echo Git locks cleared.

REM Undo the last commit (keep all files staged, don't lose changes)
%GIT% reset --soft HEAD~1
echo Undid blocked commit.

REM Re-stage everything (push-to-github.bat is now gitignored so it won't be included)
%GIT% add -A
echo Files staged.

REM New clean commit — no secrets
%GIT% commit -m "Awon upgrade: brand DNA, Printify POD, store agent, content queue, inner work loop"
echo Committed cleanly.

REM Read PAT from config\.env
FOR /F "tokens=2 delims==" %%A IN ('findstr "GITHUB_PAT" "%~dp0config\.env" 2^>nul') DO SET GITHUB_PAT=%%A
IF "%GITHUB_PAT%"=="" (
  echo ERROR: GITHUB_PAT not found in config\.env
  pause & exit /b 1
)

REM Push
%GIT% remote remove origin 2>nul
%GIT% remote add origin https://%GITHUB_PAT%@github.com/joshuamerlene/awon.git
%GIT% branch -M main
%GIT% push -u origin main
SET GITHUB_PAT=

echo.
echo Done. Railway will auto-deploy in ~60 seconds.
echo You can delete fix-and-push.bat now.
pause
