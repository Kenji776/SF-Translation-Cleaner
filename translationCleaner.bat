@echo off
cd /D "%~dp0"

if not exist "node_modules\" (
    echo "Node modules folder not detected. Assuming fresh install. Installing..."
    npm install
)

node index.js
pause