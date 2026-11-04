import { defineHandler } from "void";
import { nodeFetch, nodes, type NodeEnv } from "../../lib/nodes";

// 全マシンのセッションを集める。止まっているマシンは machines に ok: false で返す
export const GET = defineHandler(async (c) => {
  const env = c.env as unknown as NodeEnv;
  const results = await Promise.all(
    nodes(env).map(async (n) => {
      try {
        const res = await nodeFetch(env, n, "/api/sessions", {}, 4000);
        if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { sessions: any[] };
        return { machine: { name: n.name, ok: true }, sessions: body.sessions.map((s) => ({ ...s, machine: n.name })) };
      } catch (e) {
        return { machine: { name: n.name, ok: false, error: String((e as Error).message ?? e) }, sessions: [] };
      }
    }),
  );
  const sessions = results.flatMap((r) => r.sessions);
  const t = (s: any) => (s.lastAt ? Date.parse(s.lastAt) : s.startedAt);
  sessions.sort((a, b) => Number(b.status === "busy") - Number(a.status === "busy") || t(b) - t(a));
  return c.json({ sessions, machines: results.map((r) => r.machine) });
});
