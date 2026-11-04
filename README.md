# session-inbox

See and steer your running Claude Code sessions from anywhere, and let one Claude Code session drive sessions on your other machines.

- A web page (PWA) lists every running Claude Code session on all your Macs, shows the conversation, and lets you send a message into any of them.
- A CLI (`inbox`) lets a "parent" Claude Code session spawn "child" sessions on another Mac, read their situation, send instructions, and read the replies.
- Everything runs on your own Cloudflare account. No Remote Control, no third-party relay. Cloudflare Access guards the page with your email and the CLI with a service token.

Japanese version: [README.ja.md](README.ja.md)

## How it works

```
phone / laptop browser                parent Claude Code session (CLI `inbox`)
        |  Cloudflare Access (email)          |  Cloudflare Access (service token)
        v                                     v
hub  (Cloudflare Worker, hub/)  ──────────────┘
        |  service token + shared secret
        ├── node-a.example.com ── cloudflared ──> 127.0.0.1:4322  server.ts  (Mac A)
        └── node-b.example.com ── cloudflared ──> 127.0.0.1:4322  server.ts  (Mac B)

server.ts reads and writes on each Mac
    claude agents --json                   list of running sessions
    ~/.claude/projects/*/<sessionId>.jsonl conversation
    /tmp/cc-socks/<pid>.sock               inbox socket to inject a message
```

- **node** (`server.ts`, one per Mac, Bun): serves the page and API on 127.0.0.1:4321 for local use, and a node API on 127.0.0.1:4322 for the hub. The node API checks both the Access JWT of the hub's service token and a shared secret header.
- **hub** (`hub/`, Cloudflare Worker built with [Void](https://void.cloud)): verifies the Access JWT (an email for humans, a service-token `common_name` for parent sessions) and relays to the right node.
- **page** (`index.html` + `public/`): one file, no framework. Served by the node and copied into the hub by `scripts/deploy-hub.sh`.
- **CLI** (`cli/inbox.ts`): `list`, `show`, `send`, `read`, `run`, `wait`, `spawn`, `stop`. A Claude Code skill in `skills/session-inbox/` teaches a parent session when and how to use it.

A message injected from outside arrives in the session as "Another Claude session sent a message", with a first line `from <email> via <hub host>` (human) or `from agent:<name> via <hub host>` (parent session). Claude Code treats it as a peer request: it cannot approve permission prompts, change settings, or run slash commands.

## Requirements

- macOS with [Bun](https://bun.sh), `cloudflared`, and Claude Code. Tested with Claude Code 2.1.316. This project depends on undocumented internals of Claude Code (`claude agents --json`, the transcript format, the inbox socket), so a Claude Code update can break it.
- A Cloudflare account with a zone you control, and Cloudflare Zero Trust (Access) enabled.
- Sessions must accept cross-session messages: `"crossSessionInbound": "accept"` in `~/.claude/settings.json`.

## Setup

### 1. Cloudflare

1. Create two Access applications. One for the hub domain (allow your email, plus the parent service token below), one for the node hostnames (allow only the hub's service token).
2. Create service tokens: `hub` (the hub uses it to call nodes), `parent` (the CLI uses it to call the hub), and `deploy` (Void's post-deploy readiness check needs to get through Access).
3. For each Mac, create a cloudflared tunnel and route a hostname to it (`cloudflared tunnel create`, `cloudflared tunnel route dns`).

### 2. Node (each Mac)

1. Put a shared secret of at least 32 characters in `~/.config/session-inbox/peer-token` (same value on every node and in the hub).
2. Write `~/.cloudflared/session-inbox.yml` that sends the node hostname to `http://127.0.0.1:4322`.
3. Copy `launchd/*.plist.example` to `~/Library/LaunchAgents/`, fill in the `__PLACEHOLDERS__`, and start them with `launchctl bootstrap gui/$(id -u) <plist>`.
4. For additional Macs, `scripts/deploy-node.sh <ssh host> <machine name> <node hostname> <tunnel id>` does steps 1 to 3 over SSH. It reads `NODE_ACCESS_AUD` and `ACCESS_TEAM_DOMAIN` from `~/.config/session-inbox/deploy.env`.

Environment variables for `server.ts`: `PORT`, `MACHINE_NAME`, `ACCESS_TEAM_DOMAIN`, `NODE_PORT`, `NODE_HOST`, `NODE_ACCESS_AUD`, `NODE_SERVICE_CLIENT_ID`, `NODE_TOKEN_FILE`. See `CLAUDE.md` for details.

### 3. Hub

1. Copy `hub/deploy.example.json` to `hub/deploy.json` and fill it in (account id, hub domain, Access team domain and aud, allowed emails, parent client ids, node list). It is git-ignored.
2. Put the service token secrets with `wrangler secret put` in `hub/`: `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` (the `hub` token) and `NODE_TOKEN` (the shared secret).
3. Save the `deploy` token as `~/.config/session-inbox/deploy-token.json` (`{"client_id","client_secret"}`), then run `scripts/deploy-hub.sh`. On the very first deploy attach the custom domain first with `wrangler triggers deploy`, otherwise Void's readiness check cannot reach the Worker.

### 4. Parent CLI and skill

1. `~/.config/session-inbox/config.json`: `{"hub":"https://<hub domain>","defaultMachine":"<machine name>"}`.
2. `~/.config/session-inbox/parent-token.json`: the `parent` service token, mode 0600.
3. A wrapper on PATH, for example `~/.local/bin/inbox`: `exec bun run <repo>/cli/inbox.ts "$@"`.
4. Link `skills/session-inbox` into your Claude Code skills directory. The skill tells a parent session to spawn children for independent tasks, send instructions, wait for replies, and report back.

## Usage

```bash
inbox list                                   # sessions on every machine
inbox spawn mac-b ~/Documents/project        # start a child (tmux + claude --dangerously-skip-permissions over ssh)
inbox show mac-b/project-3f                  # branch, PR, permission mode, status, Claude's own recap, last exchange, pending interrupts
inbox run mac-b/project-3f "..." --as mac-a/lead --wait 600   # send and wait for the reply
inbox wait mac-b/a-1 mac-b/b-2 --wait 600    # wait for several children at once
inbox stop mac-b child-project               # kill the child's tmux session
```

`read`, `run` and `wait` exit with 0 when the reply is complete, 2 on timeout, 3 when the child is waiting for human input (a permission prompt or a question), 4 when the message is still queued. They always print the raw `status`, `waitingFor`, `permissionMode` and transcript `offset` at the end so the parent can judge for itself.

## Security notes

- The parent service token can read every transcript on every node and send to every session. Keep it at mode 0600; the CLI refuses to attach it to any host other than the configured hub.
- The first line of an injected message is not proof of identity. Any process on the same Mac can write the same line to the socket.
- Sending to a session that is blocked on a permission prompt usually queues the message until the prompt is resolved, but in one of three observed cases it interrupted the prompt (declining the tool). The skill tells parents not to send to a `waiting` session.
- `inbox spawn` starts children with `--dangerously-skip-permissions` so they can work unattended. Decide whether that is acceptable on your machines.

## Development

```bash
bun test lib/ cli/          # node transcript parsing and the CLI
cd hub && bun test lib/     # hub auth
MACHINE_NAME=mac-a PORT=4399 bun run server.ts    # run a node locally
inbox --hub http://127.0.0.1:4399 list            # point the CLI at it (no token)
```

## License

MIT
