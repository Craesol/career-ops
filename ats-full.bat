@echo off
REM career-ops daily full-ATS reverse sweep - DESKTOP-P4PVO1V (CAJITA)
REM Task Scheduler: daily 02:33 (career-ops-ats-full, SYSTEM account). Walks the
REM PUBLIC company directories of Greenhouse/Lever/Ashby/Workday/iCIMS (thousands
REM of companies, not just tracked_companies) filtered by portals.yml
REM title_filter/location_filter. Zero LLM tokens - pure HTTP. Fresh finds land
REM in scan-history/pipeline before the 07:31 nightly builds the daily email.
cd /d "C:\Claude\career-ops"

REM Singleton guard (2026-09-09): a sweep can outlive its day - the 09-08
REM manual run was still going when the next scheduled slot arrived. Two
REM concurrent sweeps double the request storm; skip if one is running.
powershell -NoProfile -Command "if (Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'scan-ats-full' }) { exit 1 } else { exit 0 }"
if errorlevel 1 (
  echo [%date% %time%] skip: another ats-full sweep is still running >> logs\ats-full.log
  exit /b 0
)

REM Gentle DNS pacing (2026-09-09): the 03:33 sweep's ~27k lookups coincided
REM with the Bbox router's DNS dying for ~8h - the whole machine lost outbound
REM resolution (blind nightly, no email). 150/min keeps a full sweep under a
REM consumer router's radar; the sweep just takes longer, which is fine at 2am.
set CAREER_OPS_DNS_LOOKUPS_PER_MIN=150

echo [%date% %time%] ats-full sweep >> logs\ats-full.log
node scan-ats-full.mjs --since 2 >> logs\ats-full.log 2>&1
echo [%date% %time%] done (exit %ERRORLEVEL%) >> logs\ats-full.log
