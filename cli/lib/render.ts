// 親（Claude Code）が読むための Markdown。判断は親がするので、値は加工せず、欠けは「不明」と書く
import type { ChatItem } from "../../lib/transcript";
import type { Machine, Session, SessionDetail } from "./client";

const NA = "不明";
const v = (x: unknown) => (x === null || x === undefined || x === "" ? NA : String(x));
const when = (ts: string | null | undefined) => (ts ? new Date(ts).toLocaleString("ja-JP", { hour12: false }) : NA);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

export function renderList(sessions: Session[], machines: Machine[]): string {
  const lines: string[] = [];
  for (const m of machines) if (!m.ok) lines.push(`- ${m.name}: つながらない${m.error ? `（${m.error}）` : ""}`);
  for (const s of sessions) {
    const st = s.status === "waiting" && s.waitingFor ? `waiting（${s.waitingFor}）` : v(s.status);
    lines.push(`- ${s.machine}/${v(s.name)}  ${st}  ${v(s.title)}  ${s.cwd}  最後の動き ${when(s.lastAt)}  ${s.sessionId}`);
  }
  if (sessions.length === 0) lines.push("- セッションは無い");
  return lines.join("\n") + "\n";
}

export function renderSummary(d: SessionDetail, s: Session | null): string {
  const status = s ? v(s.status) : d.status ?? "exited";
  const lines = [
    `# ${d.machine}/${v(d.name ?? s?.name)}  ${v(d.title)}`,
    ``,
    `- sessionId: ${d.sessionId}`,
    `- status: ${status}${d.waitingFor ? `（waitingFor: ${d.waitingFor}）` : ""}`,
    `- permissionMode: ${v(d.permissionMode)}`,
    `- cwd: ${v(d.cwd ?? s?.cwd)}`,
    `- gitBranch: ${v(d.gitBranch)}`,
    `- worktree: ${d.worktree ? `${d.worktree.worktreePath}（${d.worktree.worktreeBranch}、元は ${d.worktree.originalBranch}）` : NA}`,
    `- PR: ${d.prLinks.length ? d.prLinks.map((p) => p.prUrl).join(", ") : NA}`,
    `- 開始: ${d.startedAt ? when(new Date(d.startedAt).toISOString()) : NA}`,
    `- 親: ${d.parent ? `${d.parent.machine ?? "?"}/${d.parent.sessionIdPrefix ?? "?"}/${d.parent.label}（最後の文 ${when(d.parent.at)}）` : "なし"}`,
    `- 保留中の割り込み: ${d.pending?.length ? d.pending.map((p) => `${p.from ?? p.via} → ${oneLine(p.text).slice(0, 80)}`).join(" / ") : "なし"}`,
    ``,
    `## ここまでの要約（Claude Code 自身が書いたもの）`,
    d.awaySummary ? `${d.awaySummary.text}\n（${when(d.awaySummary.ts)}）` : NA,
    ``,
    `## 最後のやり取り`,
    `- 本人の最後の入力（${when(d.lastHuman?.ts)}）: ${d.lastHuman ? oneLine(d.lastHuman.text) : NA}`,
    `- 最後の割り込み（${when(d.lastInjected?.ts)}）: ${d.lastInjected ? `${v(d.lastInjected.from)} → ${oneLine(d.lastInjected.text)}` : NA}`,
    `- Claude の最後の発言（${when(d.lastAssistant?.ts)}）:`,
    d.lastAssistant ? d.lastAssistant.text : NA,
    ``,
    `## 直近のツール操作`,
    d.recentTools.length ? d.recentTools.map((t) => `- ${t.name}  ${oneLine(t.summary)}`).join("\n") : NA,
    ``,
    `- offset: ${d.offset}`,
  ];
  return lines.join("\n") + "\n";
}

export function renderItems(items: ChatItem[], all: boolean): string {
  const out: string[] = [];
  let run: Extract<ChatItem, { kind: "tool" }>[] = [];
  const flush = () => {
    if (!run.length) return;
    if (all) for (const t of run) out.push(`- ツール ${t.name}: ${oneLine(t.summary)}`);
    else out.push(`- ツール ${run.length} 件: ${[...new Set(run.map((t) => t.name))].join(", ")}`);
    run = [];
  };
  for (const it of items) {
    if (it.kind === "tool") {
      run.push(it);
      continue;
    }
    flush();
    const ts = it.ts ? `[${when(it.ts)}] ` : "";
    if (it.kind === "assistant") out.push(`${ts}Claude:\n${it.text}\n`);
    else if (it.kind === "user") out.push(`${ts}本人（ターミナル）: ${it.text}\n`);
    else if (it.kind === "injected") out.push(`${ts}割り込み（${v(it.from ?? it.via)}）: ${it.text}\n`);
    else if (it.kind === "notice") out.push(`${ts}${it.tone === "warn" ? "警告" : "注記"}: ${it.text}\n`);
  }
  flush();
  return out.join("\n") + (out.length ? "\n" : "");
}

export function renderFooter(f: { status: string | null; waitingFor: string | null; permissionMode: string | null; offset: number }): string {
  // waitingFor は無いのがふつうなので、null は「不明」でなく「なし」
  return ["---", `status: ${v(f.status)}`, `waitingFor: ${f.waitingFor ?? "なし"}`, `permissionMode: ${v(f.permissionMode)}`, `offset: ${f.offset}`].join("\n") + "\n";
}
