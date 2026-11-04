// transcript（~/.claude/projects/*/<sessionId>.jsonl）を画面用の項目に変える。server.ts から切り出した
import { stat, open } from "node:fs/promises";

export const INITIAL_TAIL_BYTES = 512 * 1024;

export type ChatItem =
  | { kind: "user"; text: string; ts?: string; via: "terminal" | "queued" }
  | { kind: "assistant"; text: string; ts?: string }
  | { kind: "tool"; name: string; summary: string; ts?: string }
  | { kind: "injected"; text: string; ts?: string; via?: "web" | "local"; from?: string; host?: string }
  | { kind: "notice"; text: string; ts?: string; tone: "info" | "warn" };

// ツール呼び出しを1行で言い表す
export function toolSummary(name: string, input: any): string {
  if (!input || typeof input !== "object") return "";
  const base = (p: unknown) => (typeof p === "string" ? p.replace(/^\/Users\/[^/]+/, "~") : "");
  let s =
    input.description ??
    (name === "Bash" ? input.command : undefined) ??
    base(input.file_path ?? input.path ?? input.notebook_path) ??
    "";
  if (!s) s = input.pattern ?? input.url ?? input.query ?? input.prompt ?? input.skill ?? input.action ?? "";
  // MCP ツールなどは、引数の中で最初に出てくる短い文字列を説明に使う
  if (!s) s = Object.values(input).find((v) => typeof v === "string" && v.length > 0 && v.length < 300) as string ?? "";
  if (!s && Array.isArray(input.actions)) s = `${input.actions.length}件の操作`;
  if (!s) s = JSON.stringify(input);
  s = String(s).replace(/\s+/g, " ").trim();
  return s.length > 160 ? s.slice(0, 160) + "…" : s;
}

// 割り込みの先頭に付ける送り主の行。画面ではこの行を外して表示する
// 1行目は「from <メール> via <ハブのホスト名>」「from agent:<名前> via <ハブのホスト名>」「via localhost」
// 親エージェントの名前。改行や空白は通さない（hub/lib/access.ts にも同じ値がある）
export const AGENT_NAME_RE = /^[A-Za-z0-9._\/-]{1,64}$/;
const EMAIL_RE = /^[^\s@\]\[]+@[^\s@\]\[]+$/;
const HOST_RE = /^[A-Za-z0-9.-]{1,253}$/;
// ハブから渡される from。本人ならメール、親エージェントなら agent:<名前>
export function isValidWebFrom(from: string): boolean {
  return EMAIL_RE.test(from) || (from.startsWith("agent:") && AGENT_NAME_RE.test(from.slice(6)));
}
// ハブから渡される via（ハブのホスト名）。ポートや空白は通さない
export function isValidViaHost(host: string): boolean {
  return HOST_RE.test(host);
}
// 親エージェントの名前「<マシン>/<sessionId の先頭8文字>/<役割>」を分ける。古い「<マシン>/<役割>」や「<役割>」も読む
export type AgentFrom = { machine: string | null; sessionIdPrefix: string | null; label: string };
export function parseAgentFrom(from: string): AgentFrom | null {
  if (!from.startsWith("agent:")) return null;
  const parts = from.slice(6).split("/");
  if (parts.length >= 3 && /^[0-9a-f]{8}$/.test(parts[1])) return { machine: parts[0], sessionIdPrefix: parts[1], label: parts.slice(2).join("/") };
  if (parts.length >= 2) return { machine: parts[0], sessionIdPrefix: null, label: parts.slice(1).join("/") };
  return { machine: null, sessionIdPrefix: null, label: parts[0] };
}
// 最後に文を送ってきた親
export type Parent = AgentFrom & { at: string | null };
export function parentFrom(items: ChatItem[]): Parent | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind !== "injected" || !it.from) continue;
    const a = parseAgentFrom(it.from);
    if (a) return { ...a, at: it.ts ?? null };
  }
  return null;
}
export const SENDER_WEB_RE = /^from (\S+@\S+|agent:[A-Za-z0-9._\/-]{1,64}) via ([A-Za-z0-9.-]{1,253})\n/;
export const SENDER_LOCAL_RE = /^via localhost\n/;
export const SENDER_LOCAL = "via localhost\n";
export function injected(raw: string, ts?: string): ChatItem {
  const w = raw.match(SENDER_WEB_RE);
  if (w) return { kind: "injected", text: raw.slice(w[0].length), ts, via: "web", from: w[1], host: w[2] };
  const l = raw.match(SENDER_LOCAL_RE);
  if (l) return { kind: "injected", text: raw.slice(l[0].length), ts, via: "local" };
  return { kind: "injected", text: raw, ts };
}

