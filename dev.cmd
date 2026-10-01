@echo off
rem Ruta larga explicita: con la ruta corta (8.3) el watcher de Node falla (fs-event.c).
cd /d "C:\Users\Usuario\Documents\REVISOR OGUC WEB"
npm run dev -- --port 3000
