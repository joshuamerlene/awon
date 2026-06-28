@echo off
cd /d "%~dp0"
echo Pushing Awon to GitHub...
git init
git config user.email "joshuamerlene@gmail.com"
git config user.name "joshuamerlene"
git add .
git commit -m "Awon v1 - initial deploy"
git branch -M main
git remote remove origin 2>nul
git remote add origin https://github.com/joshuamerlene/awon.git
git push -u origin main
echo.
echo Done! Check github.com/joshuamerlene/awon
pause
