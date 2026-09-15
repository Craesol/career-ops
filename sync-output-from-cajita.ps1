# sync-output-from-cajita.ps1 - DESKTOP-side puller (fork-local; runs only on
# this desktop via the career-ops-output-sync task, every 30 min while on).
#
# House rule (user, 2026-09-07, automated 2026-09-15): EVERY CV/PDF generated
# on CAJITA keeps a copy in this desktop's output\. The manual scp habit
# missed PDFs the user generates himself from the web UI - this closes that.
# Incremental: lists remote *.pdf, copies only names missing locally.
$key = "$env:USERPROFILE\.ssh\cajita_ed25519"
$localDir = 'C:\Claude\career-ops\output'
$logDir = 'C:\Claude\career-ops\.scratch'
$log = Join-Path $logDir 'sync-output.log'
New-Item -ItemType Directory -Force -Path $localDir | Out-Null
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$remoteList = ssh -i $key -o BatchMode=yes -o ConnectTimeout=10 CAJITA@192.168.1.176 "dir /b C:\Claude\career-ops\output\*.pdf" 2>$null
$remoteList = @($remoteList | ForEach-Object { "$_".Trim() } | Where-Object { $_ -match '\.pdf$' })
if ($remoteList.Count -eq 0) {
  Add-Content $log ("[" + (Get-Date -Format s) + "] sin conexion a CAJITA o sin PDFs remotos")
  exit 0
}
$localNames = @((Get-ChildItem $localDir -Filter *.pdf -ErrorAction SilentlyContinue).Name)
$new = @($remoteList | Where-Object { $_ -notin $localNames })
$ok = 0
foreach ($f in $new) {
  scp -i $key -o BatchMode=yes -o ConnectTimeout=10 ("CAJITA@192.168.1.176:C:/Claude/career-ops/output/" + $f) (Join-Path $localDir $f) *> $null
  if (Test-Path (Join-Path $localDir $f)) { $ok++ }
}
Add-Content $log ("[" + (Get-Date -Format s) + "] remotos " + $remoteList.Count + " | nuevos " + $new.Count + " | copiados " + $ok)
if ($new.Count -gt 0) { $new | ForEach-Object { Add-Content $log ("   + " + $_) } }
