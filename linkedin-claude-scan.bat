@echo off
REM career-ops LinkedIn search via Claude in Brave (Claude in Chrome extension)
REM Lanzado por la tarea programada "career-ops-linkedin-claude" 3 veces al dia
REM (09:50, 14:50, 19:50), fuera de los :31 del escaneo horario para no
REM coincidir con el escaneo de sesion en Brave. Solo lectura; ver la cabecera
REM de linkedin-claude-scan.mjs.
cd /d "C:\Claude\career-ops"
echo [%date% %time%] linkedin-claude >> logs\linkedin-claude-scan.log
node linkedin-claude-scan.mjs >> logs\linkedin-claude-scan.log 2>&1
echo [%date% %time%] done (exit %ERRORLEVEL%) >> logs\linkedin-claude-scan.log
