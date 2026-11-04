#!/bin/bash
# 別の Mac をノードとして公開する。サーバーと cloudflared を launchd で常駐させ、ハブ（Worker）から呼べるようにする。
# 使い方: scripts/deploy-node.sh <ssh名> <マシン名> <ノードのホスト名> <トンネルID>
# 例:     scripts/deploy-node.sh mac-b mac-b node-b.example.com <cloudflared tunnel id>
# トンネルはこの Mac で `cloudflared tunnel create` して作り、認証情報のファイルをこのスクリプトで送る。
# Access の値は ~/.config/session-inbox/deploy.env（NODE_ACCESS_AUD、ACCESS_TEAM_DOMAIN、任意で LAUNCHD_LABEL）か環境変数から取る。
set -euo pipefail
HOST_SSH=$1
NAME=$2
NODE_HOST=$3
TUNNEL_ID=$4
SRC=$(cd "$(dirname "$0")/.." && pwd)
CONF="$HOME/.config/session-inbox"
[ -f "$CONF/deploy.env" ] && . "$CONF/deploy.env"
: "${NODE_ACCESS_AUD:?NODE_ACCESS_AUD が無い。$CONF/deploy.env に書く}"
: "${ACCESS_TEAM_DOMAIN:?ACCESS_TEAM_DOMAIN が無い。$CONF/deploy.env に書く}"
LABEL=${LAUNCHD_LABEL:-com.session-inbox}

TOKEN_FILE="$CONF/peer-token"
CREDS="$HOME/.cloudflared/$TUNNEL_ID.json"
test -s "$TOKEN_FILE"
test -s "$CREDS"
CLIENT_ID=$(/usr/bin/python3 -c "import json;print(json.load(open('$CONF/service-token.json'))['client_id'])")
test -n "$CLIENT_ID"

ssh "$HOST_SSH" 'mkdir -p ~/session-inbox/public ~/.config/session-inbox ~/.cloudflared && chmod 700 ~/.config/session-inbox ~/.cloudflared'
scp -q "$SRC/server.ts" "$SRC/index.html" "$HOST_SSH":session-inbox/
ssh "$HOST_SSH" 'mkdir -p ~/session-inbox/lib'
for f in "$SRC"/lib/*.ts; do case "$f" in *.test.ts) ;; *) scp -q "$f" "$HOST_SSH":session-inbox/lib/ ;; esac; done
scp -q "$SRC"/public/* "$HOST_SSH":session-inbox/public/
scp -q "$TOKEN_FILE" "$HOST_SSH":.config/session-inbox/peer-token
scp -q "$CREDS" "$HOST_SSH":.cloudflared/"$TUNNEL_ID".json

ssh "$HOST_SSH" "NAME='$NAME' NODE_HOST='$NODE_HOST' TUNNEL_ID='$TUNNEL_ID' CLIENT_ID='$CLIENT_ID' NODE_ACCESS_AUD='$NODE_ACCESS_AUD' ACCESS_TEAM_DOMAIN='$ACCESS_TEAM_DOMAIN' LABEL='$LABEL' bash -s" <<'REMOTE'
set -euo pipefail
chmod 600 ~/.config/session-inbox/peer-token ~/.cloudflared/"$TUNNEL_ID".json
U=gui/$(id -u)

cat > ~/.cloudflared/session-inbox.yml <<EOF
tunnel: $TUNNEL_ID
credentials-file: $HOME/.cloudflared/$TUNNEL_ID.json
ingress:
  - hostname: $NODE_HOST
    service: http://127.0.0.1:4322
  - service: http_status:404
EOF
/opt/homebrew/bin/cloudflared tunnel --config ~/.cloudflared/session-inbox.yml ingress validate >/dev/null

SERVER=~/Library/LaunchAgents/$LABEL.plist
cat > "$SERVER" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>WorkingDirectory</key><string>$HOME/session-inbox</string>
  <key>ProgramArguments</key>
  <array><string>$HOME/.bun/bin/bun</string><string>run</string><string>$HOME/session-inbox/server.ts</string></array>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/session-inbox.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/session-inbox.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>$HOME</string>
    <key>PATH</key><string>$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>MACHINE_NAME</key><string>$NAME</string>
    <key>ACCESS_TEAM_DOMAIN</key><string>$ACCESS_TEAM_DOMAIN</string>
    <key>NODE_PORT</key><string>4322</string>
    <key>NODE_HOST</key><string>$NODE_HOST</string>
    <key>NODE_ACCESS_AUD</key><string>$NODE_ACCESS_AUD</string>
    <key>NODE_SERVICE_CLIENT_ID</key><string>$CLIENT_ID</string>
    <key>NODE_TOKEN_FILE</key><string>$HOME/.config/session-inbox/peer-token</string>
  </dict>
</dict>
</plist>
EOF

TUNNEL=~/Library/LaunchAgents/$LABEL-tunnel.plist
cat > "$TUNNEL" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL-tunnel</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProgramArguments</key>
  <array><string>/opt/homebrew/bin/cloudflared</string><string>tunnel</string><string>--config</string><string>$HOME/.cloudflared/session-inbox.yml</string><string>--no-autoupdate</string><string>run</string></array>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/session-inbox-tunnel.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/session-inbox-tunnel.err.log</string>
  <key>EnvironmentVariables</key><dict><key>HOME</key><string>$HOME</string></dict>
</dict>
</plist>
EOF
plutil -lint "$SERVER" "$TUNNEL" >/dev/null

# crossSessionInbound を accept にする。読み出しが空でないことを確かめ、最初の1回だけ原本を残す
S=~/.claude/settings.json
test -s "$S"
[ -e "$S.bak-session-inbox" ] || cp "$S" "$S.bak-session-inbox"
/usr/bin/python3 - "$S" <<'PY'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
d["crossSessionInbound"] = "accept"
open(p, "w").write(json.dumps(d, ensure_ascii=False, indent=2) + "\n")
PY

# bootout 直後の bootstrap は失敗することがあるので、待ってから再試行する
for L in $LABEL $LABEL-tunnel; do
  launchctl bootout $U/$L 2>/dev/null || true
  for i in 1 2 3 4 5 6; do
    sleep 1
    launchctl bootstrap $U ~/Library/LaunchAgents/$L.plist 2>/dev/null && break
    [ $i = 6 ] && { echo "bootstrap failed: $L" >&2; exit 1; }
  done
done
REMOTE
echo "deployed $NAME to $HOST_SSH as $NODE_HOST"
