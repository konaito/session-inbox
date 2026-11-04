import { test, expect, afterAll } from "bun:test";
import { unlink } from "node:fs/promises";
import { injected, toItems, readTranscript, isValidWebFrom, emptyMeta, metaFrom, detailFromWindow, readRange, pendingFrom, type ChatItem } from "./transcript";

const tmpFiles: string[] = [];
async function fixture(name: string, lines: object[]): Promise<{ path: string; size: number }> {
  const path = `${import.meta.dir}/.tmp-${name}.jsonl`;
  const body = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  await Bun.write(path, body);
  tmpFiles.push(path);
  return { path, size: Buffer.byteLength(body) };
}
afterAll(async () => {
  for (const p of tmpFiles) await unlink(p).catch(() => {});
});

test("メールの送り主の行を外し、ハブのホスト名を持つ", () => {
  const it = injected("from alice@example.com via hub.example.com\nやって", "t");
  expect(it).toEqual({ kind: "injected", text: "やって", ts: "t", via: "web", from: "alice@example.com", host: "hub.example.com" });
});

test("ホスト名が無い行や変な行は送り主不明として本文をそのまま残す", () => {
  expect(injected("from alice@example.com via \nやって").via).toBeUndefined();
  expect(injected("[hub から alice]\nやって").text).toBe("[hub から alice]\nやって");
});

test("ローカルの行を外す", () => {
  expect(injected("via localhost\nやって").via).toBe("local");
});

test("peer の user 行を injected にする", () => {
  const rec = {
    type: "user",
    origin: { kind: "peer" },
    isMeta: true,
    message: { content: "Another Claude session sent a message:\nfrom alice@example.com via hub.example.com\nやって\n\nThis came from another Claude session ..." },
  };
  expect(toItems(rec)[0]).toMatchObject({ kind: "injected", text: "やって", from: "alice@example.com", host: "hub.example.com" });
});

test("readTranscript は末尾から読んで offset を返す", async () => {
  const { path, size } = await fixture("read", [
    { type: "user", origin: { kind: "human" }, message: { content: "こんにちは" }, timestamp: "2026-11-04T00:00:00Z" },
    { type: "assistant", message: { content: [{ type: "text", text: "はい" }, { type: "tool_use", name: "Bash", input: { command: "ls" } }] }, timestamp: "2026-11-04T00:00:01Z" },
    { type: "ai-title", aiTitle: "題名" },
  ]);
  const r = await readTranscript(path, {});
  expect(r.items.map((i) => i.kind)).toEqual(["user", "assistant", "tool"]);
  expect(r.title).toBe("題名");
  expect(r.offset).toBe(size);
});

test("agent の送り主の行を外す", () => {
  const it = injected("from agent:mac-a/note-19 via hub.example.com\nやって", "t");
  expect(it).toEqual({ kind: "injected", text: "やって", ts: "t", via: "web", from: "agent:mac-a/note-19", host: "hub.example.com" });
});

test("isValidViaHost はホスト名だけ通す", () => {
  const { isValidViaHost } = require("./transcript");
  expect(isValidViaHost("hub.example.com")).toBe(true);
  expect(isValidViaHost("localhost:4321")).toBe(false);
  expect(isValidViaHost("a b")).toBe(false);
  expect(isValidViaHost("")).toBe(false);
});

test("isValidWebFrom はメールか agent:<名前> だけ通す", () => {
  expect(isValidWebFrom("alice@example.com")).toBe(true);
  expect(isValidWebFrom("agent:a.b/c-1_x")).toBe(true);
  expect(isValidWebFrom("agent:")).toBe(false);
  expect(isValidWebFrom("agent:bad name")).toBe(false);
  expect(isValidWebFrom("agent:x\ny")).toBe(false);
  expect(isValidWebFrom("agent:" + "a".repeat(65))).toBe(false);
  expect(isValidWebFrom("not-an-email")).toBe(false);
});

test("metaFrom は各記録を拾い、後のものが勝つ", () => {
  const m = emptyMeta();
  for (const rec of [
    { type: "permission-mode", permissionMode: "default" },
    { type: "permission-mode", permissionMode: "bypassPermissions" },
    { type: "assistant", gitBranch: "feat/x", message: { content: [] } },
    { type: "pr-link", prUrl: "https://github.com/o/r/pull/1", prNumber: 1, timestamp: "t1" },
    { type: "pr-link", prUrl: "https://github.com/o/r/pull/1", prNumber: 1, timestamp: "t2" },
    { type: "worktree-state", worktreeSession: { worktreePath: "/w", worktreeBranch: "wb", originalBranch: "main" } },
    { type: "system", subtype: "away_summary", content: "要約", timestamp: "t3" },
    { type: "ai-title", aiTitle: "題名" },
  ]) metaFrom(rec, m);
  expect(m).toEqual({
    title: "題名",
    permissionMode: "bypassPermissions",
    gitBranch: "feat/x",
    worktree: { worktreePath: "/w", worktreeBranch: "wb", originalBranch: "main" },
    prLinks: [{ prUrl: "https://github.com/o/r/pull/1", prNumber: 1, timestamp: "t2" }],
    awaySummary: { text: "要約", ts: "t3" },
    queue: [],
  });
});

