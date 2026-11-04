import { defineHandler } from "void";
import { nodeFetch, pick, type NodeEnv } from "../../../../lib/nodes";

// 会話の読み込みを、そのセッションがあるマシンに中継する
export const GET = defineHandler(async (c) => {
  const id = c.req.param("id");
  if (!/^[0-9a-f-]{36}$/.test(id ?? "")) return c.json({ error: "bad id" }, 400);
  const env = c.env as unknown as NodeEnv;
  const url = new URL(c.req.url);
  let node;
  try {
    node = pick(env, url.searchParams.get("m") ?? undefined);
  } catch {
    return c.json({ error: "unknown machine" }, 400);
  }
  const q = new URLSearchParams();
  for (const k of ["offset", "before"]) {
    const v = url.searchParams.get(k);
    if (v && /^\d+$/.test(v)) q.set(k, v);
  }
  const res = await nodeFetch(env, node, `/api/sessions/${id}/messages${q.size ? `?${q}` : ""}`);
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json; charset=utf-8" } });
});
