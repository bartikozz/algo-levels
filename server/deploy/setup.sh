#!/usr/bin/env bash
# Algo Levels data server — one-shot setup for a fresh Ubuntu 24.04 VPS (run as root).
#   curl -fsSL https://raw.githubusercontent.com/bartikozz/algo-levels/main/server/deploy/setup.sh | bash
set -euo pipefail
APP=/opt/algo-levels; THETA=/opt/theta
IP=$(curl -fsS https://api.ipify.org || hostname -I | awk '{print $1}')
HOST="${HOST:-$(echo "$IP" | tr . -).sslip.io}"

echo "== packages"
apt-get update -y
apt-get install -y git curl python3-venv openjdk-21-jre-headless debian-keyring debian-archive-keyring apt-transport-https ufw
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y && apt-get install -y caddy
fi

echo "== code"
id -u algo >/dev/null 2>&1 || useradd -r -m -d /home/algo -s /usr/sbin/nologin algo
if [ -d "$APP/.git" ]; then git -C "$APP" pull --ff-only; else git clone https://github.com/bartikozz/algo-levels "$APP"; fi
python3 -m venv "$APP/server/.venv"
"$APP/server/.venv/bin/pip" install -q -r "$APP/server/requirements.txt"
[ -f "$APP/server/.env" ] || { cp "$APP/server/.env.example" "$APP/server/.env"; chmod 600 "$APP/server/.env"; }
mkdir -p "$APP/server/data" "$THETA"
chown -R algo:algo "$APP/server/data" "$THETA"
chown algo:algo "$APP/server/.env"

echo "== services"
cat > /etc/systemd/system/theta-terminal.service <<UNIT
[Unit]
Description=ThetaData Theta Terminal
After=network-online.target
[Service]
User=algo
WorkingDirectory=$THETA
EnvironmentFile=-$THETA/theta.env
ExecStart=/usr/bin/java -Xmx2g -jar $THETA/ThetaTerminalv3.jar
Restart=always
RestartSec=10
[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/systemd/system/algo-server.service <<UNIT
[Unit]
Description=Algo Levels data server
After=network-online.target theta-terminal.service
[Service]
User=algo
WorkingDirectory=$APP/server
ExecStart=$APP/server/.venv/bin/uvicorn app:app --host 127.0.0.1 --port 8090
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/caddy/Caddyfile <<CADDY
$HOST {
  reverse_proxy 127.0.0.1:8090
}
CADDY
ufw allow OpenSSH; ufw allow 80/tcp; ufw allow 443/tcp; ufw --force enable
systemctl daemon-reload
systemctl enable --now algo-server caddy
systemctl restart caddy
echo "== Theta Terminal v3"
curl -fsSL -o "$THETA/ThetaTerminalv3.jar" https://download-unstable.thetadata.us/ThetaTerminalv3.jar || echo "!! jar se nepodařilo stáhnout – stáhni ho z ThetaData webu do $THETA/ThetaTerminalv3.jar"
chown algo:algo "$THETA"/*.jar 2>/dev/null || true
systemctl enable theta-terminal
[ -s "$THETA/creds.txt" ] && systemctl restart theta-terminal || true

cat <<DONE

✔ Hotovo. Server: https://$HOST
Zbývá:
 1) nano $THETA/creds.txt         → 1. řádek e-mail ThetaData, 2. řádek heslo
    chown algo:algo $THETA/creds.txt && chmod 600 $THETA/creds.txt && systemctl restart theta-terminal
 2) nano $APP/server/.env        → ACCESS_TOKEN (nový, vymysli si ho)   pak: systemctl restart algo-server
 3) test:  curl https://$HOST/health
    sonda ThetaData:  cd $APP/server && .venv/bin/python -m providers.thetadata
 4) v terminálu ⚙ → Data server: https://$HOST
DONE
