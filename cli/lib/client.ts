// ハブ（設定の hub）か、手元のノードへの呼び出し
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import type { ChatItem, Parent, QueueEvent, TranscriptDetail } from "../../lib/transcript";

export type Session = { machine: string; sessionId: string; name: string | null; title: string | null; status: string | null; waitingFor: string | null; cwd: string; lastAt: string | null; startedAt: number; parent?: Parent | null };
export type Machine = { name: string; ok: boolean; error?: string };
export type SessionDetail = TranscriptDetail & { machine: string; sessionId: string; name: string | null; cwd: string | null; status: string | null; waitingFor: string | null; startedAt: number | null };
export type Client = { base: string; local: boolean; headers: Record<string, string> };

export const CONFIG_DIR = join(homedir(), ".config", "session-inbox");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const TOKEN_FILE = join(CONFIG_DIR, "parent-token.json");

// ~/.config/session-inbox/config.json。hub はハブの URL、defaultMachine は子を置く既定のマシン名
export type Config = { hub: string; defaultMachine: string };
export function readConfig(): Config {
  try {
    const j = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
    return { hub: typeof j.hub === "string" ? j.hub.replace(/\/+$/, "") : "", defaultMachine: typeof j.defaultMachine === "string" ? j.defaultMachine : "" };
  } catch {
    return { hub: "", defaultMachine: "" };
  }
}

// hub 省略時は設定のハブと親用のサービストークン。手元のノード（127.0.0.1 か localhost）ならトークンを付けない（試験専用）
export function loadClient(opts: { hub?: string }, cfg: Config = readConfig()): Client {
  const base = (opts.hub ?? cfg.hub).replace(/\/+$/, "");
  const local = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(base);
  if (!base) throw new Error(`ハブの URL が無い。${CONFIG_FILE} に {"hub":"https://<ハブ>","defaultMachine":"<マシン名>"} を置く`);
  // 親トークンは全マシンの会話を読めるので、設定のハブ以外には絶対に付けない（打ち間違いで漏らさない）
  if (!local && base !== cfg.hub) throw new Error(`--hub は ${cfg.hub || "設定のハブ"} か手元のノード（http://127.0.0.1:<port>）だけ。${base} には送らない`);
  const headers: Record<string, string> = { "x-cc-inject": "1", "content-type": "application/json" };
  if (!local) {
    let tok: { client_id?: string; client_secret?: string };
    try {
      tok = JSON.parse(readFileSync(TOKEN_FILE, "utf8"));
    } catch {
      throw new Error(`${TOKEN_FILE} が無いか読めない。{"client_id","client_secret"} を置く`);
    }
    if (!tok.client_id || !tok.client_secret) throw new Error(`${TOKEN_FILE} に client_id と client_secret が要る`);
    headers["CF-Access-Client-Id"] = tok.client_id;
    headers["CF-Access-Client-Secret"] = tok.client_secret;
  }
  return { base, local, headers };
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(`${status} ${message}`);
  }
}

async function call<T>(c: Client, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(c.base + path, { ...init, headers: { ...c.headers, ...(init.headers as Record<string, string> | undefined) }, redirect: "manual" });
  if (res.status >= 300 && res.status < 400) throw new ApiError(res.status, "Access に弾かれた（ログイン画面へ転送された）");
  const body: any = await res.json().catch(() => ({}));
  if (res.status !== 200 && res.status !== 202) throw new ApiError(res.status, typeof body?.error === "string" ? body.error : JSON.stringify(body));
  return body as T;
}

const q = (c: Client, s: { machine: string }, extra: Record<string, string> = {}) => {
  const p = new URLSearchParams({ ...(c.local ? {} : { m: s.machine }), ...extra });
  return p.size ? `?${p}` : "";
};

export function listSessions(c: Client) {
  return call<{ sessions: Session[]; machines: Machine[] }>(c, "/api/sessions");
}

export function getSummary(c: Client, s: { machine: string; sessionId: string }) {
  return call<SessionDetail>(c, `/api/sessions/${s.sessionId}/summary${q(c, s)}`);
}

export function getMessages(c: Client, s: { machine: string; sessionId: string }, offset?: number) {
  return call<{ items: ChatItem[]; offset: number; title?: string; queue?: QueueEvent[] }>(c, `/api/sessions/${s.sessionId}/messages${q(c, s, offset === undefined ? {} : { offset: String(offset) })}`);
}

export function sendText(c: Client, s: { machine: string; sessionId: string }, text: string, as?: string) {
  return call<{ accepted: boolean; pid: number; status: string | null; offset: number | null }>(c, `/api/sessions/${s.sessionId}/send${q(c, s)}`, {
    method: "POST",
    body: JSON.stringify(as ? { text, as } : { text }),
  });
}
