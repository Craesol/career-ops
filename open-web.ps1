# open-web.ps1 - abre la web de career-ops (fork-local, se ejecuta en el DESKTOP).
#
# La web la sirve CAJITA (DESKTOP-P4PVO1V, 192.168.1.176:3000) las 24 horas, y
# CAJITA es la UNICA maquina que escribe estado de usuario (tracker, reports,
# pipeline). Por eso este lanzador NO arranca un servidor local: start-web.bat
# hace eso, y dos webs escribiendo los mismos ficheros es exactamente como se
# perdieron los reports #280-289. Aqui solo abrimos la de CAJITA, y si no
# responde la levantamos EN CAJITA por SSH.
#
# Pasos: comprobar el puerto -> si no responde, lanzar la tarea career-ops-web
# en CAJITA -> esperar a que conteste -> abrir Brave.

$ErrorActionPreference = 'Continue'
$cajitaIp   = '192.168.1.176'
$cajitaUser = 'CAJITA'
$port       = 3000
$url        = "http://${cajitaIp}:${port}"
$key        = "$env:USERPROFILE\.ssh\cajita_ed25519"

function Test-WebUp {
    param([int]$TimeoutMs = 3000)
    try {
        $client = New-Object Net.Sockets.TcpClient
        $wait = $client.BeginConnect($cajitaIp, $port, $null, $null)
        if (-not $wait.AsyncWaitHandle.WaitOne($TimeoutMs, $false)) { $client.Close(); return $false }
        $client.EndConnect($wait); $client.Close(); return $true
    } catch { return $false }
}

function Open-InBrave {
    # Brave explicito, no `Start-Process $url`, que usaria el navegador por
    # defecto de Windows (regla del usuario: en esta maquina solo Brave).
    $candidates = @(
        "$env:ProgramFiles\BraveSoftware\Brave-Browser\Application\brave.exe",
        "${env:ProgramFiles(x86)}\BraveSoftware\Brave-Browser\Application\brave.exe",
        "$env:LOCALAPPDATA\BraveSoftware\Brave-Browser\Application\brave.exe"
    )
    $brave = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
    if ($brave) { Start-Process $brave $url } else { Start-Process $url }
}

Write-Host ''
Write-Host '  career-ops  -  web de CAJITA' -ForegroundColor Cyan
Write-Host "  $url" -ForegroundColor DarkGray
Write-Host ''

# --- 1. camino rapido: ya esta levantada -------------------------------------
if (Test-WebUp) {
    Write-Host '  La web ya esta activa. Abriendo Brave...' -ForegroundColor Green
    Open-InBrave
    Start-Sleep -Milliseconds 700
    exit 0
}

# --- 2. no responde: distinguir "CAJITA apagada" de "web caida" --------------
Write-Host '  La web no responde. Comprobando CAJITA...' -ForegroundColor Yellow
if (-not (Test-Connection -ComputerName $cajitaIp -Count 1 -Quiet -ErrorAction SilentlyContinue)) {
    Write-Host ''
    Write-Host "  CAJITA ($cajitaIp) no contesta al ping." -ForegroundColor Red
    Write-Host '  Comprueba que el servidor este encendido y en la red.' -ForegroundColor Red
    Write-Host ''
    Write-Host '  Pulsa una tecla para cerrar...' -ForegroundColor DarkGray
    $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
    exit 1
}

if (-not (Test-Path $key)) {
    Write-Host ''
    Write-Host "  CAJITA responde, pero falta la clave SSH:" -ForegroundColor Red
    Write-Host "  $key" -ForegroundColor Red
    Write-Host '  Sin ella no puedo levantar la web remotamente.' -ForegroundColor Red
    Write-Host ''
    Write-Host '  Pulsa una tecla para cerrar...' -ForegroundColor DarkGray
    $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
    exit 1
}

# --- 3. levantarla en CAJITA ------------------------------------------------
# /end antes de /run: una tarea que quedo "Running" con el proceso muerto
# ignora el /run en silencio (asi fallo el watchdog el 2026-09-12).
Write-Host '  CAJITA responde. Arrancando la web alli...' -ForegroundColor Yellow
ssh -i $key -o BatchMode=yes -o ConnectTimeout=10 "$cajitaUser@$cajitaIp" `
    "schtasks /end /tn career-ops-web" *> $null
ssh -i $key -o BatchMode=yes -o ConnectTimeout=10 "$cajitaUser@$cajitaIp" `
    "schtasks /run /tn career-ops-web" *> $null

# Next.js en frio tarda 20-60 s en compilar, asi que esperamos hasta 90 s.
Write-Host -NoNewline '  Esperando a que conteste '
$up = $false
for ($i = 0; $i -lt 45; $i++) {
    if (Test-WebUp -TimeoutMs 1500) { $up = $true; break }
    Write-Host -NoNewline '.'
    Start-Sleep -Seconds 2
}
Write-Host ''

if ($up) {
    Write-Host '  Lista. Abriendo Brave...' -ForegroundColor Green
    Open-InBrave
    Start-Sleep -Milliseconds 700
    exit 0
}

Write-Host ''
Write-Host '  La web no ha arrancado en 90 segundos.' -ForegroundColor Red
Write-Host '  Mira el log en CAJITA:' -ForegroundColor DarkGray
Write-Host '    C:\Claude\career-ops\logs\web.log' -ForegroundColor DarkGray
Write-Host '  O entra por SSH y lanzala a mano:' -ForegroundColor DarkGray
Write-Host "    ssh -i `"$key`" $cajitaUser@$cajitaIp" -ForegroundColor DarkGray
Write-Host '    schtasks /run /tn career-ops-web' -ForegroundColor DarkGray
Write-Host ''
Write-Host '  Pulsa una tecla para cerrar...' -ForegroundColor DarkGray
$null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
exit 1
