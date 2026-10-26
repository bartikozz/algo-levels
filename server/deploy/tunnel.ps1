# Algo Levels — Cloudflare quick tunnel for the data server + registration of its URL in the Worker,
# so the terminal on the phone finds the server automatically (Data server = auto). Runs forever; restarts the tunnel if it dies.
$ErrorActionPreference = 'Continue'
$R = Split-Path -Parent $MyInvocation.MyCommand.Path
$cfg = @{}; Get-Content "$R\server\.env" | ForEach-Object { if ($_ -match '^\s*([A-Z_]+)\s*=\s*(.*)$') { $cfg[$matches[1]] = $matches[2].Trim() } }
$W = ($cfg['WORKER_URL'] -replace '/$', ''); $T = $cfg['ACCESS_TOKEN']
if (-not $W -or -not $T) { Write-Host 'WORKER_URL nebo ACCESS_TOKEN chybí v server\.env – tunel nespouštím.'; exit 1 }
$cf = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
if (-not $cf) { foreach ($p in @("${env:ProgramFiles(x86)}\cloudflared\cloudflared.exe", "$env:ProgramFiles\cloudflared\cloudflared.exe", "$env:LOCALAPPDATA\Microsoft\WinGet\Links\cloudflared.exe")) { if (Test-Path $p) { $cf = $p; break } } }
if (-not $cf) { Write-Host 'cloudflared nenalezen (winget install --id Cloudflare.cloudflared).'; exit 1 }
Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force
while ($true) {
  $log = "$R\tunnel.log"; Remove-Item $log -ErrorAction SilentlyContinue
  $p = Start-Process $cf -ArgumentList 'tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:8090' -RedirectStandardError $log -WindowStyle Hidden -PassThru
  $u = $null
  for ($i = 0; $i -lt 90 -and -not $u; $i++) { Start-Sleep 1; if (Test-Path $log) { $m = Select-String -Path $log -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' | Select-Object -First 1; if ($m) { $u = $m.Matches[0].Value } } }
  if ($u) {
    Write-Host "$(Get-Date -Format HH:mm:ss) tunel: $u"
    $last = Get-Date 0
    while (-not $p.HasExited) {
      if (((Get-Date) - $last).TotalMinutes -ge 10) {   # (re)register every 10 min
        try { Invoke-RestMethod "$W/srv/set?url=$([uri]::EscapeDataString($u))&t=$([uri]::EscapeDataString($T))" | Out-Null; $last = Get-Date; Write-Host "$(Get-Date -Format HH:mm:ss) adresa uložena ve Workeru" }
        catch { Write-Host "$(Get-Date -Format HH:mm:ss) Worker: $($_.Exception.Message)"; $last = (Get-Date).AddMinutes(-9) }
      }
      Start-Sleep 5
    }
    Write-Host "$(Get-Date -Format HH:mm:ss) tunel spadl – restartuji"
  } else { Write-Host 'tunel nevrátil adresu – zkouším znovu'; try { $p.Kill() } catch {} }
  Start-Sleep 5
}
