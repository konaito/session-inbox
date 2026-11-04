# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 何のリポジトリか

起動中の Claude Code セッションを一覧し、会話を読み、外から文を送って割り込むためのツール。ハブは自分の Cloudflare アカウントの Worker で、Access でログインした本人と、許可したサービストークンを持つ親セッションだけが使える。

- ノード `server.ts`（Mac ごとに1つ、Bun）は、そのマシンのセッションを読み書きする。transcript の解析は `lib/transcript.ts` にある。
- 親用 CLI `cli/inbox.ts` は、別の Claude Code セッション（親）がハブ経由で子セッションの状況を読み、文を送り、返事を読むためのもの。使い方は `skills/session-inbox/SKILL.md`。
- ハブ `hub/`（Void で動く Cloudflare Worker）は、各ノードに問い合わせて1つの画面にまとめる。自分の環境の値は `hub/deploy.json`（git に入れない。雛形は `hub/deploy.example.json`）。
- 画面は `index.html` 1枚と `public/`（PWA 用）で、ノードがそのまま配り、ハブには写しを置く。

`game-ai/` が同じディレクトリにあっても無関係な別リポジトリで、.gitignore で除外している。触らない。

## コマンド

リントは無い。テストは `bun test` で、ノードの transcript 解析（`lib/`）、親用 CLI（`cli/`）、ハブの認証（`hub/lib/`）にある。

```bash
# テスト
bun test lib/ cli/
cd hub && bun test lib/

# ノードを手元で動かす（4321 と 4322 は LaunchAgent が使っているので別ポートにする）
MACHINE_NAME=<このマシン名> PORT=4399 bun run server.ts

# server.ts と CLI の構文チェック
bun build --target=bun server.ts --outfile /dev/null
bun build --target=bun cli/inbox.ts --outfile /dev/null

# 親用 CLI（~/.local/bin/inbox が cli/inbox.ts を呼ぶ。試験は手元のノードに向ける）
inbox --hub http://127.0.0.1:4399 list

# ハブ
cd hub && bun install
cd hub && bun run dev      # vite。API を通すには hub/.env に DEV_NO_AUTH=1 を書く（localhost のときだけ効く）
cd hub && bun run build    # vite build

# ハブのデプロイ。bun run deploy ではなくこのスクリプトを使う
scripts/deploy-hub.sh

# 別の Mac をノードにする
scripts/deploy-node.sh <ssh名> <マシン名> <ノードのホスト名> <トンネルID>

# server.ts を直したあと、この Mac のノードを再起動する（Label は自分の plist に合わせる）
launchctl kickstart -k gui/$(id -u)/com.session-inbox
tail -f ~/Library/Logs/session-inbox.log ~/Library/Logs/session-inbox.err.log
```

`scripts/deploy-hub.sh` は、ルートの `index.html` と `public/` を `hub/public/` に写してから `void deploy` を呼ぶ。Void はデプロイ後にハブのドメイン経由で動作確認をするが、そこは Access の裏なので、確認用のサービストークン（`~/.config/session-inbox/deploy-token.json`）を環境変数で渡している。素の `void deploy` はここで止まる。

LaunchAgent は、このディレクトリの `server.ts` を直接実行している（plist の WorkingDirectory と ProgramArguments）。つまり `server.ts` を直して再起動すると、本番のノードがそのまま変わる。

## 構成

### ノード（server.ts）が開く2つの口

| ポート | 役割 | 認証 |
|---|---|---|
| 4321（`PORT`） | 画面と API。127.0.0.1 だけで待ち受ける | 無し。`PUBLIC_HOST` を入れたときだけ Access の JWT を要求する（古い直接公開モードで、今の plist では使っていない） |
| 4322（`NODE_PORT`） | ハブから呼ばれる API。cloudflared のトンネルでノードのホスト名として出る | Host が `NODE_HOST` と一致し、Access のサービストークン由来の JWT（`NODE_ACCESS_AUD`、`NODE_SERVICE_CLIENT_ID`）と、`x-node-token`（`NODE_TOKEN_FILE` の中身）の両方が通ること |

ハブからの通信は 4322 にしか来ない。

### ノードが読む Claude Code の内部

どれも公式ドキュメントに無い。Claude Code の更新で壊れたら、まずここを疑う。

- セッション一覧は `claude agents --json`（pid、sessionId、cwd、status）。2秒キャッシュする。
- 会話は `~/.claude/projects/*/<sessionId>.jsonl`。cwd からスラッグを作ると `/cd` や resume でずれるので、全プロジェクトのディレクトリを探す。
- 割り込みは受信ソケット `/tmp/cc-socks/<pid>.sock` に `{"type":"user","message":{"role":"user","content":"..."}}` を1行書く。pid は respawn で変わるので、送る直前に取り直す。
- bypass モードのセッションは `~/.claude/settings.json` に `"crossSessionInbound": "accept"` が無いと受け取らない。
- transcript の1行を画面用の項目に変えるのは `toItems()`。届いた割り込みは Claude Code 側が固定の文（Another Claude session sent a message）で包むので、`PEER_RE` で中身を取り出す。transcript の形式が変わったら、ここを直す。

