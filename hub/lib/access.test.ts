import { test, expect } from "bun:test";
import { checkClaims, checkUser, checkAgent, verifiedCaller, AGENT_NAME_RE } from "./access";

test("checkClaims は aud、iss、exp を見る", () => {
  const env = { ACCESS_TEAM_DOMAIN: "t.cloudflareaccess.com", ACCESS_AUD: "aud1" };
  const ok = { aud: ["aud1"], iss: "https://t.cloudflareaccess.com", exp: 2_000_000_000 };
  expect(checkClaims(ok, env, 1_000_000_000_000)).toBeNull();
  expect(checkClaims({ ...ok, aud: "x" }, env)).toBe("bad aud");
  expect(checkClaims({ ...ok, iss: "https://o" }, env)).toBe("bad iss");
  expect(checkClaims({ ...ok, exp: 1 }, env)).toBe("expired");
});

test("checkUser と checkAgent", () => {
  expect(checkUser({ email: "ALICE@example.com" }, { ACCESS_EMAILS: "alice@example.com" })).toBeNull();
  expect(checkUser({}, { ACCESS_EMAILS: "alice@example.com" })).toBe("email not allowed");
  expect(checkAgent({ common_name: "abc.access" }, { PARENT_CLIENT_IDS: "abc.access, def.access" })).toBeNull();
  expect(checkAgent({ common_name: "zzz" }, { PARENT_CLIENT_IDS: "abc.access" })).toBe("agent not allowed");
  expect(checkAgent({}, { PARENT_CLIENT_IDS: "" })).toBe("agent not allowed");
});

test("AGENT_NAME_RE は改行と空白を断る", () => {
  expect(AGENT_NAME_RE.test("mac-a/note-19")).toBe(true);
  expect(AGENT_NAME_RE.test("x\ny")).toBe(false);
  expect(AGENT_NAME_RE.test("bad name")).toBe(false);
});

test("verifiedCaller は email か common_name を読む", () => {
  const jwt = (p: object) => "e30." + btoa(JSON.stringify(p)).replace(/=+$/, "") + ".sig";
  const req = (t: string) => new Request("https://hub.example.com/", { headers: { "cf-access-jwt-assertion": t } });
  expect(verifiedCaller(req(jwt({ email: "a@b" })))).toEqual({ kind: "user", email: "a@b" });
  expect(verifiedCaller(req(jwt({ common_name: "abc.access" })))).toEqual({ kind: "agent", commonName: "abc.access" });
  expect(verifiedCaller(new Request("https://hub.example.com/"))).toBeNull();
});
