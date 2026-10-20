' Starts ops-api with no console window. Copy this file into the Startup
' folder (shell:startup) to start it at every logon. A second copy started
' while one is already running exits at once (port 8443 in use).
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "C:\Claude\career-ops"
sh.Run """C:\Program Files\nodejs\node.exe"" ""C:\Claude\career-ops\ops-api\server.mjs""", 0, False
