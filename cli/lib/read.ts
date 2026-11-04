// 子の返事を読む。終了の判定は便宜で、親が自分で見られるように生の status と offset も返す
import type { ChatItem, QueueEvent } from "../../lib/transcript";
import { ApiError, getMessages, getSummary, listSessions, type Client, type Session } from "./client";

export type Tick = { items: ChatItem[]; status: string | null | undefined; waitingFor: string | null; queue?: QueueEvent[] }; // status undefined は agents に無い（終了）
export type ReadState = { sentText: string | null; delivered: boolean; assistantAfter: number; newItems: number; notBusyStreak: number; waitingStreak: number; elapsedMs: number; waitMs: number; pending: string[] };
export type Stop = { code: 0 | 2 | 3 | 4; reason: string };

export function initState(sentText: string | null, waitSec: number): ReadState {
  return { sentText, delivered: false, assistantAfter: 0, newItems: 0, notBusyStreak: 0, waitingStreak: 0, elapsedMs: 0, waitMs: waitSec * 1000, pending: [] };
}

// 1回の読みで状態を進め、止めるべきなら理由を返す
export function step(prev: ReadState, tick: Tick, dtMs: number): { state: ReadState; stop: Stop | null } {
  const s: ReadState = { ...prev, pending: [...prev.pending], elapsedMs: prev.elapsedMs + dtMs, newItems: prev.newItems + tick.items.length };
  // 保留の出入りは tick をまたいで先入れ先出しで追う
  for (const e of tick.queue ?? []) {
    if (e.op === "enqueue") s.pending.push(e.via ? e.text : ""); // 割り込み以外は数合わせの空文字
    else s.pending.shift();
  }
  const held = s.sentText !== null && s.pending.some((t) => t !== "" && t.trim() === s.sentText!.trim());
  for (const it of tick.items) {
    if (!s.delivered && s.sentText !== null && it.kind === "injected" && it.text.trim() === s.sentText.trim()) s.delivered = true;
    else if (s.delivered && it.kind === "assistant") s.assistantAfter++;
  }
  // status の 2 秒キャッシュと 3 秒間隔のずれがあるので、busy でないことは2回続けて見る
  s.notBusyStreak = tick.status === "busy" ? 0 : s.notBusyStreak + 1;
  s.waitingStreak = tick.status === "waiting" ? s.waitingStreak + 1 : 0;
  if (s.waitingStreak >= 2) return { state: s, stop: { code: 3, reason: `子が本人の入力待ち（${tick.waitingFor ?? "waiting"}）。割り込みでは解けない${held ? "。送った文は保留中で、解けたら届く" : ""}` } };
  if (s.elapsedMs >= s.waitMs) return { state: s, stop: { code: 2, reason: held ? "時間切れ。送った文は保留中" : "時間切れ。まだ作業中" } };
  if (held && s.notBusyStreak >= 2) return { state: s, stop: { code: 4, reason: "送った文が保留のまま。子が受け取っていない" } };
  const done = s.sentText !== null ? s.delivered && s.assistantAfter >= 1 && s.notBusyStreak >= 2 : s.newItems >= 1 && s.notBusyStreak >= 2;
  if (done) return { state: s, stop: { code: 0, reason: tick.status === undefined ? "子は終了していて、最後の発言まで読んだ" : "返事が出そろった" } };
  return { state: s, stop: null };
}

// send の応答に offset が無いのは transcript がまだ無いとき（立ち上げ直後）。そのあと最初に書かれるのが送った文なので、先頭から読む
export function startOffset(sendOffset: number | null): number {
  return sendOffset ?? 0;
}

const INTERVAL_MS = 3000;

// 読みに使う3つの呼び出し。試験では差し替える
export type Api = {
  messages: (offset: number) => Promise<{ items: ChatItem[]; offset: number; queue?: QueueEvent[] }>;
  status: () => Promise<{ status: string | null; waitingFor: string | null } | undefined>; // undefined は agents に無い（終了）
  permissionMode: () => Promise<string | null>;
};

export function apiFor(c: Client, s: Session): Api {
  return {
    messages: (offset) => getMessages(c, s, offset),
    status: async () => {
      const r = await listSessions(c);
      // マシンが落ちていると一覧に行が無くなるが、それは「終了」ではない。偽の終了を返さず例外にする
      const m = r.machines.find((x) => x.name === s.machine);
      if (m && !m.ok) throw new Error(`${s.machine} につながらない${m.error ? `（${m.error}）` : ""}。read を止める`);
      const row = r.sessions.find((x) => x.sessionId === s.sessionId);
      return row ? { status: row.status, waitingFor: row.waitingFor } : undefined;
    },
    permissionMode: () => getSummary(c, s).then((d) => d.permissionMode),
  };
}

export async function readLoop(
  api: Api,
  opts: { since: number; sentText: string | null; waitSec: number },
  io: { sleep: (ms: number) => Promise<void>; now: () => number } = { sleep: (ms) => Bun.sleep(ms), now: () => Date.now() },
): Promise<{ items: ChatItem[]; offset: number; stop: Stop; last: Tick; permissionMode: string | null }> {
  let state = initState(opts.sentText, opts.waitSec);
  let offset = opts.since;
  const items: ChatItem[] = [];
  let last: Tick = { items: [], status: null, waitingFor: null };
  let stop: Stop | null = null;
  let t = io.now();
  for (;;) {
    // 立ち上げ直後のセッションは transcript がまだ無く 404 になる。空の読みとして扱い、次を待つ
    let r: { items: ChatItem[]; offset: number; queue?: QueueEvent[] };
    try {
      r = await api.messages(offset);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) r = { items: [], offset };
      else throw e;
    }
    offset = r.offset;
    const row = await api.status();
    last = { items: r.items, status: row ? row.status : undefined, waitingFor: row?.waitingFor ?? null, queue: r.queue ?? [] };
    items.push(...r.items);
    const now = io.now();
    const res = step(state, last, now - t);
    t = now;
    state = res.state;
    if (res.stop) {
      stop = res.stop;
      break;
    }
    await io.sleep(INTERVAL_MS);
  }
  // 止まったあとに1回だけ summary を読み、permissionMode を footer に出す
  const permissionMode = await api.permissionMode().catch(() => null);
  return { items, offset, stop, last, permissionMode };
}

// 複数の子を同時に待つ。1体ずつ readLoop を回し、全員が止まるまで待つ
export type WaitTarget = { label: string; api: Api; since: number; sentText: string | null };
export type WaitResult = { label: string; items: ChatItem[]; offset: number; stop: Stop; last: Tick; permissionMode: string | null };
export async function waitAll(targets: WaitTarget[], waitSec: number, io?: Parameters<typeof readLoop>[2]): Promise<WaitResult[]> {
  return Promise.all(targets.map(async (t) => ({ label: t.label, ...(await readLoop(t.api, { since: t.since, sentText: t.sentText, waitSec }, io)) })));
}
