' career-ops: ejecuta el sync de output\ sin ventana (la tarea
' career-ops-output-sync corre cada 30 min en el DESKTOP y un flash de
' consola a ese ritmo molesta). Fork-local; solo se programa en el desktop.
CreateObject("Wscript.Shell").Run "powershell -NoProfile -ExecutionPolicy Bypass -File C:\Claude\career-ops\sync-output-from-cajita.ps1", 0, False
