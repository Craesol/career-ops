@echo off
REM career-ops web UI launcher — opens http://localhost:3000 in BRAVE.
REM Brave is explicit (not `start ""`, which would use the Windows default
REM browser) per the user's "only Brave on this machine" rule. If Brave ever
REM moves or is uninstalled, the fallback keeps the launcher working instead of
REM silently opening nothing.

cd /d "C:\Claude\career-ops\web"

set "BRAVE=%ProgramFiles%\BraveSoftware\Brave-Browser\Application\brave.exe"
if not exist "%BRAVE%" set "BRAVE=%ProgramFiles(x86)%\BraveSoftware\Brave-Browser\Application\brave.exe"
if not exist "%BRAVE%" set "BRAVE=%LOCALAPPDATA%\BraveSoftware\Brave-Browser\Application\brave.exe"

if exist "%BRAVE%" (
  start "" "%BRAVE%" "http://localhost:3000"
) else (
  echo [warn] Brave not found - falling back to the default browser.
  start "" "http://localhost:3000"
)

npm run dev
