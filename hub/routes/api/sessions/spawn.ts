import { defineHandler } from "void";
import { nodeFetch, pick, type NodeEnv } from "../../../lib/nodes";

// 子を立てる依頼を、そのマシンのノードに中継する。ノードが tmux で claude を起動する
export const POST = defineHandler(async (c) => {
  const env = c.env as unknown as NodeEnv;
  let node;
  try {
    node = pick(env, new URL(c.req.url).searchParams.get("m") ?? undefined);
  } catch {
    return c.json({ error: "unknown machine" }, 400);
  }
  const body = await c.req.json<{ dir?: unknown; name?: unknown }>().catch(() => null);
  const dir = typeof body?.dir === "string" ? body.dir.trim() : "";
  if (!dir) return c.json({ error: "dir is required" }, 400);
  const res = await nodeFetch(env, node, "/api/sessions/spawn", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dir, name: typeof body?.name === "string" ? body.name : undefined }),
  }, 15000);
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json; charset=utf-8" } });
});
