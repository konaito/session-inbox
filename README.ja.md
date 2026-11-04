# session-inbox

起動中の Claude Code セッションをどこからでも見て割り込み、1つの Claude Code セッションから別のマシンのセッションを動かすためのツール。

- ウェブの画面（PWA）で、全マシンの起動中セッションを一覧し、会話を読み、文を送って割り込む。
- CLI（`inbox`）で、親の Claude Code セッションが別の Mac に子セッションを立て、状況を読み、命令し、返事を読む。
- すべて自分の Cloudflare アカウントで動く。Remote Control も他人の中継も使わない。画面は Cloudflare Access のメール認証、CLI はサービストークンで守る。

English: [README.md](README.md)

## 仕組み

```
スマホ / PC のブラウザ                       親の Claude Code（CLI `inbox`）
        |  Cloudflare Access（メール）                |  Cloudflare Access（サービストークン）
        v                                             v
ハブ（Cloudflare Worker、hub/） ──────────────────────┘
        |  サービストークン + 合言葉
        ├── node-a.example.com ── cloudflared ──> 127.0.0.1:4322  server.ts（Mac A）
        └── node-b.example.com ── cloudflared ──> 127.0.0.1:4322  server.ts（Mac B）

server.ts が各 Mac で読み書きするもの
    claude agents --json                   セッション一覧
    ~/.claude/projects/*/<sessionId>.jsonl 会話
    /tmp/cc-socks/<pid>.sock               割り込みの受信ソケット
```

