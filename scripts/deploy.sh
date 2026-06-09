#!/usr/bin/env bash
# Deploy Support AI Agent on Ubuntu 24.04 (bash).
set -euo pipefail

APP_USER="${APP_USER:-www-data}"
APP_DIR="${APP_DIR:-/opt/support-ai-agent}"
SERVICE_NAME="${SERVICE_NAME:-support-ai-agent}"
PYTHON_BIN="${PYTHON_BIN:-python3}"
VENV_DIR="${VENV_DIR:-$APP_DIR/.venv}"
REPO_URL="${REPO_URL:-}"
HERMES_INSTALL_URL="${HERMES_INSTALL_URL:-}"

export DEBIAN_FRONTEND=noninteractive

echo "==> apt update & upgrade"
sudo apt-get update -y
sudo apt-get upgrade -y
sudo apt-get install -y \
  "$PYTHON_BIN" "$PYTHON_BIN"-venv "$PYTHON_BIN"-dev \
  build-essential git curl ca-certificates rsync

echo "==> app directory: $APP_DIR"
sudo mkdir -p "$APP_DIR"
sudo chown -R "$APP_USER:$APP_USER" "$APP_DIR" || true

if [[ -n "$REPO_URL" ]]; then
  echo "==> clone $REPO_URL"
  sudo -u "$APP_USER" git clone "$REPO_URL" "$APP_DIR/repo-tmp" || true
  sudo -u "$APP_USER" rsync -a "$APP_DIR/repo-tmp/" "$APP_DIR/" || sudo -u "$APP_USER" cp -a "$APP_DIR/repo-tmp/." "$APP_DIR/"
  sudo rm -rf "$APP_DIR/repo-tmp"
else
  echo "==> REPO_URL empty — copy project files to $APP_DIR (e.g. rsync from CI) before running."
fi

cd "$APP_DIR"

if [[ ! -f requirements.txt ]]; then
  echo "requirements.txt not found in $APP_DIR — abort." >&2
  exit 1
fi

echo "==> venv + pip"
sudo -u "$APP_USER" "$PYTHON_BIN" -m venv "$VENV_DIR"
sudo -u "$APP_USER" "$VENV_DIR/bin/pip" install --upgrade pip
sudo -u "$APP_USER" "$VENV_DIR/bin/pip" install -r requirements.txt

# --- Secrets: `.env` must never be committed. The operator is responsible for creating a real `.env`
# (API tokens, passwords). `.env.example` is only a template; copying it does not secure the deployment.
if [[ ! -f .env ]]; then
  if [[ -f .env.example ]]; then
    echo "==> seed $APP_DIR/.env from .env.example — YOU MUST EDIT all secrets before relying on this install"
    sudo -u "$APP_USER" cp .env.example .env
  else
    echo "No .env.example in $APP_DIR — create .env manually with all required variables." >&2
  fi
  echo "Required: fill $APP_DIR/.env, then: sudo systemctl restart $SERVICE_NAME" >&2
fi

if [[ -n "$HERMES_INSTALL_URL" ]]; then
  echo "==> Hermes install script from HERMES_INSTALL_URL"
  curl -fsSL "$HERMES_INSTALL_URL" | sudo -u "$APP_USER" bash
else
  echo "==> skip Hermes (set HERMES_INSTALL_URL to enable, e.g. export HERMES_INSTALL_URL=https://example.com/install-hermes.sh)"
fi

echo "==> systemd unit: $SERVICE_NAME"
sudo tee "/etc/systemd/system/${SERVICE_NAME}.service" >/dev/null <<EOF
[Unit]
Description=Support AI Agent (FastAPI + Telegram)
After=network.target

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=-$APP_DIR/.env
ExecStart=$VENV_DIR/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000 --proxy-headers
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME"
sudo systemctl restart "$SERVICE_NAME"
sudo systemctl --no-pager status "$SERVICE_NAME" || true

echo "==> done. Logs: journalctl -u $SERVICE_NAME -f"
