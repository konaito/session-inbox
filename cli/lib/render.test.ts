import { test, expect } from "bun:test";
import { renderList, renderSummary, renderItems, renderFooter } from "./render";
import type { SessionDetail } from "./client";
import type { ChatItem } from "../../lib/transcript";

// SessionDetail のすべての項目を null（prLinks と recentTools は []）にしたもの
const emptyDetail: SessionDetail = {
  machine: "mac-b", sessionId: "aaaaaaaa-0000-0000-0000-000000000000", name: null, cwd: null, status: null, waitingFor: null, startedAt: null,
  title: null, permissionMode: null, gitBranch: null, worktree: null, prLinks: [], awaySummary: null,
  pending: [], parent: null, lastHuman: null, lastInjected: null, lastAssistant: null, recentTools: [], offset: 0,
};

test("renderList は止まっているマシンを出す", () => {
  const out = renderList([], [{ name: "mac-b", ok: false, error: "HTTP 530" }]);
  expect(out).toContain("mac-b");
  expect(out).toContain("つながらない");
});

test("renderSummary は保留中の割り込みを短く出す", () => {
  const out = renderSummary({ ...emptyDetail, pending: [{ text: "x".repeat(500), from: "agent:p", via: "web", at: "t" }] }, null);
  const line = out.split("\n").find((l) => l.startsWith("- 保留中の割り込み"))!;
  expect(line.length).toBeLessThan(200);
  expect(line).toContain("agent:p");
});

test("renderSummary は null を不明と書き、exited を出す", () => {
  const out = renderSummary({ ...emptyDetail, awaySummary: null, offset: 10 }, null);
  expect(out).toContain("不明");
  expect(out).toContain("exited");
});

test("renderItems はツールをたたむ", () => {
  const items = [{ kind: "tool", name: "Bash", summary: "a" }, { kind: "tool", name: "Edit", summary: "b" }, { kind: "assistant", text: "返事" }] as ChatItem[];
  expect(renderItems(items, false)).toContain("ツール 2 件: Bash, Edit");
  expect(renderItems(items, false)).not.toContain("summary");
  expect(renderItems(items, true)).toContain("Edit");
  expect(renderItems(items, true)).toContain("b");
});

test("renderFooter は生の値を1行ずつ", () => {
  const out = renderFooter({ status: "idle", waitingFor: null, permissionMode: "bypassPermissions", offset: 99 });
  expect(out).toContain("offset: 99");
  expect(out).toContain("status: idle");
  expect(out).toContain("permissionMode: bypassPermissions");
  expect(out).toContain("waitingFor: なし");
});
