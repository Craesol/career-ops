# Ejecución local (Windows)

El escaneo diario corre en tu máquina, no en la nube. Allí no hay proxy: Resend
envía, las APIs de ATS responden y `scan.mjs` funciona. Nada de secrets ni de
GitHub Actions.

## 1. Traer el código

```powershell
cd C:\Claude\career-ops
git fetch origin
git checkout claude/view-page-display-ggrYS
git pull origin claude/view-page-display-ggrYS
npm install
```

## 2. Colocar los archivos de configuración

Van en el `.tar.gz` que te envié. **No están en git** (`.gitignore`), así que hay
que copiarlos a mano tras cada clonado:

| Archivo | Qué es |
|---|---|
| `.env` | Claves: `RESEND_API_KEY`, `NOTIFY_EMAIL`, `GMAIL_*` |
| `portals.yml` | Filtros de título, 71 empresas y 9 job boards |
| `config/profile.yml` | Tus datos y roles objetivo |
| `cv.md` | Tu CV |

Descomprime encima de `C:\Claude\career-ops`, respetando las rutas.

## 3. Comprobar que todo está en su sitio

```powershell
npm run doctor
npm run validate:portals
```

`doctor` avisará de que falta Chromium de Playwright. Solo hace falta para
`scan.mjs --verify` y la extracción por navegador; el escaneo diario no lo usa.
Si lo quieres igualmente: `npx playwright install chromium`.

## 4. Probar a mano antes de programar nada

```powershell
node daily-consolidated.mjs
```

Tarda unos minutos. Al terminar debe llegarte un correo a `traducto@gmail.com`.
Si no llega, mira `logs\daily-consolidated.log`.

Para probar solo el envío, sin escanear:

```powershell
node send-daily-email.mjs
```

## 5. Programarlo

```powershell
powershell -ExecutionPolicy Bypass -File setup-scheduler.ps1
```

Registra dos tareas diarias: **11:47** y **20:00**. Comprobar o quitar:

```powershell
Get-ScheduledTask | Where-Object { $_.TaskName -like "career-ops-scan-*" }
Unregister-ScheduledTask -TaskName "career-ops-scan-11h" -Confirm:$false
```

## Qué hace cada ejecución

`daily-consolidated.mjs` encadena:

1. **LinkedIn Alerts Parser** — extrae ofertas de las alertas de LinkedIn del correo
2. **daily-ats-scan.mjs** (`--no-email`) — 18 empresas Web3/gaming por API de ATS,
   con las keywords ya afinadas a tu perfil dentro del propio script
3. **scan.mjs** — providers + los 9 job boards de `portals.yml`
4. **Verificación de liveness** — vuelve a golpear cada ATS para descartar las cerradas
5. **Un solo correo** con todo lo nuevo del día

Escribe en `data/scan-history.tsv` y `data/pipeline.md`. El deduplicado va contra
ambos, más `applications.md`.

`INCLUDE_L3=true` en el `.bat` añade un barrido por WebSearch con `claude` en
headless. **Gasta tokens cada día** — quita esa línea si no lo quieres.

## Interfaz web

```powershell
cd web
npm install
npm run dev
```

En http://localhost:3000.

## Cosas que conviene saber

**Commitear los datos.** `data/pipeline.md` y `scan-history.tsv` sí están en git.
Haz push de vez en cuando para no perder el historial si se rompe la máquina.

**Los 4 archivos de configuración no están en git.** Si reinstalas, se pierden.
Guarda el `.tar.gz` en sitio seguro.

**El repo es público y es un fork.** `data/pipeline.md` — tu historial de
búsqueda — es visible para cualquiera. Se arregla en Settings → Change
visibility → Private.

**GitHub Actions queda como respaldo manual.** Sin `schedule` ni trigger de
`push`, así que no compite con el runner local ni duplica correos. Para usarlo
haría falta crear los secrets `RESEND_API_KEY` y `PORTALS_YML`.

**Queda una Routine de Claude a las 11:47** que escanea por búsqueda web y avisa
por el correo de notificación de Claude. Con el runner local en marcha sobra:
bórrala en claude.ai → Routines para no recibir dos avisos.
