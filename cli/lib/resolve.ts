// 親が指す「対象」を1つのセッションに決める。sessionId、sessionId の先頭 8 文字以上、<マシン>/<名前>、<名前>
import type { Session } from "./client";

export type Resolved = { ok: true; session: Session } | { ok: false; reason: "none" | "ambiguous"; candidates: Session[] };

export function resolveTarget(sessions: Session[], target: string): Resolved {
  const t = target.trim();
  const pick = (c: Session[]): Resolved => (c.length === 1 ? { ok: true, session: c[0] } : c.length === 0 ? { ok: false, reason: "none", candidates: [] } : { ok: false, reason: "ambiguous", candidates: c });
  if (/^[0-9a-f-]{36}$/.test(t)) return pick(sessions.filter((s) => s.sessionId === t));
  if (/^[0-9a-f-]{8,}$/.test(t)) return pick(sessions.filter((s) => s.sessionId.startsWith(t)));
  const slash = t.indexOf("/");
  if (slash > 0) {
    const [machine, name] = [t.slice(0, slash), t.slice(slash + 1)];
    return pick(sessions.filter((s) => s.machine === machine && s.name === name));
  }
  return pick(sessions.filter((s) => s.name === t));
}
