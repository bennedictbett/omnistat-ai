#!/usr/bin/env bash
# One-time setup of the OmniStat API on a fresh Ubuntu 24.04 (or 22.04) server, with the
# R and maths workers running in network-less Docker containers.
#
# Run as root from a checkout of the repository:
#     sudo bash deploy/vps/setup.sh api.example.com
# Re-running is safe: it updates the code, dependencies, images and unit files.
set -euo pipefail

DOMAIN="${1:-}"
APP_USER=omnistat
APP_DIR=/opt/omnistat
STATE_DIR=/var/lib/omnistat
ENV_FILE=/etc/omnistat/omnistat.env
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if [[ $EUID -ne 0 ]]; then echo "Run as root (sudo)."; exit 1; fi
if [[ -z "$DOMAIN" ]]; then echo "Usage: sudo bash deploy/vps/setup.sh <api-domain>"; exit 1; fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates curl rsync ufw python3 python3-venv python3-pip docker.io \
  debian-keyring debian-archive-keyring apt-transport-https gpg

# Caddy provides automatic HTTPS (official apt repository).
if ! command -v caddy >/dev/null; then
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get install -y caddy
fi
systemctl enable --now docker

# Unprivileged service account. Docker group membership is effectively root on this
# host, so keep this machine dedicated to OmniStat (see README, "Deploying on a VPS").
id "$APP_USER" >/dev/null 2>&1 || useradd --system --home-dir "$STATE_DIR" --shell /usr/sbin/nologin "$APP_USER"
usermod -aG docker "$APP_USER"
install -d -o "$APP_USER" -g "$APP_USER" -m 0755 "$STATE_DIR" "$STATE_DIR/tmp"

# Code and Python environment.
install -d -m 0755 "$APP_DIR"
rsync -a --delete --exclude '.git' --exclude '.venv' --exclude 'node_modules' \
  --exclude 'frontend' --exclude '__pycache__' "$SRC_DIR/" "$APP_DIR/"
python3 -m venv "$APP_DIR/.venv"
"$APP_DIR/.venv/bin/pip" install --upgrade pip
"$APP_DIR/.venv/bin/pip" install -r "$APP_DIR/requirements.txt"
chown -R root:root "$APP_DIR"

# Worker images (R and SymPy live only inside these).
docker build -f "$APP_DIR/Dockerfile.rworker" -t omnistat-r-worker "$APP_DIR"
docker build -f "$APP_DIR/Dockerfile.mathworker" -t omnistat-math-worker "$APP_DIR"

# Configuration: created once, never overwritten.
install -d -m 0750 -o root -g "$APP_USER" "$(dirname "$ENV_FILE")"
if [[ ! -f "$ENV_FILE" ]]; then
  install -m 0640 -o root -g "$APP_USER" "$APP_DIR/deploy/vps/env.example" "$ENV_FILE"
  sed -i "s|^OMNISTAT_API_KEYS=.*|OMNISTAT_API_KEYS=$(head -c 32 /dev/urandom | base64 | tr -d '/+=\n')|" "$ENV_FILE"
  echo "Created $ENV_FILE with a generated API key. Add GROQ_API_KEY etc. before starting."
fi

install -m 0644 "$APP_DIR/deploy/vps/omnistat-api.service" /etc/systemd/system/omnistat-api.service
sed "s|api.example.com|$DOMAIN|g" "$APP_DIR/deploy/vps/Caddyfile" > /etc/caddy/Caddyfile
systemctl daemon-reload
systemctl enable omnistat-api
systemctl restart omnistat-api
systemctl reload caddy || systemctl restart caddy

# Only SSH and web traffic are reachable from outside; the API listens on localhost.
ufw allow OpenSSH >/dev/null
ufw allow 80,443/tcp >/dev/null
ufw --force enable >/dev/null

echo
echo "Done. Next:"
echo "  1. Point DNS for $DOMAIN at this server's IP (A record)."
echo "  2. Edit $ENV_FILE, then: sudo systemctl restart omnistat-api"
echo "  3. Verify: sudo bash $APP_DIR/deploy/vps/smoke-test.sh $DOMAIN"
