@echo off
REM career-ops daily consolidated runner
REM Runs LinkedIn alerts parser + ATS scan (--no-email) + one consolidated email
REM Triggered by Windows Task Scheduler at 07:31 daily

cd /d "C:\Claude\career-ops"

REM L3 WebSearch sweep enabled 2026-07-26 (user request): runs the enabled
REM portals.yml search_queries (Indeed, Monster, CryptoJobsList, Hitmarker, ...)
REM via headless claude. Spends tokens daily; remove this line to disable.
REM L3 ROUTE CHANGED 2026-10-08: daily-consolidated.mjs step 3 spawns the Claude
REM CLI itself, but this machine has only claude.ps1 under %APPDATA%/npm (no
REM claude.exe, no claude.cmd) and PowerShell ExecutionPolicy refuses a .ps1,
REM so the step died with "CLI exit 1: unknown" and 0 proposed on every run.
REM The hourly scan already does the same deep sweep via l3-hourly.mjs (the
REM authenticated local web route + gemini failover, one canonical writer),
REM and that path works. So: disable the broken in-process step and run the
REM proven one here instead, right before the digest is built, so whatever it
REM finds at 07:31 lands in that morning email.
SET INCLUDE_L3=false
REM portals.yml carries 19 enabled queries (2026-07-30); the default cap of 14
REM would silently skip the last five (translation, exec comms, lifecycle...).
SET L3_MAX_QUERIES=20
REM Freshness window tightened 14 -> 7 days (user request 2026-08-23): search
REM results older than a week are noise; the nightly sweep enforces the same.
SET MAX_AGE_DAYS=7

echo [%date% %time%] daily-consolidated starting >> logs\daily-consolidated.log

echo [%date% %time%] L3 deep scan (ruta probada: l3-hourly) >> logs\daily-consolidated.log
node l3-hourly.mjs >> logs\daily-consolidated.log 2>&1

node daily-consolidated.mjs >> logs\daily-consolidated.log 2>&1

echo [%date% %time%] daily-consolidated finished (exit code %ERRORLEVEL%) >> logs\daily-consolidated.log
echo. >> logs\daily-consolidated.log
