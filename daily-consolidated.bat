@echo off
REM career-ops daily consolidated runner
REM Runs LinkedIn alerts parser + ATS scan (--no-email) + one consolidated email
REM Triggered by Windows Task Scheduler at 11:31 daily

cd /d "C:\Claude\career-ops"

REM L3 WebSearch sweep enabled 2026-07-26 (user request): runs the enabled
REM portals.yml search_queries (Indeed, Monster, CryptoJobsList, Hitmarker, ...)
REM via headless claude. Spends tokens daily; remove this line to disable.
SET INCLUDE_L3=true

echo [%date% %time%] daily-consolidated starting >> logs\daily-consolidated.log

node daily-consolidated.mjs >> logs\daily-consolidated.log 2>&1

echo [%date% %time%] daily-consolidated finished (exit code %ERRORLEVEL%) >> logs\daily-consolidated.log
echo. >> logs\daily-consolidated.log
