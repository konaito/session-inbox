// Cloudflare Access の JWT を確かめる。鍵はチームの JWKS から取り、isolate の中で1時間使い回す
// 呼び出し元は2種類。本人（email のある JWT）と、親エージェント（サービストークン由来で common_name だけの JWT）
let cache: { at: number; domain: string; keys: Map<string, CryptoKey> } | null = null;

// 親エージェントの名前。lib/transcript.ts と同じ値。ハブはリポジトリのルート外を import しないので重ねて持つ
export const AGENT_NAME_RE = /^[A-Za-z0-9._\/-]{1,64}$/;

async function keys(domain: string, fresh = false) {
  if (!fresh && cache && cache.domain === domain && Date.now() - cache.at < 3600_000) return cache.keys;
  const res = await fetch(`https://${domain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`JWKS ${res.status}`);
  const { keys: list } = (await res.json()) as { keys: (JsonWebKey & { kid: string })[] };
  const map = new Map<string, CryptoKey>();
  for (const k of list) map.set(k.kid, await crypto.subtle.importKey("jwk", k, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]));
  cache = { at: Date.now(), domain, keys: map };
  return map;
}

const dec = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));

export function tokenFrom(req: Request): string | null {
  const cookie = req.headers.get("cookie")?.match(/(?:^|;\s*)CF_Authorization=([^;]+)/)?.[1];
  return req.headers.get("cf-access-jwt-assertion") ?? cookie ?? null;
}

export function decodePayload(token: string): { header: any; payload: any } | null {
  const [h, p, sig] = token.split(".");
  if (!h || !p || !sig) return null;
  try {
    return { header: JSON.parse(new TextDecoder().decode(dec(h))), payload: JSON.parse(new TextDecoder().decode(dec(p))) };
  } catch {
    return null;
  }
}

export function checkClaims(payload: any, env: { ACCESS_TEAM_DOMAIN: string; ACCESS_AUD: string }, now = Date.now()): string | null {
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(env.ACCESS_AUD)) return "bad aud";
  if (payload.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) return "bad iss";
  if (typeof payload.exp !== "number" || payload.exp * 1000 < now) return "expired";
  return null;
}

export function checkUser(payload: any, env: { ACCESS_EMAILS: string }): string | null {
  const allowed = env.ACCESS_EMAILS.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return allowed.includes(String(payload.email ?? "").toLowerCase()) ? null : "email not allowed";
}

export function checkAgent(payload: any, env: { PARENT_CLIENT_IDS: string }): string | null {
  const allowed = (env.PARENT_CLIENT_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const cn = payload.common_name;
  return typeof cn === "string" && cn && allowed.includes(cn) ? null : "agent not allowed";
}

// 署名と aud、iss、期限を確かめ、payload を返す
async function verifyToken(req: Request, env: { ACCESS_TEAM_DOMAIN: string; ACCESS_AUD: string }): Promise<{ payload: any } | { error: string }> {
  const token = tokenFrom(req);
  if (!token) return { error: "no access token" };
  const [h, p, sig] = token.split(".");
  const d = decodePayload(token);
  if (!d || !sig) return { error: "malformed token" };
  if (d.header.alg !== "RS256") return { error: "bad alg" };
  let key = (await keys(env.ACCESS_TEAM_DOMAIN)).get(d.header.kid);
  if (!key) key = (await keys(env.ACCESS_TEAM_DOMAIN, true)).get(d.header.kid);
  if (!key) return { error: "unknown kid" };
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, dec(sig), new TextEncoder().encode(`${h}.${p}`));
  if (!ok) return { error: "bad signature" };
  const err = checkClaims(d.payload, env);
  return err ? { error: err } : { payload: d.payload };
}

export async function verifyUser(req: Request, env: { ACCESS_TEAM_DOMAIN: string; ACCESS_AUD: string; ACCESS_EMAILS: string }): Promise<string | null> {
  const r = await verifyToken(req, env);
  return "error" in r ? r.error : checkUser(r.payload, env);
}

export async function verifyAgent(req: Request, env: { ACCESS_TEAM_DOMAIN: string; ACCESS_AUD: string; PARENT_CLIENT_IDS: string }): Promise<string | null> {
  const r = await verifyToken(req, env);
  return "error" in r ? r.error : checkAgent(r.payload, env);
}

// middleware で検証済みの JWT から、呼び出し元だけを読む
export function verifiedCaller(req: Request): { kind: "user"; email: string } | { kind: "agent"; commonName: string } | null {
  const token = tokenFrom(req);
  const p = token ? decodePayload(token)?.payload : null;
  if (!p) return null;
  if (typeof p.email === "string" && p.email) return { kind: "user", email: p.email };
  if (typeof p.common_name === "string" && p.common_name) return { kind: "agent", commonName: p.common_name };
  return null;
}
