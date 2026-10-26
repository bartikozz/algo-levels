# Algo Levels — Cloudflare quick tunnel for the data server. Writes the tunnel address to tunnel.url;
# the server publishes it in the Worker so phones find it (Data server = auto). Runs forever, restarts the tunnel if it dies.
$ErrorActionPreference = 'Continue'
$R = Split-Path -Parent $MyInvocation.MyCommand.Path
$cf = if (Test-Path "$R\cloudflared.exe") { "$R\cloudflared.exe" } else { (Get-Command cloudflared -ErrorAction SilentlyContinue).Source }
if (-not $cf) { foreach ($p in @("${env:ProgramFiles(x86)}\cloudflared\cloudflared.exe", "$env:ProgramFiles\cloudflared\cloudflared.exe", "$env:LOCALAPPDATA\Microsoft\WinGet\Links\cloudflared.exe")) { if (Test-Path $p) { $cf = $p; break } } }
if (-not $cf) { Write-Host 'cloudflared nenalezen (winget install --id Cloudflare.cloudflared).'; Start-Sleep 600; exit 1 }
Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force
while ($true) {
  $log = "$R\tunnel.log"; Remove-Item $log, "$R\tunnel.url" -ErrorAction SilentlyContinue
  $p = Start-Process $cf -ArgumentList 'tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:8090' -RedirectStandardError $log -WindowStyle Hidden -PassThru
  $u = $null
  for ($i = 0; $i -lt 90 -and -not $u; $i++) { Start-Sleep 1; if (Test-Path $log) { $m = Select-String -Path $log -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' | Select-Object -First 1; if ($m) { $u = $m.Matches[0].Value } } }
  if ($u) {
    Set-Content -Encoding ascii "$R\tunnel.url" $u
    Write-Host "$(Get-Date -Format HH:mm:ss) tunel: $u  (server ho zapíše do Workeru)"
    $p.WaitForExit()
    Write-Host "$(Get-Date -Format HH:mm:ss) tunel spadl – restartuji"
  } else { Write-Host 'tunel nevrátil adresu – zkouším znovu'; try { $p.Kill() } catch {} }
  Start-Sleep 5
}