- ノード `server.ts`（Mac ごとに1つ、Bun）。127.0.0.1:4321 で画面と API（手元用）、127.0.0.1:4322 でハブ向けの API を出す。ハブ向けは、ハブのサービストークン由来の Access の JWT と合言葉の両方を確かめる。
- ハブ `hub/`（[Void](https://void.cloud) で書いた Cloudflare Worker）。Access の JWT（本人ならメール、親セッションならサービストークンの `common_name`）を確かめて、セッションのあるノードに中継する。
- 画面 `index.html` と `public/`。1枚のファイルで、フレームワークは使わない。ノードが配り、`scripts/deploy-hub.sh` がハブに写す。
- CLI `cli/inbox.ts`。`list`、`show`、`send`、`read`、`run`、`wait`、`spawn`、`stop`。`skills/session-inbox/` の Claude Code スキルが、親セッションにいつどう使うかを教える。

外から送った文は、セッションに「別のセッションからのメッセージ」として届き、1行目に `from <メール> via <ハブのホスト名>`（本人）か `from agent:<名前> via <ハブのホスト名>`（親セッション）が付く。Claude Code はそれを別セッションからの依頼として扱う。権限プロンプトの承認、設定の変更、スラッシュコマンドには使えない。

## 前提

- macOS、[Bun](https://bun.sh)、`cloudflared`、Claude Code。動作確認は Claude Code 2.1.316。Claude Code の公開されていない内部（`claude agents --json`、transcript の形式、受信ソケット）に依存しているので、Claude Code の更新で壊れることがある。
- Cloudflare のアカウントと自分のゾーン、Zero Trust（Access）。
- 各セッションが別セッションからの文を受け取る設定。`~/.claude/settings.json` に `"crossSessionInbound": "accept"`。

## セットアップ

### 1. Cloudflare

1. Access アプリを2つ作る。ハブのドメイン用（自分のメールと、下の parent トークンを許可）と、ノードのホスト名用（ハブのサービストークンだけ許可）。
2. サービストークンを3つ作る。`hub`（ハブがノードを呼ぶ）、`parent`（CLI がハブを呼ぶ）、`deploy`（Void がデプロイ後に Access 越しに動作確認する）。
3. Mac ごとに cloudflared のトンネルを作り、ホスト名を付ける（`cloudflared tunnel create`、`cloudflared tunnel route dns`）。

### 2. ノード（各 Mac）

1. 32文字以上の合言葉を `~/.config/session-inbox/peer-token` に置く。全ノードとハブで同じ値。
2. `~/.cloudflared/session-inbox.yml` で、ノードのホスト名を `http://127.0.0.1:4322` に流す。
3. `launchd/*.plist.example` を `~/Library/LaunchAgents/` に写し、`__PLACEHOLDER__` を埋めて `launchctl bootstrap gui/$(id -u) <plist>` で起動する。
4. 2台目以降は `scripts/deploy-node.sh <ssh名> <マシン名> <ノードのホスト名> <トンネルID>` が 1〜3 を SSH 越しに行う。`NODE_ACCESS_AUD` と `ACCESS_TEAM_DOMAIN` は `~/.config/session-inbox/deploy.env` から読む。

`server.ts` の環境変数は `PORT`、`MACHINE_NAME`、`ACCESS_TEAM_DOMAIN`、`NODE_PORT`、`NODE_HOST`、`NODE_ACCESS_AUD`、`NODE_SERVICE_CLIENT_ID`、`NODE_TOKEN_FILE`。詳しくは `CLAUDE.md`。

### 3. ハブ

1. `hub/deploy.example.json` を `hub/deploy.json` に写して埋める（アカウント ID、ハブのドメイン、Access のチームドメインと aud、許可するメール、parent の client_id、ノードの一覧）。git には入らない。
2. `hub/` で `wrangler secret put` を使い、`CF_ACCESS_CLIENT_ID` と `CF_ACCESS_CLIENT_SECRET`（`hub` トークン）、`NODE_TOKEN`（合言葉）を入れる。
3. `deploy` トークンを `~/.config/session-inbox/deploy-token.json`（`{"client_id","client_secret"}`）に置き、`scripts/deploy-hub.sh` を実行する。初回だけ、先に `wrangler triggers deploy` でカスタムドメインを付ける。付いていないと Void の動作確認が Worker に届かない。

### 4. 親の CLI とスキル

1. `~/.config/session-inbox/config.json` に `{"hub":"https://<ハブのドメイン>","defaultMachine":"<マシン名>"}`。
2. `~/.config/session-inbox/parent-token.json` に `parent` トークン（0600）。
3. PATH の通った場所に皮を置く。例えば `~/.local/bin/inbox` に `exec bun run <リポジトリ>/cli/inbox.ts "$@"`。
4. `skills/session-inbox` を Claude Code のスキルのディレクトリにリンクする。スキルは、独立した作業があれば子を立てて同時に走らせ、命令を送り、返事を待ち、本人に報告する手順を親に教える。

## 使い方

```bash
inbox list                                   # 全マシンのセッション
inbox spawn mac-b ~/Documents/project        # 子を立てる（ssh 越しに tmux で claude --dangerously-skip-permissions）
inbox show mac-b/project-3f                  # ブランチ、PR、権限モード、status、Claude 自身の要約、最後のやり取り、保留中の割り込み
inbox run mac-b/project-3f "..." --as mac-a/lead --wait 600   # 送って返事を待つ
inbox wait mac-b/a-1 mac-b/b-2 --wait 600    # 複数の子を同時に待つ
inbox stop mac-b child-project               # 子の tmux を消す
```

`read`、`run`、`wait` の終了コードは、0 が返事が出そろった、2 が時間切れ、3 が子が本人の入力待ち（権限プロンプトか質問）、4 が送った文が保留のまま。どの場合も最後に `status`、`waitingFor`、`permissionMode`、transcript の `offset` を生のまま出すので、親が自分で判断できる。

## 安全のための注意

- parent のサービストークンは、全ノードの会話を読み、全セッションに送れる。0600 で置く。CLI は設定したハブ以外のホストにはトークンを付けない。
- 送った文の1行目は本人の証明にならない。同じ Mac の他のプロセスも同じ行をソケットに書ける。
- 権限プロンプトで止まっているセッションに送ると、ふつうは保留されてプロンプトが解けてから届くが、観測した3回のうち1回はプロンプトを中断して（ツールを「No」にして）届いた。スキルは `waiting` の子には送らないと決めている。
- `inbox spawn` は子を `--dangerously-skip-permissions` で立てる。自分のマシンでそれを許すかは自分で決める。

## 開発

```bash
bun test lib/ cli/          # ノードの transcript 解析と CLI
cd hub && bun test lib/     # ハブの認証
MACHINE_NAME=mac-a PORT=4399 bun run server.ts    # ノードを手元で動かす
inbox --hub http://127.0.0.1:4399 list            # CLI を手元のノードに向ける（トークン無し）
```

## ライセンス

MIT
