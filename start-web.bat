@echo off
REM career-ops web UI launcher — starts the dev server, waits for it, opens BRAVE.
REM Brave is explicit (not `start ""`, which would use the Windows default
REM browser) per the user's "only Brave on this machine" rule. If Brave ever
REM moves or is uninstalled, the fallback keeps the launcher working instead of
REM silently opening nothing.
REM 2026-08-23: server now starts FIRST and the browser opens once the port
REM answers (cold Next.js compiles take 20-60s — opening Brave immediately
REM landed on a connection error). Also self-heals a missing/stale
REM web\node_modules after a git sync.

cd /d "C:\Claude\career-ops\web"

REM -- Self-heal deps: fresh clone or post-sync machine without node_modules --
if not exist "node_modules\next" (
  echo [setup] web dependencies missing - running npm install...
  call npm install
)

set "BRAVE=%ProgramFiles%\BraveSoftware\Brave-Browser\Application\brave.exe"
if not exist "%BRAVE%" set "BRAVE=%ProgramFiles(x86)%\BraveSoftware\Brave-Browser\Application\brave.exe"
if not exist "%BRAVE%" set "BRAVE=%LOCALAPPDATA%\BraveSoftware\Brave-Browser\Application\brave.exe"

REM -- Open the browser only when the server actually answers on :3000 --
REM Background PowerShell polls the port (up to ~90s), then launches Brave; if
REM the port never answers it opens anyway (old behavior as worst case).
start "" /b powershell -NoProfile -Command "for($i=0;$i -lt 45;$i++){try{$c=New-Object Net.Sockets.TcpClient('localhost',3000);$c.Close();break}catch{Start-Sleep -Seconds 2}}; if(Test-Path '%BRAVE%'){Start-Process '%BRAVE%' 'http://localhost:3000'}else{Start-Process 'http://localhost:3000'}"

npm run dev
