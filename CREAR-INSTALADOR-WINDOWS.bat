@echo off
chcp 65001 >nul
echo ==========================================
echo  Panchito Enterprise - Instalador Windows
echo ==========================================
echo.
echo Instalando dependencias...
call npm install
if errorlevel 1 goto error

echo.
echo Generando instalador .EXE...
call npm run dist:win
if errorlevel 1 goto error

echo.
echo LISTO. El instalador queda en la carpeta: dist
echo Busca: Panchito Enterprise Setup.exe
echo y/o: Panchito Enterprise Portable.exe
echo.
pause
exit /b 0

:error
echo.
echo ERROR: no se pudo crear el instalador.
echo Copia las ultimas lineas de esta ventana y mandamelas.
pause
exit /b 1
