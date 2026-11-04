// 起動中の Claude Code セッションを一覧し、会話を表示し、受信ソケット経由でメッセージを送るローカルサーバー。
// 127.0.0.1 だけで待ち受ける。外に出すときは認証付きのトンネルを前に置くこと。
import { readdir, stat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { timingSafeEqual } from "node:crypto";
import { join } from "node:path";

const PORT = Number(process.env.PORT ?? 4321);
const HOST = "127.0.0.1";
const LOCAL_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const ALLOWED_ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);
// トンネル経由の公開設定。PUBLIC_HOST を入れたら、ACCESS_TEAM_DOMAIN と ACCESS_AUD も必須
const PUBLIC_HOST = process.env.PUBLIC_HOST ?? "";
const ACCESS_TEAM_DOMAIN = process.env.ACCESS_TEAM_DOMAIN ?? "";
const ACCESS_AUD = process.env.ACCESS_AUD ?? "";
const ACCESS_EMAILS = new Set((process.env.ACCESS_EMAILS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
if (PUBLIC_HOST) {
  if (!ACCESS_TEAM_DOMAIN || !ACCESS_AUD || ACCESS_EMAILS.size === 0) {
    throw new Error("PUBLIC_HOST を使うときは ACCESS_TEAM_DOMAIN、ACCESS_AUD、ACCESS_EMAILS が必要");
  }
  ALLOWED_ORIGINS.add(`https://${PUBLIC_HOST}`);
}
// ノードとしての公開。ハブ（Cloudflare Worker）からトンネル経由で呼ばれる
// NODE_PORT で 127.0.0.1 に API 専用の口を開き、Access のサービストークン由来の JWT と NODE_TOKEN の両方を確かめる
const MACHINE = process.env.MACHINE_NAME ?? hostname().replace(/\.local$/, "");
const NODE_PORT = Number(process.env.NODE_PORT ?? 0);
const NODE_HOST = process.env.NODE_HOST ?? "";
const NODE_ACCESS_AUD = process.env.NODE_ACCESS_AUD ?? "";
const NODE_SERVICE_CLIENT_ID = process.env.NODE_SERVICE_CLIENT_ID ?? "";
// 合言葉は plist に書かず、ファイルから読む
const NODE_TOKEN = process.env.NODE_TOKEN_FILE ? readFileSync(process.env.NODE_TOKEN_FILE, "utf8").trim() : "";
if (NODE_PORT) {
  if (!NODE_HOST || !NODE_ACCESS_AUD || !NODE_SERVICE_CLIENT_ID || !ACCESS_TEAM_DOMAIN || NODE_TOKEN.length < 32) {
    throw new Error("NODE_PORT を使うときは NODE_HOST、NODE_ACCESS_AUD、NODE_SERVICE_CLIENT_ID、ACCESS_TEAM_DOMAIN、32文字以上の NODE_TOKEN_FILE が必要");
  }
}

const PROJECTS_DIR = join(homedir(), ".claude", "projects");
const SOCK_DIRS = ["/tmp/cc-socks", `/tmp/cc-socks-${userInfo().uid}`];

type AgentRow = {
  pid: number;
  cwd: string;
  kind: string;
  startedAt: number;
  sessionId: string;
  name?: string;
  status?: string;
  waitingFor?: string;
};

// claude agents --json の結果を短時間キャッシュする
let agentsCache: { at: number; rows: AgentRow[] } | null = null;
async function listAgents(fresh = false): Promise<AgentRow[]> {
  if (!fresh && agentsCache && Date.now() - agentsCache.at < 2000) return agentsCache.rows;
  const proc = Bun.spawn(["claude", "agents", "--json"], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(`claude agents --json exited ${code}: ${await new Response(proc.stderr).text()}`);
  const rows = JSON.parse(out) as AgentRow[];
  if (!Array.isArray(rows)) throw new Error("claude agents --json did not return an array");
  agentsCache = { at: Date.now(), rows };
  return rows;
}

// sessionId から transcript を探す。cwd からスラッグを作ると /cd や resume でずれるので、全プロジェクトを見る
const transcriptCache = new Map<string, string>();
async function findTranscript(sessionId: string): Promise<string | null> {
  const cached = transcriptCache.get(sessionId);
  if (cached && existsSync(cached)) return cached;
  for (const dir of await readdir(PROJECTS_DIR)) {
    const p = join(PROJECTS_DIR, dir, `${sessionId}.jsonl`);
    if (existsSync(p)) {
      transcriptCache.set(sessionId, p);
      return p;
    }
  }
  return null;
}

function findSocket(pid: number): string | null {
  for (const d of SOCK_DIRS) {
    const p = join(d, `${pid}.sock`);
    if (existsSync(p)) return p;
  }
  return null;
}

import { type ChatItem, type SessionSummary, readTranscript, readBack, detailFromWindow, emptyMeta, summarize, SENDER_LOCAL, isValidWebFrom, isValidViaHost } from "./lib/transcript";

// 受信ソケットに1行書いて閉じる。応答は待たない（届いたかは transcript で見る）
async function sendToSocket(sockPath: string, text: string): Promise<void> {
  const line = JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n";
  await new Promise<void>((resolve, reject) => {
    Bun.connect({
      unix: sockPath,
      socket: {
        open(s) {
          s.write(line);
          s.end();
          resolve();
        },
        data() {},
        error(_s, err) {
          reject(err);
        },
        connectError(_s, err) {
          reject(err);
        },
      },
    }).catch(reject);
  });
}

// Cloudflare Access の JWT を検証する。鍵はチームの JWKS から取り、1時間キャッシュする
let jwksCache: { at: number; keys: Map<string, CryptoKey> } | null = null;
async function accessKeys(): Promise<Map<string, CryptoKey>> {
  if (jwksCache && Date.now() - jwksCache.at < 3600_000) return jwksCache.keys;
  const res = await fetch(`https://${ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  const { keys } = (await res.json()) as { keys: (JsonWebKey & { kid: string })[] };
  const map = new Map<string, CryptoKey>();
  for (const k of keys) {
    map.set(k.kid, await crypto.subtle.importKey("jwk", k, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]));
  }
  jwksCache = { at: Date.now(), keys: map };
  return map;
}

const b64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

async function verifyAccess(req: Request, aud: string, check: (payload: any) => string | null): Promise<string | null> {
  const cookie = req.headers.get("cookie")?.match(/(?:^|;\s*)CF_Authorization=([^;]+)/)?.[1];
  const token = req.headers.get("cf-access-jwt-assertion") ?? cookie;
  if (!token) return "no access token";
  const parts = token.split(".");
  if (parts.length !== 3) return "malformed token";
  const header = JSON.parse(b64url(parts[0]).toString("utf8"));
  const payload = JSON.parse(b64url(parts[1]).toString("utf8"));
  if (header.alg !== "RS256") return "bad alg";
  let key = (await accessKeys()).get(header.kid);
  if (!key) {
    jwksCache = null; // 鍵の入れ替え直後に備えて1回だけ取り直す
    key = (await accessKeys()).get(header.kid);
  }
  if (!key) return "unknown kid";
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!ok) return "bad signature";
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(aud)) return "bad aud";
  if (payload.iss !== `https://${ACCESS_TEAM_DOMAIN}`) return "bad iss";
  if (typeof payload.exp !== "number" || payload.exp * 1000 < Date.now()) return "expired";
  return check(payload);
}

const userCheck = (p: any) => (ACCESS_EMAILS.has(String(p.email ?? "").toLowerCase()) ? null : "email not allowed");
const serviceCheck = (p: any) => (p.common_name === NODE_SERVICE_CLIENT_ID ? null : "service token not allowed");

// 公開ホストから来たものは、ページも API も Access の JWT を必須にする
async function publicGuard(req: Request): Promise<Response | null> {
  const host = req.headers.get("host") ?? "";
  if (LOCAL_HOSTS.has(host)) return null;
  if (!PUBLIC_HOST || host !== PUBLIC_HOST) return new Response("forbidden host", { status: 403 });
  const err = await verifyAccess(req, ACCESS_AUD, userCheck).catch((e) => `verify error: ${e}`);
  if (err) {
    console.warn(`access denied: ${err}`);
    return new Response("forbidden", { status: 403 });
  }
  return null;
}

// ブラウザで開いている別サイトからの送信（CSRF）を止める
function guard(req: Request): Response | null {
  // DNS リバインディングで別ドメインから同一オリジン扱いで読まれるのを防ぐ
  const host = req.headers.get("host") ?? "";
  if (!LOCAL_HOSTS.has(host) && host !== PUBLIC_HOST) return new Response("forbidden host", { status: 403 });
  const origin = req.headers.get("origin");
  if (origin && !ALLOWED_ORIGINS.has(origin)) return new Response("forbidden origin", { status: 403 });
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return new Response("forbidden site", { status: 403 });
  if (req.method === "POST" && req.headers.get("x-cc-inject") !== "1") return new Response("missing header", { status: 403 });
  return null;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });

// ---------- このマシンの処理 ----------
async function localSessions() {
  const rows = await listAgents();
  return Promise.all(
    rows.map(async (r) => {
      const path = await findTranscript(r.sessionId);
      const sum = path ? await summarize(path).catch(() => null) : null;
      return {
        machine: MACHINE,
        sessionId: r.sessionId,
        pid: r.pid,
        name: r.name ?? null,
        title: sum?.title ?? null,
        last: sum?.last ?? null,
        lastAt: sum?.lastAt ?? null,
        cwd: r.cwd,
        kind: r.kind,
        status: r.status ?? null,
        waitingFor: r.waitingFor ?? null,
        startedAt: r.startedAt,
        hasTranscript: path !== null,
        hasSocket: findSocket(r.pid) !== null,
      };
    }),
  );
}

const num = (url: URL, k: string) => {
  const v = url.searchParams.get(k);
  return v === null || !/^\d+$/.test(v) ? undefined : Number(v);
};

async function localMessages(sessionId: string, url: URL): Promise<Response | null> {
  const path = await findTranscript(sessionId);
  if (!path) return null;
  return json(await readTranscript(path, { offset: num(url, "offset"), before: num(url, "before") }));
}

// 親に見せる「子の状況」。agents の行と transcript の窓（会話 API と同じ幅）からまとめる
// agents に無い（終了した）セッションは transcript だけから、transcript がまだ無いセッションは agents だけから答える
async function localSummary(sessionId: string): Promise<Response | null> {
  const row = (await listAgents()).find((r) => r.sessionId === sessionId);
  const path = await findTranscript(sessionId);
  if (!row && !path) return null;
  const size = path ? (await stat(path)).size : 0;
  const win = path ? await readBack(path, size) : { items: [] as ChatItem[], meta: emptyMeta() };
  return json({
    machine: MACHINE,
    sessionId,
    name: row?.name ?? null,
    cwd: row?.cwd ?? null,
    status: row?.status ?? null,
    waitingFor: row?.waitingFor ?? null,
    startedAt: row?.startedAt ?? null,
    ...detailFromWindow(win.items, win.meta, size),
  });
}

// via が "web" のときは、Access で確かめ済みのハブから渡された from（本人のメールか agent:<名前>）を送り主にする
async function localSend(sessionId: string, req: Request, via: "web" | "local"): Promise<Response | null> {
  // pid は respawn で変わるので、送る直前に取り直す
  const row = (await listAgents(true)).find((r) => r.sessionId === sessionId);
  if (!row) return null;
  const body = (await req.json().catch(() => null)) as { text?: unknown; from?: unknown; via?: unknown } | null;
  const raw = typeof body?.text === "string" ? body.text.trim() : "";
  if (!raw) return json({ error: "text is required" }, 400);
  let text: string;
  if (via === "web") {
    const from = typeof body?.from === "string" ? body.from : "";
    if (!isValidWebFrom(from)) return json({ error: "from is required" }, 400);
    // ハブは自分のホスト名を via で渡す。古いハブが渡さないときは "hub"
    const host = typeof body?.via === "string" && body.via ? body.via : "hub";
    if (!isValidViaHost(host)) return json({ error: "via is invalid" }, 400);
    text = `from ${from} via ${host}\n${raw}`;
  } else {
    text = SENDER_LOCAL + raw;
  }
  const sock = findSocket(row.pid);
  if (!sock) return json({ error: `inbox socket not found for pid ${row.pid}` }, 404);
  // 書く直前の transcript の長さ。親はここから返事を読む
  const path = await findTranscript(sessionId);
  const offset = path ? (await stat(path)).size : null;
  await sendToSocket(sock, text);
  // ソケットは受け取りを返さない。202 は「書き込んだ」までで、届いたかは transcript の記録で確かめる
  return json({ accepted: true, pid: row.pid, status: row.status ?? null, offset }, 202);
}

const SESSION_PATH = /^\/api\/sessions\/([0-9a-f-]{36})\/(messages|send|summary)$/;

// ---------- 画面と API（127.0.0.1、トンネル経由） ----------
Bun.serve({
  hostname: HOST,
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const denied = await publicGuard(req);
    if (denied) return denied;
    // ページ本体はどこから開かれてもよい。API だけ同一オリジンに限る
    if (url.pathname.startsWith("/api/")) {
      const blocked = guard(req);
      if (blocked) return blocked;
    }

    try {
      if (req.method === "GET" && url.pathname === "/") {
        return new Response(Bun.file(join(import.meta.dir, "index.html")), {
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
        });
      }

      // PWA 用の静的ファイル
      const STATIC: Record<string, string> = {
        "/manifest.webmanifest": "application/manifest+json",
        "/sw.js": "text/javascript; charset=utf-8",
        "/icon-192.png": "image/png",
        "/icon-512.png": "image/png",
        "/apple-touch-icon.png": "image/png",
      };
      if (req.method === "GET" && STATIC[url.pathname]) {
        return new Response(Bun.file(join(import.meta.dir, "public", url.pathname.slice(1))), {
          headers: { "content-type": STATIC[url.pathname], "cache-control": url.pathname === "/sw.js" ? "no-cache" : "public, max-age=86400" },
        });
      }

      if (req.method === "GET" && url.pathname === "/api/sessions") {
        const sessions = await localSessions();
        // 作業中を上に、その中は最後に動いた順
        const t = (s: { lastAt: string | null; startedAt: number }) => (s.lastAt ? Date.parse(s.lastAt) : s.startedAt);
        sessions.sort((a, b) => Number(b.status === "busy") - Number(a.status === "busy") || t(b) - t(a));
        return json({ sessions, machines: [{ name: MACHINE, ok: true }] });
      }

      const m = url.pathname.match(SESSION_PATH);
      if (m) {
        const [, sessionId, action] = m;
        if (req.method === "GET" && action === "messages") {
          return (await localMessages(sessionId, url)) ?? json({ error: "transcript not found" }, 404);
        }
        if (req.method === "GET" && action === "summary") {
          return (await localSummary(sessionId)) ?? json({ error: "session not found" }, 404);
        }
        if (req.method === "POST" && action === "send") {
          return (await localSend(sessionId, req, "local")) ?? json({ error: "session is not running" }, 404);
        }
      }

      return new Response("not found", { status: 404 });
    } catch (err) {
      console.error(err);
      return json({ error: String(err) }, 500);
    }
  },
});
console.log(`listening on http://${HOST}:${PORT} as ${MACHINE}`);

// ---------- ノード用の API（127.0.0.1:NODE_PORT、トンネル経由でハブから呼ばれる） ----------
function tokenOk(req: Request) {
  const got = Buffer.from(req.headers.get("x-node-token") ?? "");
  const want = Buffer.from(NODE_TOKEN);
  return got.length === want.length && timingSafeEqual(got, want);
}

if (NODE_PORT) {
  Bun.serve({
    hostname: HOST,
    port: NODE_PORT,
    async fetch(req) {
      if ((req.headers.get("host") ?? "") !== NODE_HOST) return new Response("forbidden host", { status: 403 });
      const err = await verifyAccess(req, NODE_ACCESS_AUD, serviceCheck).catch((e) => `verify error: ${e}`);
      if (err || !tokenOk(req)) {
        console.warn(`node access denied: ${err ?? "bad node token"}`);
        return new Response("forbidden", { status: 403 });
      }
      const url = new URL(req.url);
      try {
        if (req.method === "GET" && url.pathname === "/api/sessions") return json({ machine: MACHINE, sessions: await localSessions() });
        const m = url.pathname.match(SESSION_PATH);
        if (m && req.method === "GET" && m[2] === "messages") return (await localMessages(m[1], url)) ?? json({ error: "transcript not found" }, 404);
        if (m && req.method === "GET" && m[2] === "summary") return (await localSummary(m[1])) ?? json({ error: "session not found" }, 404);
        if (m && req.method === "POST" && m[2] === "send") return (await localSend(m[1], req, "web")) ?? json({ error: "session is not running" }, 404);
        return new Response("not found", { status: 404 });
      } catch (e) {
        console.error(e);
        return json({ error: String(e) }, 500);
      }
    },
  });
  console.log(`node api on http://${HOST}:${NODE_PORT} for ${NODE_HOST}`);
}
