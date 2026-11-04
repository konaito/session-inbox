import { test, expect } from "bun:test";
import { resolveTarget } from "./resolve";
import type { Session } from "./client";

const s = (machine: string, name: string, id: string): Session => ({ machine, name, sessionId: id, title: null, status: "idle", waitingFor: null, cwd: "/", lastAt: null, startedAt: 0 });
const list = [
  s("mac-a", "note-19", "0d36343d-51a6-46b2-9a13-13014e6b89f9"),
  s("mac-b", "note-19", "aaaaaaaa-0000-0000-0000-000000000000"),
  s("mac-b", "ibiki-44", "2646e42b-d35f-4214-87fd-2a21d4876a11"),
];

test("sessionId と 8 文字以上の前方一致", () => {
  expect(resolveTarget(list, "2646e42b-d35f-4214-87fd-2a21d4876a11")).toMatchObject({ ok: true, session: { name: "ibiki-44" } });
  expect(resolveTarget(list, "2646e42b")).toMatchObject({ ok: true });
  expect(resolveTarget(list, "2646e4")).toMatchObject({ ok: false, reason: "none" });
});

test("machine/name と name", () => {
  expect(resolveTarget(list, "mac-b/note-19")).toMatchObject({ ok: true, session: { machine: "mac-b" } });
  expect(resolveTarget(list, "ibiki-44")).toMatchObject({ ok: true });
  expect(resolveTarget(list, "note-19")).toMatchObject({ ok: false, reason: "ambiguous" });
  expect((resolveTarget(list, "note-19") as any).candidates.length).toBe(2);
});