export const PEER_RE = /^Another Claude session sent a message:\n([\s\S]*?)\n\nThis came from another Claude session/;

// transcript の1行を画面用の項目に変える。表示しないものは空配列
export function toItems(rec: any): ChatItem[] {
  if (!rec || rec.isSidechain) return [];
  const ts = rec.timestamp;
  if (rec.type === "user") {
    let c = rec.message?.content;
    if (Array.isArray(c) && !rec.isMeta && rec.origin?.kind === "human") {
      const parts = c.map((p: any) => (p?.type === "text" ? p.text : p?.type === "image" ? "［画像］" : "")).filter(Boolean);
      if (parts.length) c = parts.join("\n");
    }
    if (typeof c !== "string") return [];
    const kind = rec.origin?.kind;
    // 待機中のセッションに届いた割り込みは、isMeta の user 行に定型文で包まれて残る
    if (kind === "peer") {
      const m = c.match(PEER_RE);
      return [injected(m ? m[1] : c, ts)];
    }
    if (rec.isCompactSummary) return [{ kind: "notice", text: "ここまでの会話を要約して続けている", ts, tone: "info" }];
    if (kind === "task-notification") {
      const s = c.match(/<summary>([\s\S]*?)<\/summary>/)?.[1];
      return s ? [{ kind: "notice", text: s.trim(), ts, tone: "info" }] : [];
    }
    if (rec.isMeta) return [];
    const cmd = c.match(/<command-name>([^<]+)<\/command-name>/)?.[1];
    if (cmd) {
      const args = c.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim();
      return [{ kind: "user", text: args ? `${cmd} ${args}` : cmd, ts, via: "terminal" }];
    }
    if (/^\s*<(local-command|bash-|system-reminder|artifact-)/.test(c)) return [];
    return [{ kind: "user", text: c, ts, via: "terminal" }];
  }
  if (rec.type === "assistant") {
    const items: ChatItem[] = [];
    for (const b of rec.message?.content ?? []) {
      if (b.type === "text" && b.text?.trim()) items.push({ kind: "assistant", text: b.text, ts });
      else if (b.type === "tool_use") items.push({ kind: "tool", name: b.name, summary: toolSummary(b.name, b.input), ts });
    }
    return items;
  }
  if (rec.type === "attachment" && rec.attachment?.type === "queued_command") {
    const a = rec.attachment;
    // 画像付きの入力は prompt が配列になる。文字だけ取り出し、画像は印にする
    const text = Array.isArray(a.prompt)
      ? a.prompt.map((p: any) => (p?.type === "text" ? p.text : p?.type === "image" ? "［画像］" : "")).filter(Boolean).join("\n")
      : String(a.prompt ?? "");
    if (a.origin?.kind === "peer") return [injected(text, ts)];
    if (/^\s*<task-notification>/.test(text)) {
      const sum = text.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim();
      return sum ? [{ kind: "notice", text: sum, ts, tone: "info" }] : [];
    }
    if (/^\s*<[a-z-]+>/.test(text)) return [];
    return [{ kind: "user", text: text.replace(/^\[Image #\d+\]\s*/gm, "").trim() || "［画像］", ts, via: "queued" }];
  }
  if (rec.type === "system" && rec.subtype === "informational" && typeof rec.content === "string") {
    return [{ kind: "notice", text: rec.content, ts, tone: rec.level === "warning" ? "warn" : "info" }];
  }
  return [];
}

// transcript に散らばる、セッションの状況を表す記録。後のものが勝つ
export type TranscriptMeta = {
  title: string | null;
  permissionMode: string | null;
  gitBranch: string | null;
  worktree: { worktreePath: string; worktreeBranch: string; originalBranch: string } | null;
  prLinks: { prUrl: string; prNumber: number | null; timestamp: string | null }[];
  awaySummary: { text: string; ts: string | null } | null;
  queue: QueueEvent[]; // 割り込みの保留と取り出し（queue-operation）。範囲内のものを順に
};
// 割り込みは queue-operation の enqueue として入り、セッションが受け取ると dequeue が書かれる。権限プロンプトや質問で止まっている間は enqueue のまま残る
// enqueue は割り込み（via が web か local）だけでなく、task-notification や本人がターン中に打った文も入る。via が null のものは先入れ先出しの数合わせにだけ使う
export type QueueEvent = { op: "enqueue"; at: string | null; text: string; from: string | null; via: "web" | "local" | null } | { op: "dequeue"; at: string | null };
export type Pending = { text: string; from: string | null; via: "web" | "local"; at: string | null };
export function emptyMeta(): TranscriptMeta {
  return { title: null, permissionMode: null, gitBranch: null, worktree: null, prLinks: [], awaySummary: null, queue: [] };
}
// enqueue と dequeue を先入れ先出しで突き合わせ、まだ届いていないものを返す。窓の外の enqueue に対する dequeue は無視する
export function pendingFrom(queue: QueueEvent[]): Pending[] {
  const q: (Pending | null)[] = [];
  for (const e of queue) {
    if (e.op === "enqueue") q.push(e.via ? { text: e.text, from: e.from, via: e.via, at: e.at } : null);
    else q.shift();
  }
  return q.filter((p): p is Pending => p !== null);
}
export function metaFrom(rec: any, meta: TranscriptMeta): void {
  if (!rec || typeof rec !== "object") return;
  if (typeof rec.gitBranch === "string" && rec.gitBranch) meta.gitBranch = rec.gitBranch;
  switch (rec.type) {
    case "ai-title":
      if (typeof rec.aiTitle === "string") meta.title = rec.aiTitle;
      break;
    case "permission-mode":
      if (typeof rec.permissionMode === "string") meta.permissionMode = rec.permissionMode;
      break;
    case "pr-link": {
      if (typeof rec.prUrl !== "string") break;
      const link = { prUrl: rec.prUrl, prNumber: typeof rec.prNumber === "number" ? rec.prNumber : null, timestamp: typeof rec.timestamp === "string" ? rec.timestamp : null };
      const i = meta.prLinks.findIndex((l) => l.prUrl === link.prUrl);
      if (i >= 0) meta.prLinks[i] = link;
      else meta.prLinks.push(link);
      break;
    }
    case "worktree-state": {
      const w = rec.worktreeSession;
      if (w && typeof w.worktreePath === "string") {
        meta.worktree = { worktreePath: w.worktreePath, worktreeBranch: String(w.worktreeBranch ?? ""), originalBranch: String(w.originalBranch ?? "") };
      }
      break;
    }
    case "system":
      if (rec.subtype === "away_summary" && typeof rec.content === "string") {
        meta.awaySummary = { text: rec.content, ts: typeof rec.timestamp === "string" ? rec.timestamp : null };
      }
      break;
    case "queue-operation": {
      const at = typeof rec.timestamp === "string" ? rec.timestamp : null;
      if (rec.operation === "enqueue" && typeof rec.content === "string") {
        const it = injected(rec.content);
        const via = it.kind === "injected" && (it.via === "web" || it.via === "local") ? it.via : null;
        meta.queue.push({ op: "enqueue", at, text: via && it.kind === "injected" ? it.text : rec.content, from: via && it.kind === "injected" ? it.from ?? null : null, via });
      } else if (rec.operation === "dequeue") {
        meta.queue.push({ op: "dequeue", at });
      }
      break;
    }
  }
}

// 親に見せる「子の状況」のうち、transcript から分かる部分
export type TranscriptDetail = Omit<TranscriptMeta, "queue"> & {
  pending: Pending[]; // 保留中の割り込み（窓の中で分かる範囲）
  parent: Parent | null; // 最後に文を送ってきた親エージェント
  lastHuman: { text: string; ts: string | null } | null;
  lastInjected: { from: string | null; via: string | null; text: string; ts: string | null } | null;
  lastAssistant: { text: string; ts: string | null } | null;
  recentTools: { name: string; summary: string; ts: string | null }[];
  offset: number;
};
const RECENT_TOOLS = 10;
const INJECTED_TEXT_MAX = 200;
export function detailFromWindow(items: ChatItem[], meta: TranscriptMeta, offset: number): TranscriptDetail {
  let lastHuman: TranscriptDetail["lastHuman"] = null;
  let lastInjected: TranscriptDetail["lastInjected"] = null;
  let lastAssistant: TranscriptDetail["lastAssistant"] = null;
  const tools: TranscriptDetail["recentTools"] = [];
  for (const it of items) {
    if (it.kind === "user") lastHuman = { text: it.text, ts: it.ts ?? null };
    else if (it.kind === "injected") lastInjected = { from: it.from ?? null, via: it.via ?? null, text: it.text.slice(0, INJECTED_TEXT_MAX), ts: it.ts ?? null };
    else if (it.kind === "assistant") lastAssistant = { text: it.text, ts: it.ts ?? null };
    else if (it.kind === "tool") tools.push({ name: it.name, summary: it.summary, ts: it.ts ?? null });
  }
  const { queue, ...rest } = meta;
  return { ...rest, pending: pendingFrom(queue), parent: parentFrom(items), lastHuman, lastInjected, lastAssistant, recentTools: tools.slice(-RECENT_TOOLS), offset };
}

// [from, to) のバイト範囲を行単位で読む。範囲の先頭が行の途中なら、その行は捨てる
export async function readRange(path: string, from: number, to: number, dropFirstPartial: boolean) {
  const fh = await open(path, "r");
  try {
    const len = Math.max(0, to - from);
    const buf = Buffer.alloc(len);
    if (len > 0) await fh.read(buf, 0, len, from);
    const lastNl = buf.lastIndexOf(0x0a);
    const end = lastNl === -1 ? 0 : lastNl + 1;
    let begin = 0;
    if (dropFirstPartial && from > 0) {
      const firstNl = buf.indexOf(0x0a);
      begin = firstNl === -1 ? end : Math.min(firstNl + 1, end);
    }
    const items: ChatItem[] = [];
    const meta = emptyMeta();
    for (const line of buf.subarray(begin, end).toString("utf8").split("\n")) {
      if (!line) continue;
      let rec: any;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      metaFrom(rec, meta);
      items.push(...toItems(rec));
    }
    return { items, meta, title: meta.title ?? undefined, start: from + begin, end: from + end };
  } finally {
    await fh.close();
  }
}

// to より前を、ツール以外の発言が MIN_TALK 件たまるまで、読む幅を倍にしながらさかのぼる
// transcript は API リクエストの記録が大半を占めるので、固定幅だとほとんど何も出ないことがある
export const MIN_TALK = 16; // ツール以外の発言の数
export const MAX_BACK_BYTES = 32 * 1024 * 1024;
export async function readBack(path: string, to: number) {
  let width = INITIAL_TAIL_BYTES;
  for (;;) {
    const from = Math.max(0, to - width);
    const r = await readRange(path, from, to, true);
    const talk = r.items.filter((i) => i.kind !== "tool").length;
    if (talk >= MIN_TALK || from === 0 || width >= MAX_BACK_BYTES) return r;
    width *= 2;
  }
}

// offset 以降を読む。offset がなければ末尾から読み、before があればそれより前を読む
export async function readTranscript(path: string, opts: { offset?: number; before?: number }) {
  const size = (await stat(path)).size;
  if (opts.before !== undefined) {
    const r = await readBack(path, Math.min(opts.before, size));
    return { items: r.items, start: r.start, hasMore: r.start > 0, title: r.title, queue: r.meta.queue };
  }
  if (opts.offset !== undefined && opts.offset <= size) {
    const r = await readRange(path, opts.offset, size, false);
    return { items: r.items, offset: r.end, title: r.title, queue: r.meta.queue };
  }
  const r = await readBack(path, size);
  return { items: r.items, offset: r.end, start: r.start, hasMore: r.start > 0, title: r.title, queue: r.meta.queue };
}

// 一覧用の要約。サイズが変わったときだけ読み直す
const summaryCache = new Map<string, { size: number; value: SessionSummary }>();
export type SessionSummary = { title: string | null; last: ChatItem | null; lastAt: string | null; parent: Parent | null };
export async function summarize(path: string): Promise<SessionSummary> {
  const size = (await stat(path)).size;
  const hit = summaryCache.get(path);
  if (hit && hit.size === size) return hit.value;
  const r = await readRange(path, Math.max(0, size - 256 * 1024), size, true);
  const last = [...r.items].reverse().find((i) => i.kind !== "notice") ?? null;
  const value = { title: r.title ?? hit?.value.title ?? null, last, lastAt: last?.ts ?? null, parent: parentFrom(r.items) ?? hit?.value.parent ?? null };
  summaryCache.set(path, { size, value });
  return value;
}
