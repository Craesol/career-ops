@echo off
REM career-ops hourly DEEP scanner - DESKTOP-P4PVO1V (CAJITA)
REM Task Scheduler: every hour 08:31-23:31. Three sequential steps:
REM   1) scan.mjs        - ATS APIs + boards + feeds (zero tokens)
REM   2) L3 deep scan    - ALL portals.yml search_queries via the local web's
REM                        /api/explore/l3 (claude headless on sonnet; spends
REM                        Claude-plan usage ~16x/day - switch cliId to change)
REM   3) auto-triage.mjs - free Gemini prescores for today's new finds
REM Sweeps, prunes and the single daily digest email stay in the 07:31 nightly.
cd /d "C:\Claude\career-ops"
set MAX_AGE_DAYS=7
echo [%date% %time%] hourly scan >> logs\hourly-scan.log
node scan.mjs >> logs\hourly-scan.log 2>&1
echo [%date% %time%] L3 deep scan (all queries, sonnet) >> logs\hourly-scan.log
REM l3-log-filter.mjs (NOT findstr): findstr silently drops lines over ~8KB,
REM which ate every successful done line and faked a failure streak on
REM 2026-09-09. The filter keeps start/proposed/done/log/error, drops
REM progress, truncates long lines to 400 chars.
curl -s --max-time 900 -X POST http://localhost:3000/api/explore/l3 -H "Content-Type: application/json" -d "{\"cliId\":\"claude\",\"model\":\"sonnet\"}" | node l3-log-filter.mjs >> logs\hourly-scan.log 2>&1
echo [%date% %time%] auto-triage >> logs\hourly-scan.log
node auto-triage.mjs >> logs\hourly-scan.log 2>&1
echo [%date% %time%] done (exit %ERRORLEVEL%) >> logs\hourly-scan.log
