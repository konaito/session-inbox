import { test, expect } from "bun:test";
import { spawnArgs, trustPromptAnswered, stopTarget } from "./spawn";

test("spawnArgs は dir の ~ を展開し、tmux の引数と claude の起動文を組む", () => {
  const a = spawnArgs({ dir: "~/Documents/x", name: "child-x", home: "/Users/me" });
  expect(a.cwd).toBe("/Users/me/Documents/x");
  expect(a.tmux).toEqual(["tmux", "new", "-d", "-s", "child-x", "-c", "/Users/me/Documents/x", a.command]);
  expect(a.command).toContain("claude --dangerously-skip-permissions");
  expect(a.command).toContain("/opt/homebrew/bin");
});

test("spawnArgs は名前が無ければ dir の末尾から作り、危ない文字は断る", () => {
  expect(spawnArgs({ dir: "/tmp/proj", home: "/h" }).name).toBe("child-proj");
  expect(() => spawnArgs({ dir: "/tmp/a; rm -rf /", home: "/h" })).toThrow();
  expect(() => spawnArgs({ dir: "/tmp/a", name: "bad name", home: "/h" })).toThrow();
  expect(() => spawnArgs({ dir: "relative/path", home: "/h" })).toThrow();
});

test("trustPromptAnswered は画面に信頼確認が出ているときだけ true", () => {
  expect(trustPromptAnswered("...Yes, I trust this folder\n Enter to confirm")).toBe(true);
  expect(trustPromptAnswered("❯ Try \"fix typecheck errors\"")).toBe(false);
});

test("stopTarget は pid を正の整数に限る", () => {
  expect(stopTarget({ pid: 123 })).toBe(123);
  expect(() => stopTarget({ pid: 0 })).toThrow();
  expect(() => stopTarget({ pid: -1 })).toThrow();
  expect(() => stopTarget({})).toThrow();
});
