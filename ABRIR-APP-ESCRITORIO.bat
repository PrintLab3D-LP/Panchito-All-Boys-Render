@echo off
chcp 65001 >nul
echo Abriendo Panchito Enterprise como app de escritorio...
call npm install
call npm run app
pause
