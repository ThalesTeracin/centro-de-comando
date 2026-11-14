@echo off
cd /d "%~dp0"
if not exist node_modules call npm install
curl -s -o nul http://127.0.0.1:7777/ || (start "" /min cmd /c node server.js & timeout /t 2 /nobreak >nul)
start "" msedge --app=http://127.0.0.1:7777
