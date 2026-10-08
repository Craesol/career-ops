# sync-agent-inbox.ps1 - DESKTOP-side two-way sync of data\agent-inbox.md with
# CAJITA (fork-local; called from sync-output-from-cajita.ps1, so it rides the
# existing career-ops-output-sync task every 30 min while this desktop is on).
#
# WHY NOT GIT: the inbox is personal data and agent-inbox.mjs keeps it
# gitignored on purpose. Craesol/career-ops is a PUBLIC fork, so tracking it
# the way portals.yml is tracked would publish every queued item. It travels
# over the LAN instead, like output\ already does.
#
# The merge rules live in sync-agent-inbox.mjs (union, resolved-beats-pending,
# covered by tests\sync-agent-inbox.test.mjs). This script only moves bytes,
# and it is deliberately FAIL-CLOSED: the first version pushed the local file
# whenever the pull came back empty, which silently clobbered an item queued on
# CAJITA. Three rules now prevent that:
#   1. Remote state is read with `dir /b`, which distinguishes three cases -
#      the file is listed (exists), "File Not Found" (absent), no output at all
#      (unreachable). Only the first two are safe to act on.
#   2. If the remote file exists, the pull must succeed before anything is
#      pushed. A failed pull aborts the run.
#   3. The merge may never contain fewer items than the copy pulled from
#      CAJITA. If it does, something is wrong with the merge and nothing is
#      pushed.

$ErrorActionPreference = 'Continue'
$key       = "$env:USERPROFILE\.ssh\cajita_ed25519"
$root      = 'C:\Claude\career-ops'
$localFile = Join-Path $root 'data\agent-inbox.md'
$logDir    = Join-Path $root '.scratch'
$log       = Join-Path $logDir 'sync-inbox.log'
$pulled    = Join-Path $env:TEMP 'co-inbox-remote.md'
$remotePath = 'C:/Claude/career-ops/data/agent-inbox.md'
$target    = 'CAJITA@192.168.1.176'

New-Item -ItemType Directory -Force -Path $logDir | Out-Null
function Note($m) { Add-Content $log ("[" + (Get-Date -Format s) + "] " + $m) }
function CountItems($path) {
  if (-not (Test-Path $path)) { return 0 }
  return @(Get-Content $path | Where-Object { $_ -match '^-\s*\[( |x|X)\]' }).Count
}

# --- 1. what does CAJITA have? -------------------------------------------
Remove-Item $pulled -ErrorAction SilentlyContinue
$listing = ssh -i $key -o BatchMode=yes -o ConnectTimeout=10 $target "dir /b C:\Claude\career-ops\data\agent-inbox.md"
$listing = @($listing | ForEach-Object { "$_".Trim() } | Where-Object { $_ })
if ($listing.Count -eq 0) { Note 'CAJITA no responde - sync omitido (nada empujado)'; exit 0 }

$remoteExists = [bool]($listing -match 'agent-inbox\.md$')
$remoteCount  = 0

# --- 2. pull it, and abort rather than push if the pull fails -------------
if ($remoteExists) {
  scp -i $key -o BatchMode=yes -o ConnectTimeout=10 ("${target}:" + $remotePath) $pulled *> $null
  if (-not (Test-Path $pulled)) {
    Note 'el fichero remoto existe pero el scp fallo - abortado SIN empujar'
    exit 0
  }
  $remoteCount = CountItems $pulled
}

# --- 3. merge (node owns the rules; writes only when something changed) ---
$localBefore = CountItems $localFile
Push-Location $root
$nodeArgs = @('sync-agent-inbox.mjs', '--local', $localFile)
if (Test-Path $pulled) { $nodeArgs += @('--remote', $pulled) }
$summary = & node @nodeArgs
$rc = $LASTEXITCODE
Pop-Location
if ($rc -ne 0) { Note ("merge FALLO (exit $rc): " + ($summary -join ' ') + ' - nada empujado'); exit 0 }

# --- 4. safety invariant: a merge can only ever grow ----------------------
$mergedCount = CountItems $localFile
if ($mergedCount -lt $remoteCount -or $mergedCount -lt $localBefore) {
  Note ("ABORTADO: el merge tiene $mergedCount items, menos que remoto=$remoteCount " +
        "o local=$localBefore - nada empujado, revisar sync-agent-inbox.mjs")
  exit 1
}

# --- 5. push the merged file back when CAJITA's copy differs -------------
if (-not (Test-Path $localFile)) { Note ('sin inbox local - ' + ($summary -join ' ')); exit 0 }
$mergedHash = (Get-FileHash $localFile -Algorithm SHA256).Hash
$remoteHash = if (Test-Path $pulled) { (Get-FileHash $pulled -Algorithm SHA256).Hash } else { '' }
$pushed = $false
if ($mergedHash -ne $remoteHash) {
  ssh -i $key -o BatchMode=yes -o ConnectTimeout=10 $target "if not exist C:\Claude\career-ops\data mkdir C:\Claude\career-ops\data" *> $null
  scp -i $key -o BatchMode=yes -o ConnectTimeout=10 $localFile ("${target}:" + $remotePath) *> $null
  $pushed = $true
}
Note (($summary -join ' ') + " | remoto=$remoteCount local=$localBefore merge=$mergedCount | empujado: $pushed")