test("detailFromWindow は最後の発言とツールを返す", () => {
  const items: ChatItem[] = [
    { kind: "user", text: "人", ts: "1", via: "terminal" },
    { kind: "injected", text: "x".repeat(300), ts: "2", via: "web", from: "agent:p" },
    ...Array.from({ length: 12 }, (_, i) => ({ kind: "tool" as const, name: "Bash", summary: `s${i}`, ts: "3" })),
    { kind: "assistant", text: "返事", ts: "4" },
  ];
  const d = detailFromWindow(items, emptyMeta(), 1234);
  expect(d.lastHuman).toEqual({ text: "人", ts: "1" });
  expect(d.lastInjected?.text.length).toBe(200);
  expect(d.lastInjected?.from).toBe("agent:p");
  expect(d.lastAssistant).toEqual({ text: "返事", ts: "4" });
  expect(d.recentTools.length).toBe(10);
  expect(d.recentTools[9].summary).toBe("s11");
  expect(d.offset).toBe(1234);
  expect(d.awaySummary).toBeNull();
});

test("readRange は meta を返す", async () => {
  const { path, size } = await fixture("meta", [
    { type: "permission-mode", permissionMode: "bypassPermissions" },
    { type: "ai-title", aiTitle: "題名" },
    { type: "assistant", gitBranch: "main", message: { content: [{ type: "text", text: "はい" }] }, timestamp: "t" },
  ]);
  const r = await readRange(path, 0, size, false);
  expect(r.meta.permissionMode).toBe("bypassPermissions");
  expect(r.meta.title).toBe("題名");
  expect(r.meta.gitBranch).toBe("main");
  expect(r.title).toBe("題名");
});

test("metaFrom は queue-operation を順に集め、pendingFrom が保留だけを返す", () => {
  const m = emptyMeta();
  for (const rec of [
    { type: "queue-operation", operation: "dequeue", timestamp: "t0" },
    { type: "queue-operation", operation: "enqueue", timestamp: "t1", content: "from agent:p via hub.example.com\n一つ目" },
    { type: "queue-operation", operation: "enqueue", timestamp: "t2", content: "via localhost\n二つ目" },
    { type: "queue-operation", operation: "dequeue", timestamp: "t3" },
  ]) metaFrom(rec, m);
  expect(m.queue).toEqual([
    { op: "dequeue", at: "t0" },
    { op: "enqueue", at: "t1", text: "一つ目", from: "agent:p", via: "web" },
    { op: "enqueue", at: "t2", text: "二つ目", from: null, via: "local" },
    { op: "dequeue", at: "t3" },
  ]);
  expect(pendingFrom(m.queue)).toEqual([{ text: "二つ目", from: null, via: "local", at: "t2" }]);
});

test("送り主の行が無い enqueue（task-notification や本人の入力）は先入れ先出しに数えるが pending には出さない", () => {
  const m = emptyMeta();
  for (const rec of [
    { type: "queue-operation", operation: "enqueue", timestamp: "t1", content: "<task-notification>…</task-notification>" },
    { type: "queue-operation", operation: "enqueue", timestamp: "t2", content: "from agent:p via hub.example.com\n親の文" },
    { type: "queue-operation", operation: "dequeue", timestamp: "t3" },
  ]) metaFrom(rec, m);
  expect(m.queue[0]).toEqual({ op: "enqueue", at: "t1", text: "<task-notification>…</task-notification>", from: null, via: null });
  // dequeue は先頭の task-notification を取り出したので、親の文はまだ保留
  expect(pendingFrom(m.queue)).toEqual([{ text: "親の文", from: "agent:p", via: "web", at: "t2" }]);
});

test("readTranscript は範囲内の queue を返し、detailFromWindow は pending を持つ", async () => {
  const { path } = await fixture("queue", [
    { type: "queue-operation", operation: "enqueue", timestamp: "t1", content: "via localhost\n保留中" },
    { type: "assistant", message: { content: [{ type: "text", text: "はい" }] }, timestamp: "t" },
  ]);
  const r = await readTranscript(path, {});
  expect(r.queue).toEqual([{ op: "enqueue", at: "t1", text: "保留中", from: null, via: "local" }]);
  const d = detailFromWindow([], (await readRange(path, 0, 10_000, false)).meta, 1);
  expect(d.pending).toEqual([{ text: "保留中", from: null, via: "local", at: "t1" }]);
  expect((d as any).queue).toBeUndefined();
});
