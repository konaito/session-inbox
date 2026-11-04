import { test, expect } from "bun:test";
import { spawnPlan, REMOTE_PATH } from "./spawn";

test("別の Mac なら ssh で tmux を立て、信頼確認に答え、絶対パスを聞き、止める", () => {
  const p = spawnPlan({ machine: "mac-b", dir: "~/Documents/keirin", name: "child-keirin", localHost: "mac-a" });
  expect(p.remote).toBe(true);
  expect(p.start).toContain("ssh mac-b ");
  expect(p.start).toContain("tmux new -d -s child-keirin -c ~/Documents/keirin");
  expect(p.start).toContain("claude --dangerously-skip-permissions");
  expect(p.start).toContain(REMOTE_PATH);
  expect(p.trust).toContain("trust this folder");
  expect(p.trust).toContain("send-keys -t child-keirin Down Enter");
  expect(p.pwd).toContain("mkdir -p ~/Documents/keirin && cd ~/Documents/keirin && pwd");
  expect(p.stop).toContain("tmux kill-session -t child-keirin");
});

test("この Mac なら ssh を使わない", () => {
  const p = spawnPlan({ machine: "mac-a", dir: "/tmp/x", name: "child-x", localHost: "mac-a" });
  expect(p.remote).toBe(false);
  expect(p.start).not.toContain("ssh ");
  expect(p.start).toContain("tmux new -d -s child-x -c /tmp/x");
});

test("tmux の名前と dir に危ない文字は通さない", () => {
  expect(() => spawnPlan({ machine: "mac-b", dir: "~/a; rm -rf /", name: "x", localHost: "k" })).toThrow();
  expect(() => spawnPlan({ machine: "mac-b", dir: "~/a", name: "bad name", localHost: "k" })).toThrow();
  expect(() => spawnPlan({ machine: "bad host", dir: "~/a", name: "x", localHost: "k" })).toThrow();
});
