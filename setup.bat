@echo off
echo Installing Awon dependencies...
cd /d "%~dp0"
npm install
echo.
echo Done. Copy config\.env.example to config\.env and fill in your keys.
echo Then run: npm start
pause
