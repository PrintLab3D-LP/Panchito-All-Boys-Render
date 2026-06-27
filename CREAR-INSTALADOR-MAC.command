#!/bin/bash
cd "$(dirname "$0")"
echo "Panchito Enterprise - Instalador Mac"
npm install
npm run dist:mac
echo "Listo. Revisá la carpeta dist"
read -n 1 -s -r -p "Presioná una tecla para cerrar"
