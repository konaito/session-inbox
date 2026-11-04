#!/bin/bash
# ハブ（Worker）を Void でデプロイする。
# 画面は ../index.html と ../public/ が原本なので、hub/public/ に写してから出す。
# 自分の環境の値は hub/deploy.json に書く（雛形は hub/deploy.example.json）。
# Void はデプロイ後にハブのドメイン経由で動作確認をするので、Access を通る確認用のサービストークンを渡す。
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
F="$HOME/.config/session-inbox/deploy-token.json"
test -s "$F"
test -s "$ROOT/hub/deploy.json"
DOMAIN=$(/usr/bin/python3 -c "import json;print(json.load(open('$ROOT/hub/deploy.json'))['domain'])")
cp "$ROOT/index.html" "$ROOT/hub/public/index.html"
cp "$ROOT"/public/* "$ROOT/hub/public/"
cd "$ROOT/hub"
export CF_ACCESS_READINESS_ORIGIN="https://$DOMAIN"
export CF_ACCESS_CLIENT_ID=$(/usr/bin/python3 -c "import json;print(json.load(open('$F'))['client_id'])")
export CF_ACCESS_CLIENT_SECRET=$(/usr/bin/python3 -c "import json;print(json.load(open('$F'))['client_secret'])")
bunx void@1.4.0 deploy --platform cloudflare </dev/null