### ファイルをまたぐ約束

- 会話 API はバイトオフセットで動く。`offset` で末尾を追い、`before` でさかのぼる。`readBack()` はツール以外の発言が16件たまるまで読む幅を倍にする。`index.html` はこの2つで 1.5 秒ごとにポーリングする。
- `send` の 202 は「ソケットに書いた」まで。届いたかは transcript に出るかで見る。画面は送信中、待ち、届いた、の順に表示を変える。
- 送り主の行。ノードは本文の1行目に `from <メール> via <ハブのホスト名>`、`from agent:<名前> via <ハブのホスト名>`（親エージェント）、`via localhost` のどれかを付け、表示するときは `injected()` でその行を外す。ハブのホスト名はハブが `via` で渡す。ハブは Access で確かめたメール、またはサービストークンの親なら `agent:<名前>` を `from` として渡し、ノードは `isValidWebFrom()` に合わない web 送信を 400 で断る。この行は同じ Mac の他のプロセスにも書けるので、本人の証明にはならない。
- ハブの認証は2経路。JWT に `email` があれば本人（`ACCESS_EMAILS`）、無ければサービストークン（`common_name` が `PARENT_CLIENT_IDS` にあるもの）。どちらも署名、aud、iss、期限は `verifyToken` で共通に確かめる。
- 子の状況は `GET /api/sessions/<id>/summary`。transcript の窓（会話 API と同じ幅）から permission-mode、gitBranch、pr-link、away_summary、queue-operation（保留中の割り込み）を抜く。`send` の 202 に `offset` が入り、CLI はそこから返事を読む。
- ハブの API はクエリ `m` でマシンを選ぶ（`NODES` の name）。ノードは `m` を見ない。
- CSRF 対策は `server.ts` の `guard()` と `hub/middleware/01-guard.ts` に同じものがある。Origin、Sec-Fetch-Site、POST の `x-cc-inject: 1` を見る。Access の JWT 検証も `server.ts` の `verifyAccess()` と `hub/lib/access.ts` に同じものがある。直すときは両方直す。
- `hub/public/` は `scripts/deploy-hub.sh` が作る写しなので、画面を直すときはルートの `index.html` と `public/` を直す。
- `public/sw.js` はページ本体だけキャッシュし、`/api/` はキャッシュしない。

### 環境変数

ノード（`launchd/session-inbox.plist.example` に書いてある）

| 変数 | 意味 |
|---|---|
| `PORT` | 画面と API のポート。既定 4321 |
| `MACHINE_NAME` | 一覧に出るマシン名。既定はホスト名 |
| `ACCESS_TEAM_DOMAIN` | Cloudflare Access のチームドメイン |
| `NODE_PORT`、`NODE_HOST`、`NODE_ACCESS_AUD`、`NODE_SERVICE_CLIENT_ID`、`NODE_TOKEN_FILE` | ノード API。`NODE_PORT` を入れたら残りも必須で、合言葉は32文字以上 |
| `PUBLIC_HOST`、`ACCESS_AUD`、`ACCESS_EMAILS` | 4321 を直接公開するときだけ。今は使っていない |

ハブ。`NODES`、`ACCESS_TEAM_DOMAIN`、`ACCESS_AUD`、`ACCESS_EMAILS`、`PARENT_CLIENT_IDS` は `hub/deploy.json` に書き、`hub/void.config.ts` が読む。`CF_ACCESS_CLIENT_ID`、`CF_ACCESS_CLIENT_SECRET`、`NODE_TOKEN` は秘密なので `wrangler secret put` で入れる（`void secret` は void.cloud のログインを求めて使えない）。手元の vite dev では同じ名前を `hub/.env` に書く。

### リポジトリの外にある状態

- `~/.cloudflared/session-inbox.yml`。トンネルの設定で、ノードのホスト名を 127.0.0.1:4322 に流す。
- `~/.config/session-inbox/peer-token`（ノードの合言葉）、`service-token.json`（ハブがノードに使うサービストークン）、`deploy-token.json`（デプロイの動作確認用）。
- `~/Library/LaunchAgents/<Label>.plist`。`launchd/*.plist.example` を自分の値で埋めたもの。
- Cloudflare Access のアプリ2つ。ハブのドメイン用（本人のメールと、親用サービストークンを許可）と、ノード用（ハブのサービストークンだけ許可）。
- `~/.config/session-inbox/config.json`（CLI のハブ URL と既定のマシン）、`parent-token.json`（親用サービストークン）、`deploy.env`（deploy-node.sh の Access の値）、`sends.json`（CLI が送った文と offset）。`~/.local/bin/inbox` と `~/.agents/skills/session-inbox` のリンク。
- `~/.claude/settings.json` の `crossSessionInbound`。
