import { test, expect } from "bun:test";
import { loadClient } from "./client";

const cfg = { hub: "https://hub.example.com", defaultMachine: "mac-b" };

test("手元のノード（127.0.0.1 / localhost）にはトークンを付けない", () => {
  const c = loadClient({ hub: "http://127.0.0.1:4399" }, cfg);
  expect(c.local).toBe(true);
  expect(c.headers["CF-Access-Client-Id"]).toBeUndefined();
  expect(loadClient({ hub: "http://localhost:4399/" }, cfg).local).toBe(true);
});

test("設定のハブでも手元でもないホストには、トークンを読む前に断る", () => {
  expect(() => loadClient({ hub: "https://hub.example.com.evil" }, cfg)).toThrow(/hub\.example\.com/);
  expect(() => loadClient({ hub: "http://hub.example.com" }, cfg)).toThrow(/hub\.example\.com/);
});

test("ハブの設定が無ければ、設定ファイルの場所を示して断る", () => {
  expect(() => loadClient({}, { hub: "", defaultMachine: "" })).toThrow(/config\.json/);
});
