import { test, expect } from "bun:test";
import { initState, step, readLoop } from "./read";
import type { ChatItem } from "../../lib/transcript";

const inj = (t: string): ChatItem => ({ kind: "injected", text: t, via: "web", from: "agent:p" });
const asst = (t: string): ChatItem => ({ kind: "assistant", text: t });

test("送った文が届き、返事が出て、busy が2回続けて消えたら 0", () => {
  let r = step(initState("やって", 120), { items: [inj("やって")], status: "busy", waitingFor: null }, 3000);
  expect(r.stop).toBeNull();
  r = step(r.state, { items: [asst("できた")], status: "idle", waitingFor: null }, 3000);
  expect(r.stop).toBeNull();
  r = step(r.state, { items: [], status: "idle", waitingFor: null }, 3000);
  expect(r.stop).toEqual({ code: 0, reason: expect.any(String) });
});

test("届いても返事が無ければ待つ", () => {
  let r = step(initState("やって", 120), { items: [inj("やって")], status: "idle", waitingFor: null }, 3000);
  r = step(r.state, { items: [], status: "idle", waitingFor: null }, 3000);
  expect(r.stop).toBeNull();
});

test("waiting が2回続いたら 3（1回では status の古いキャッシュかもしれないので待つ）", () => {
  let r = step(initState("やって", 120), { items: [], status: "waiting", waitingFor: "input needed" }, 3000);
  expect(r.stop).toBeNull();
  r = step(r.state, { items: [], status: "waiting", waitingFor: "input needed" }, 3000);
  expect(r.stop?.code).toBe(3);
  expect(r.stop?.reason).toContain("input needed");
});

test("waiting のあと idle に戻り返事が出ていれば 3 でなく 0", () => {
  let r = step(initState("やって", 120), { items: [], status: "waiting", waitingFor: "permission prompt" }, 3000);
  expect(r.stop).toBeNull();
  // waiting も busy ではないので、idle の tick で busy でない状態が2回続いたことになる
  r = step(r.state, { items: [inj("やって"), asst("ok")], status: "idle", waitingFor: null }, 3000);
  expect(r.stop?.code).toBe(0);
});

test("時間切れは 2", () => {
  const r = step(initState("やって", 1), { items: [], status: "busy", waitingFor: null }, 1000);
  expect(r.stop?.code).toBe(2);
});

test("照合する文が無ければ新しい項目1件と busy でない2回で 0", () => {
  let r = step(initState(null, 120), { items: [asst("x")], status: "idle", waitingFor: null }, 3000);
  expect(r.stop).toBeNull();
  r = step(r.state, { items: [], status: "idle", waitingFor: null }, 3000);
  expect(r.stop?.code).toBe(0);
});

test("子が消えたら busy でないと扱う", () => {
  let r = step(initState("やって", 120), { items: [inj("やって"), asst("最後")], status: undefined, waitingFor: null }, 3000);
  r = step(r.state, { items: [], status: undefined, waitingFor: null }, 3000);
  expect(r.stop?.code).toBe(0);
});

test("readLoop は transcript がまだ無い 404 を空の読みとして扱い、続ける", async () => {
  const { ApiError } = await import("./client");
  let calls = 0;
  const api = {
    messages: async (offset: number) => {
      calls++;
      if (calls === 1) throw new ApiError(404, "transcript not found");
      return { items: calls === 2 ? [inj("やって"), asst("2")] : [], offset: 100 + calls };
    },
    status: async () => ({ status: calls <= 2 ? "busy" : "idle", waitingFor: null }),
    permissionMode: async () => "bypassPermissions",
  };
  const r = await readLoop(api, { since: 0, sentText: "やって", waitSec: 60 }, { sleep: async () => {}, now: (() => { let t = 0; return () => (t += 3000); })() });
  expect(r.stop.code).toBe(0);
  expect(r.items.map((i) => i.kind)).toEqual(["injected", "assistant"]);
  expect(r.permissionMode).toBe("bypassPermissions");
});

