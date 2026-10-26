# Algo Levels data server on Windows (your own PC, no VPS) — ThetaData Theta Terminal v3 + options server.
# Run in PowerShell:   irm https://raw.githubusercontent.com/bartikozz/algo-levels/main/server/deploy/setup-windows.ps1 | iex
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$R = Join-Path $env:USERPROFILE 'AlgoLevels'
New-Item -ItemType Directory -Force -Path $R, "$R\theta" | Out-Null
function Find-Java { Get-ChildItem 'C:\Program Files\Eclipse Adoptium', 'C:\Program Files\Java', 'C:\Program Files\Microsoft' -Recurse -Filter java.exe -ErrorAction SilentlyContinue | Where-Object { $_.FullName -match '\\bin\\java.exe$' } | Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName }
function Find-Python { foreach ($p in @("$env:LOCALAPPDATA\Programs\Python\Python312\python.exe", 'C:\Program Files\Python312\python.exe', "$env:LOCALAPPDATA\Programs\Python\Python313\python.exe", 'C:\Program Files\Python313\python.exe')) { if (Test-Path $p) { return $p } } return $null }

Write-Host '== Java 21' -ForegroundColor Cyan
$java = Find-Java
if (-not $java) { winget install -e --id EclipseAdoptium.Temurin.21.JRE --silent --accept-source-agreements --accept-package-agreements | Out-Null; $java = Find-Java }
if (-not $java) { throw 'Java se nepodařilo nainstalovat (winget). Nainstaluj Temurin 21 JRE z adoptium.net a spusť skript znovu.' }
Write-Host "   $java"

Write-Host '== Python 3.12' -ForegroundColor Cyan
$py = Find-Python
if (-not $py) { winget install -e --id Python.Python.3.12 --silent --accept-source-agreements --accept-package-agreements | Out-Null; $py = Find-Python }
if (-not $py) { throw 'Python se nepodařilo nainstalovat (winget). Nainstaluj Python 3.12 z python.org a spusť skript znovu.' }
Write-Host "   $py"

Write-Host '== Cloudflare tunel (telefon)' -ForegroundColor Cyan
if (-not (Get-Command cloudflared -ErrorAction SilentlyContinue) -and -not (Test-Path "${env:ProgramFiles(x86)}\cloudflared\cloudflared.exe")) { winget install -e --id Cloudflare.cloudflared --silent --accept-source-agreements --accept-package-agreements | Out-Null }

Write-Host '== kód serveru' -ForegroundColor Cyan
$zip = Join-Path $env:TEMP 'algo-levels.zip'; $tmp = Join-Path $env:TEMP 'algo-levels-src'
Invoke-WebRequest 'https://github.com/bartikozz/algo-levels/archive/refs/heads/main.zip' -OutFile $zip
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue; Expand-Archive $zip $tmp -Force
$src = Get-ChildItem $tmp | Select-Object -First 1
New-Item -ItemType Directory -Force -Path "$R\server" | Out-Null
Copy-Item "$($src.FullName)\server\*" "$R\server" -Recurse -Force -Exclude '.env'
Copy-Item "$($src.FullName)\server\deploy\tunnel.ps1" "$R\tunnel.ps1" -Force
if (-not (Test-Path "$R\server\.venv")) { & $py -m venv "$R\server\.venv" }
& "$R\server\.venv\Scripts\python.exe" -m pip install -q --upgrade pip
& "$R\server\.venv\Scripts\python.exe" -m pip install -q -r "$R\server\requirements.txt"
if (-not (Test-Path "$R\server\.env")) {
@"
ACCESS_TOKEN=
DEMO=0
OPTIONS_ROOT=QQQ
POLL_SEC=30
THETA_API=v3
THETA_BASE=http://127.0.0.1:25503
THETA_STREAM=1
THETA_STREAM_MODE=contracts
FLOW_MIN_PREM=25000
CORS_ORIGINS=https://bartikozz.github.io
"@ | Set-Content -Encoding ascii "$R\server\.env"
}

