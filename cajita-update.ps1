# Actualiza CAJITA a v1.36.0. CAJITA es la dueña del estado de usuario, asi que
# sus escrituras de datos se commitean ANTES de traer nada: si el pull entra
# primero, un merge sobre fichero sucio aborta a medias.
$ErrorActionPreference = 'Continue'
Set-Location C:\Claude\career-ops

'=== 1. commitear los datos propios de CAJITA ==='
$dirty = @(git status --porcelain)
if ($dirty.Count -gt 0) {
  git add -A
  git commit -m "data sync from CAJITA before the v1.36.0 pull" --quiet
  '  commiteado: ' + $dirty.Count + ' fichero(s)'
} else {
  '  nada que commitear'
}

'=== 2. traer de origin ==='
git pull --no-rebase origin main 2>&1 | Select-Object -Last 6

'=== 3. estado ==='
'  HEAD: ' + (git rev-parse --short HEAD)
'  conflictos: ' + (@(git diff --name-only --diff-filter=U)).Count
'  version: ' + ((Get-Content package.json | Select-String '"version"' | Select-Object -First 1).Line.Trim())

'=== 4. los modulos nuevos de lib/ llegaron? ==='
foreach ($f in @('lib\template-manifest.mjs','lib\story-bank.mjs','lib\cv-markdown.mjs','lib\node-floor.mjs','lib\parse-date.mjs','lib\small-board.mjs','lib\tsv-formula-escape.mjs')) {
  if (Test-Path $f) { '  OK   ' + $f } else { '  FALTA ' + $f }
}

'=== 5. comprobaciones en caliente ==='
node -e "import('./cv-templates.mjs').then(()=>console.log('  cv-templates carga OK')).catch(e=>console.log('  cv-templates FALLA: '+e.message))"
'  --- portales ---'
node verify-pipeline.mjs 2>&1 | Select-String 'enabled portals.yml|Pipeline Health' | ForEach-Object { '  ' + $_.Line.Trim() }
'  --- entradas startup.jobs ---'
node -e "const y=require('js-yaml');const c=y.load(require('fs').readFileSync('portals.yml','utf8'));console.log('  startup-jobs: '+c.job_boards.filter(b=>b.provider==='startup-jobs').length+' entradas')"
'  --- registro de plugins ---'
node validate-plugin-registry.mjs 2>&1 | Select-Object -Last 1 | ForEach-Object { '  ' + $_ }
