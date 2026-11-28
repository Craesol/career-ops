# sync-output-from-cajita.ps1 - DESKTOP-side puller (fork-local; runs only on
# this desktop via the career-ops-output-sync task, every 30 min while on).
#
# House rule (user, 2026-09-07, automated 2026-09-15): EVERY CV/PDF generated
# on CAJITA keeps a copy in this desktop's output\. The manual scp habit
# missed PDFs the user generates himself from the web UI - this closes that.
# Incremental: lists remote *.pdf, copies only names missing locally.
#
# Added 2026-11-28: the gitignored USER-LAYER files that cannot travel by git.
# cv.md and data\applications.md are both in .gitignore (this fork is PUBLIC),
# so for two months nothing kept them in step - and cv.md duly diverged
# between the two machines (desktop 2026-11-04 vs CAJITA 2026-11-23, neither a
# superset of the other, which silently killed verify-cv-structure.mjs on the
# desktop copy). CAJITA is the single writer per AGENTS.md "Scheduling
# ownership", so this pull makes the desktop a read-only mirror of it.
#
# The pull is deliberately NON-DESTRUCTIVE: a local file that differs from
# CAJITA's is copied into .scratch\user-layer-backups\ before CAJITA's version
# lands on it, and the log names the backup. A hand edit made on the wrong
# machine is therefore recoverable, never silently lost. Nothing is ever
# pushed UP from here - that would make the desktop a second writer, which is
# exactly the thing the ownership rule forbids.
$key = "$env:USERPROFILE\.ssh\cajita_ed25519"
$root = 'C:\Claude\career-ops'
$remoteRoot = 'C:/Claude/career-ops'      # scp/URL form (forward slashes)
$remoteRootWin = 'C:\Claude\career-ops'   # cmd form: `dir` needs backslashes,
                                          # and silently lists nothing when a
                                          # path mixes the two (caught 2026-11-28
                                          # by a run reporting 0 PDFs where the
                                          # scheduled runs report 190)
$cajita = 'CAJITA@192.168.1.176'
$localDir = Join-Path $root 'output'
$logDir = Join-Path $root '.scratch'
$log = Join-Path $logDir 'sync-output.log'
$bakDir = Join-Path $logDir 'user-layer-backups'
New-Item -ItemType Directory -Force -Path $localDir | Out-Null
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
New-Item -ItemType Directory -Force -Path $bakDir | Out-Null

# --- reachability probe -------------------------------------------------
# One explicit check, so an unrelated condition never gates unrelated work.
# Before 2026-11-28 an empty remote *.pdf list exited the whole script, which
# conflated "CAJITA is off" with "CAJITA has no PDFs" - and once the
# user-layer pull was added below, the second would have silently skipped it.
$probe = ssh -i $key -o BatchMode=yes -o ConnectTimeout=10 $cajita "echo co-sync-ok" 2>$null
if (-not ($probe -match 'co-sync-ok')) {
  Add-Content $log ("[" + (Get-Date -Format s) + "] CAJITA inalcanzable - nada sincronizado")
  exit 0
}

# --- PDFs (original job) ------------------------------------------------
$remoteList = ssh -i $key -o BatchMode=yes -o ConnectTimeout=10 $cajita "dir /b $remoteRootWin\output\*.pdf" 2>$null
$remoteList = @($remoteList | ForEach-Object { "$_".Trim() } | Where-Object { $_ -match '\.pdf$' })
$localNames = @((Get-ChildItem $localDir -Filter *.pdf -ErrorAction SilentlyContinue).Name)
$new = @($remoteList | Where-Object { $_ -notin $localNames })
$ok = 0
foreach ($f in $new) {
  scp -i $key -o BatchMode=yes -o ConnectTimeout=10 ($cajita + ":" + $remoteRoot + "/output/" + $f) (Join-Path $localDir $f) *> $null
  if (Test-Path (Join-Path $localDir $f)) { $ok++ }
}
Add-Content $log ("[" + (Get-Date -Format s) + "] remotos " + $remoteList.Count + " | nuevos " + $new.Count + " | copiados " + $ok)
if ($new.Count -gt 0) { $new | ForEach-Object { Add-Content $log ("   + " + $_) } }

# --- gitignored user-layer files (2026-11-28) ---------------------------
# One file at a time, each guarded: a failed pull, an absent remote file or an
# empty remote file all leave the local copy untouched. Only a successful,
# non-empty, genuinely different pull writes - and only after a backup.
function Sync-FileFromCajita {
  param([string]$Relative)
  $localPath = Join-Path $root $Relative
  $remotePath = $remoteRoot + '/' + ($Relative -replace '\\', '/')
  $tmp = Join-Path $env:TEMP ('co-sync-' + ($Relative -replace '[\\/]', '_'))
  if (Test-Path $tmp) { Remove-Item $tmp -Force }
  scp -i $key -o BatchMode=yes -o ConnectTimeout=10 ($cajita + ":" + $remotePath) $tmp *> $null
  if (-not (Test-Path $tmp)) {
    Add-Content $log ("   ! " + $Relative + ": pull fallido (CAJITA inalcanzable o fichero ausente) - copia local intacta")
    return
  }
  if ((Get-Item $tmp).Length -eq 0) {
    Add-Content $log ("   ! " + $Relative + ": remoto vacio - copia local intacta")
    Remove-Item $tmp -Force
    return
  }
  $remoteLen = (Get-Item $tmp).Length
  if (Test-Path $localPath) {
    $hRemote = (Get-FileHash $tmp -Algorithm SHA256).Hash
    $hLocal = (Get-FileHash $localPath -Algorithm SHA256).Hash
    if ($hRemote -eq $hLocal) {
      Remove-Item $tmp -Force
      return
    }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $leaf = Split-Path $Relative -Leaf
    $bakName = $leaf -replace '\.([^.]+)$', ('-' + $stamp + '.$1')
    if ($bakName -eq $leaf) { $bakName = $leaf + '-' + $stamp }
    $bak = Join-Path $bakDir $bakName
    Copy-Item $localPath $bak -Force
    Add-Content $log ("   ~ " + $Relative + ": difiere de CAJITA - copia local guardada en " + $bak)
  }
  $parent = Split-Path $localPath -Parent
  if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
  Move-Item $tmp $localPath -Force
  Add-Content $log ("   = " + $Relative + ": actualizado desde CAJITA (" + $remoteLen + " bytes)")
}

Sync-FileFromCajita 'cv.md'
Sync-FileFromCajita 'data\applications.md'

# --- agent inbox (2026-10-09) -------------------------------------------
# Rides this same task rather than adding a second one. The inbox is personal
# data kept out of a PUBLIC fork, so it syncs over the LAN like output\ does.
# This one IS two-way (union merge) by design - see sync-agent-inbox.ps1.
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'sync-agent-inbox.ps1')
