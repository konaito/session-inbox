import { test, expect } from "bun:test";
import { agentName } from "./identity";

test("親のセッションが分かれば <マシン>/<sessionId 先頭8文字>/<役割>", () => {
  expect(agentName({ machine: "mac-a", sessionId: "6ac704ea-f2e6-400b-9e7b-e95e7819a22b", label: "lead" })).toBe("mac-a/6ac704ea/lead");
  expect(agentName({ machine: "mac-a", sessionId: undefined, label: "lead" })).toBe("mac-a/lead");
  expect(agentName({ machine: "mac-a", sessionId: undefined, label: undefined })).toBe("mac-a/parent");
});

test("役割に使えない文字は - にし、全体を 64 文字に収める", () => {
  expect(agentName({ machine: "mac-a", sessionId: undefined, label: "bad name!" })).toBe("mac-a/bad-name-");
  const long = agentName({ machine: "a-very-long-machine-name-xxxxxxxx", sessionId: "6ac704ea-0000-0000-0000-000000000000", label: "x".repeat(80) });
  expect(long.length).toBeLessThanOrEqual(64);
  expect(long.startsWith("a-very-long-machine-name-xxxxxxxx/6ac704ea/")).toBe(true);
});
