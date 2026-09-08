@echo off
REM career-ops daily full-ATS reverse sweep - DESKTOP-P4PVO1V (CAJITA)
REM Task Scheduler: daily 03:33 (career-ops-ats-full, SYSTEM account). Walks the
REM PUBLIC company directories of Greenhouse/Lever/Ashby/Workday/iCIMS (thousands
REM of companies, not just tracked_companies) filtered by portals.yml
REM title_filter/location_filter. Zero LLM tokens - pure HTTP. Fresh finds land
REM in scan-history/pipeline before the 07:31 nightly builds the daily email.
cd /d "C:\Claude\career-ops"
echo [%date% %time%] ats-full sweep >> logs\ats-full.log
node scan-ats-full.mjs --since 2 >> logs\ats-full.log 2>&1
echo [%date% %time%] done (exit %ERRORLEVEL%) >> logs\ats-full.log
