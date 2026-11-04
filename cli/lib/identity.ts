// 親が子に名乗る名前。「<マシン>/<sessionId の先頭8文字>/<役割>」にすると、子の画面や summary から親をたどれる
// Claude Code の Bash から動くときは CLAUDE_CODE_SESSION_ID が入っているので、それを使う
const MAX = 64;
export function agentName(o: { machine: string; sessionId: string | undefined; label: string | undefined }): string {
  const label = (o.label && o.label.trim() ? o.label : "parent").replace(/[^A-Za-z0-9._-]/g, "-");
  const sid = o.sessionId && /^[0-9a-f]{8}/.test(o.sessionId) ? o.sessionId.slice(0, 8) : null;
  const head = sid ? `${o.machine}/${sid}/` : `${o.machine}/`;
  return head + label.slice(0, Math.max(1, MAX - head.length));
}
