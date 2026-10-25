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
ExecStart=/usr/bin/java -Xmx2g -jar $THETA/ThetaTerminal.jar \$THETA_ARGS
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
[ -f "$THETA/ThetaTerminal.jar" ] && systemctl enable --now theta-terminal || true

cat <<DONE

✔ Hotovo. Server: https://$HOST
Zbývá:
 1) nano $APP/server/.env        → ACCESS_TOKEN, DATABENTO_API_KEY   (pak: systemctl restart algo-server)
 2) Theta Terminal: stáhni ThetaTerminal jar z ThetaData dashboardu do $THETA/ThetaTerminal.jar
    a přihlašovací údaje dej do $THETA/creds.txt (1. řádek e-mail, 2. řádek heslo; chmod 600),
    pak: systemctl enable --now theta-terminal
 3) test:  curl https://$HOST/health
    sonda ThetaData:  cd $APP/server && .venv/bin/python -m providers.thetadata
 4) v terminálu ⚙ → Data server: https://$HOST
DONE
