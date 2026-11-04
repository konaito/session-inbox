import { defineHandler } from "void";
import { nodeFetch, pick, type NodeEnv } from "../../../../lib/nodes";
import { verifiedCaller, AGENT_NAME_RE } from "../../../../lib/access";

// 割り込みの送信を、そのセッションがあるマシンに中継する
export const POST = defineHandler(async (c) => {
  const id = c.req.param("id");
  if (!/^[0-9a-f-]{36}$/.test(id ?? "")) return c.json({ error: "bad id" }, 400);
  const env = c.env as unknown as NodeEnv;
  let node;
  try {
    node = pick(env, new URL(c.req.url).searchParams.get("m") ?? undefined);
  } catch {
    return c.json({ error: "unknown machine" }, 400);
  }
  const body = await c.req.json<{ text?: unknown; as?: unknown }>().catch(() => null);
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text) return c.json({ error: "text is required" }, 400);
  // 本人ならメール、親エージェントなら agent:<名前>（as で名乗る。無ければ client_id の先頭8文字）。手元の vite dev では固定の名前
  const caller = verifiedCaller(c.req.raw) ?? ((c.env as any).DEV_NO_AUTH === "1" ? ({ kind: "user", email: "dev@localhost" } as const) : null);
  if (!caller) return c.json({ error: "no verified caller" }, 403);
  const as = typeof body?.as === "string" && AGENT_NAME_RE.test(body.as) ? body.as : null;
  // 本人でも as を名乗れば agent:<名乗り> で送る（画面から Muse などのエージェントが送るとき用）。親エージェントは常に agent:
  const from = caller.kind === "user" ? (as ? `agent:${as}` : caller.email) : `agent:${as ?? caller.commonName.slice(0, 8)}`;
  const res = await nodeFetch(env, node, `/api/sessions/${id}/send`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // via はこのハブのホスト名。ノードが送り主の行「from <誰> via <ホスト>」に使う
    body: JSON.stringify({ text, from, via: new URL(c.req.url).host }),
  });
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json; charset=utf-8" } });
});
