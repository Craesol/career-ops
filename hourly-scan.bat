@echo off
REM career-ops hourly scanner (zero-token) - DESKTOP-P4PVO1V (CAJITA)
REM Task Scheduler: every hour 08:31-23:31. Runs ONLY scan.mjs (ATS + boards,
REM no LLM, no email); the 07:31 nightly keeps L3, sweeps and the daily digest.
cd /d "C:\Claude\career-ops"
set MAX_AGE_DAYS=7
echo [%date% %time%] hourly scan >> logs\hourly-scan.log
node scan.mjs >> logs\hourly-scan.log 2>&1
echo [%date% %time%] done (exit %ERRORLEVEL%) >> logs\hourly-scan.log
