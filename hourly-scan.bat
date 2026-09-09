@echo off
REM career-ops hourly DEEP scanner - DESKTOP-P4PVO1V (CAJITA)
REM Task Scheduler: every hour 08:31-23:31. Three sequential steps:
REM   1) scan.mjs        - ATS APIs + boards + feeds (zero tokens)
REM   2) l3-hourly.mjs   - deep scan, dual-engine orchestrator, one writer.
REM                        TODAY: claude primary every hour (sonnet via the
REM                        local web route), gemini as failover only - this
REM                        key's free tier 429s on grounded search (probed
REM                        2026-09-10). When the user enables billing on the
REM                        Google project, add "set L3_ALTERNATE=1" below to
REM                        alternate engines (even=gemini free, odd=claude).
REM   3) auto-triage.mjs - free Gemini prescores for today's new finds
REM Sweeps, prunes and the single daily digest email stay in the 07:31 nightly.
cd /d "C:\Claude\career-ops"
set MAX_AGE_DAYS=7
echo [%date% %time%] hourly scan >> logs\hourly-scan.log
node scan.mjs >> logs\hourly-scan.log 2>&1
echo [%date% %time%] L3 deep scan (alternating engines) >> logs\hourly-scan.log
node l3-hourly.mjs >> logs\hourly-scan.log 2>&1
echo [%date% %time%] auto-triage >> logs\hourly-scan.log
node auto-triage.mjs >> logs\hourly-scan.log 2>&1
echo [%date% %time%] done (exit %ERRORLEVEL%) >> logs\hourly-scan.log
