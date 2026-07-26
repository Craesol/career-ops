@echo off
REM career-ops LinkedIn Premium email-alerts parser
REM Reads unread LinkedIn job-alert emails from Gmail (IMAP), extracts URLs,
REM filters by portals.yml keywords, appends new roles to data/pipeline.md.
REM Runs at 08:55 local, 5 min BEFORE daily-ats-scan.mjs at 09:00.

cd /d "C:\Claude\career-ops"

echo [%date% %time%] linkedin-alerts-parser starting >> logs\linkedin-alerts.log

node linkedin-alerts-parser.mjs >> logs\linkedin-alerts.log 2>&1

echo [%date% %time%] linkedin-alerts-parser finished (exit code %ERRORLEVEL%) >> logs\linkedin-alerts.log
echo. >> logs\linkedin-alerts.log
