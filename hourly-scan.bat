@echo off
REM career-ops hourly DEEP scanner - DESKTOP-P4PVO1V (CAJITA)
REM Task Scheduler: every hour 08:31-23:31. Three sequential steps:
REM   1) scan.mjs        - ATS APIs + boards + feeds (zero tokens)
REM   2) l3-hourly.mjs   - deep scan, TWO alternating engines, one writer:
REM                        EVEN hours gemini (Google grounding, FREE tier),
REM                        ODD hours claude (sonnet via the local web route,
REM                        spends plan usage ~8x/day). Either failure fails
REM                        over to the other engine - no hour goes uncovered.
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