# token + Worker address (same token as the Worker / terminal) → used by the server and the tunnel registration
function Set-EnvKey($k, $v) { $f = "$R\server\.env"; $c = Get-Content $f; if ($c -match "^$k=") { $c = $c -replace "^$k=.*", "$k=$v" } else { $c += "$k=$v" }; Set-Content -Encoding ascii $f $c }
$cur = @{}; Get-Content "$R\server\.env" | ForEach-Object { if ($_ -match '^\s*([A-Z_]+)\s*=\s*(.*)$') { $cur[$matches[1]] = $matches[2].Trim() } }
if (-not $cur['WORKER_URL']) { Set-EnvKey 'WORKER_URL' (Read-Host '   Adresa tvého Workeru (https://….workers.dev, stejná jako v terminálu ⚙)').Trim().TrimEnd('/') }
if (-not $cur['ACCESS_TOKEN']) { $sec = Read-Host '   Token Workeru (stejný jako v terminálu ⚙)' -AsSecureString; Set-EnvKey 'ACCESS_TOKEN' ([Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))); Remove-Variable sec }

Write-Host '== Theta Terminal v3' -ForegroundColor Cyan
Invoke-WebRequest 'https://download-unstable.thetadata.us/ThetaTerminalv3.jar' -OutFile "$R\theta\ThetaTerminalv3.jar"
if (-not (Test-Path "$R\theta\creds.txt")) {
  Write-Host "   Přihlášení k ThetaData (uloží se jen do tvého počítače: $R\theta\creds.txt)" -ForegroundColor Yellow
  $email = Read-Host '   ThetaData e-mail'
  $sec = Read-Host '   ThetaData heslo' -AsSecureString
  $pw = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
  Set-Content -Encoding ascii "$R\theta\creds.txt" "$email`n$pw"
  Remove-Variable pw, sec
}

Write-Host '== spouštěč' -ForegroundColor Cyan
@"
@echo off
rem stop an old Theta Terminal / server first (ThetaData allows one terminal per account → HTTP 478 otherwise)
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='java.exe'\" | ? CommandLine -match 'ThetaTerminal' | %% { Stop-Process -Id `$_.ProcessId -Force }; Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | ? CommandLine -match 'uvicorn app:app' | %% { Stop-Process -Id `$_.ProcessId -Force }; Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | ? { `$_.CommandLine -match 'tunnel\.ps1' -and `$_.ProcessId -ne `$PID } | %% { Stop-Process -Id `$_.ProcessId -Force }"
timeout /t 2 /nobreak >nul
cd /d "$R\theta"
start "Theta Terminal" /min "$java" -Xmx2g -jar ThetaTerminalv3.jar
timeout /t 15 /nobreak >nul
cd /d "$R\server"
start "Algo server" /min "$R\server\.venv\Scripts\python.exe" -m uvicorn app:app --host 127.0.0.1 --port 8090
timeout /t 5 /nobreak >nul
start "Algo tunel" /min powershell -NoProfile -ExecutionPolicy Bypass -File "$R\tunnel.ps1"
"@ | Set-Content -Encoding ascii "$R\start-algo.cmd"
$lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Algo server.lnk'
$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut($lnk); $s.TargetPath = "$R\start-algo.cmd"; $s.WorkingDirectory = $R; $s.Save()
$st = Join-Path ([Environment]::GetFolderPath('Startup')) 'Algo server.lnk'; $s2 = $ws.CreateShortcut($st); $s2.TargetPath = "$R\start-algo.cmd"; $s2.WorkingDirectory = $R; $s2.WindowStyle = 7; $s2.Save()

Write-Host '== start' -ForegroundColor Cyan
Start-Process "$R\start-algo.cmd" -WindowStyle Minimized
Write-Host '   čekám 40 s, než se Theta Terminal přihlásí…'; Start-Sleep 40

Write-Host '== sonda ThetaData (výstup pošli do chatu)' -ForegroundColor Cyan
Push-Location "$R\server"; & "$R\server\.venv\Scripts\python.exe" -m providers.thetadata; Pop-Location
Write-Host ''
try { Write-Host (Invoke-WebRequest 'http://127.0.0.1:8090/health' -UseBasicParsing).Content } catch { Write-Host "server: $_" }
Write-Host ''
Write-Host "Hotovo. Server se spouští sám po přihlášení (nebo ikona 'Algo server').  Terminál na PC i telefonu: ⚙ → Data server: auto" -ForegroundColor Green