test("送った文が保留のまま busy でない状態が2回続けば 4", () => {
  const enq = { op: "enqueue" as const, at: "t1", text: "やって", from: "agent:p", via: "web" as const };
  let r = step(initState("やって", 120), { items: [], status: "idle", waitingFor: null, queue: [enq] }, 3000);
  expect(r.stop).toBeNull();
  r = step(r.state, { items: [], status: "idle", waitingFor: null, queue: [] }, 3000);
  expect(r.stop?.code).toBe(4);
});

test("保留が解けて届けば 0 になる", () => {
  const enq = { op: "enqueue" as const, at: "t1", text: "やって", from: "agent:p", via: "web" as const };
  let r = step(initState("やって", 120), { items: [], status: "waiting", waitingFor: "permission prompt", queue: [enq] }, 3000);
  r = step(r.state, { items: [], status: "waiting", waitingFor: "permission prompt", queue: [] }, 3000);
  expect(r.stop?.code).toBe(3);
  expect(r.stop?.reason).toContain("保留");
  r = step({ ...r.state }, { items: [inj("やって"), asst("できた")], status: "idle", waitingFor: null, queue: [{ op: "dequeue", at: "t2" }] }, 3000);
  r = step(r.state, { items: [], status: "idle", waitingFor: null, queue: [] }, 3000);
  expect(r.stop?.code).toBe(0);
});

test("マシンが落ちているとき status() は例外にし、readLoop は偽の終了を返さない", async () => {
  const { apiFor } = await import("./read");
  const { ApiError } = await import("./client");
  // listSessions を差し替えるため、fetch を偽装する
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any) =>
    new Response(JSON.stringify(String(url).includes("/messages")
      ? { items: [], offset: 1 }
      : { sessions: [], machines: [{ name: "mac-b", ok: false, error: "HTTP 530" }] }), { status: 200, headers: { "content-type": "application/json" } })) as any;
  try {
    const api = apiFor({ base: "https://hub.example.com", local: false, headers: {} }, { machine: "mac-b", sessionId: "aaaaaaaa-0000-0000-0000-000000000000", name: "x", title: null, status: "busy", waitingFor: null, cwd: "/", lastAt: null, startedAt: 0 });
    await expect(api.status()).rejects.toThrow(/mac-b/);
    await expect(readLoop(api, { since: 0, sentText: "やって", waitSec: 60 }, { sleep: async () => {}, now: () => 0 })).rejects.toThrow(/mac-b/);
  } finally {
    globalThis.fetch = origFetch;
  }
  void ApiError;
});

test("send の offset が無い（transcript がまだ無い）ときは先頭から読む", async () => {
  const { startOffset } = await import("./read");
  expect(startOffset(1234)).toBe(1234);
  expect(startOffset(null)).toBe(0);
});

test("waitAll は複数の子を同時に待ち、全員の結果を返す", async () => {
  const { waitAll } = await import("./read");
  const mk = (replyAtCall: number, text: string) => {
    let calls = 0;
    return {
      messages: async (offset: number) => {
        calls++;
        return { items: calls === 1 ? [inj(text)] : calls === replyAtCall ? [asst("done " + text)] : [], offset: offset + 1 };
      },
      status: async () => ({ status: calls < replyAtCall ? "busy" : "idle", waitingFor: null }),
      permissionMode: async () => "bypassPermissions",
    };
  };
  const io = { sleep: async () => {}, now: (() => { let t = 0; return () => (t += 3000); })() };
  const r = await waitAll([
    { label: "a", api: mk(2, "A"), since: 0, sentText: "A" },
    { label: "b", api: mk(4, "B"), since: 0, sentText: "B" },
  ], 60, io);
  expect(r.map((x) => x.label)).toEqual(["a", "b"]);
  expect(r.map((x) => x.stop.code)).toEqual([0, 0]);
  expect(r[1].items.some((i) => i.kind === "assistant" && i.text === "done B")).toBe(true);
});
