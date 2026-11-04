// ノードが自分の Mac に子セッション（tmux の中の claude）を立てる、止めるための部品
// 画面と CLI は、ハブ経由で POST /api/sessions/spawn と /api/sessions/<id>/stop を呼ぶ
import { homedir } from "node:os";

const SAFE = /^[A-Za-z0-9._\/~-]+$/; // シェルに渡すので、空白や ; は通さない
const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
// tmux の中でも claude が見つかるように PATH を通す
export const CHILD_PATH = "export PATH=$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH";

export type SpawnArgs = { cwd: string; name: string; command: string; tmux: string[] };

export function spawnArgs(o: { dir: string; name?: string; home?: string }): SpawnArgs {
  const home = o.home ?? homedir();
  if (!SAFE.test(o.dir)) throw new Error(`dir に使えない文字がある: ${o.dir}`);
  const cwd = o.dir === "~" ? home : o.dir.startsWith("~/") ? home + o.dir.slice(1) : o.dir;
  if (!cwd.startsWith("/")) throw new Error(`dir は絶対パスか ~ から始める: ${o.dir}`);
  const name = o.name ?? `child-${cwd.replace(/\/+$/, "").split("/").pop() || "home"}`;
  if (!NAME_RE.test(name)) throw new Error(`name に使えない文字がある: ${name}`);
  const command = `${CHILD_PATH}; claude --dangerously-skip-permissions`;
  return { cwd, name, command, tmux: ["tmux", "new", "-d", "-s", name, "-c", cwd, command] };
}

// 初めてのディレクトリで出る「信頼するか」の確認。画面にこの文があれば「Yes, I trust this folder」を選ぶ
export function trustPromptAnswered(screen: string): boolean {
  return /trust this folder/.test(screen);
}

export function stopTarget(row: { pid?: unknown }): number {
  const pid = row.pid;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) throw new Error("pid が無い");
  return pid;
}

async function run(cmd: string[]): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", env: { ...process.env, PATH: `${process.env.HOME}/.local/bin:${process.env.HOME}/.bun/bin:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ""}` } });
  const out = (await new Response(p.stdout).text()) + (await new Response(p.stderr).text());
  return { code: await p.exited, out: out.trim() };
}

// tmux を立てて、少し待ってから信頼確認に答える。答えは待たずに戻る
export async function spawnChild(o: { dir: string; name?: string }): Promise<{ cwd: string; name: string }> {
  const a = spawnArgs(o);
  const mk = await run(["mkdir", "-p", a.cwd]);
  if (mk.code !== 0) throw new Error(`mkdir: ${mk.out}`);
  const r = await run(a.tmux);
  if (r.code !== 0) throw new Error(`tmux: ${r.out}`);
  // 6 秒後に画面を見て、信頼確認が出ていれば答える（失敗しても放っておく）
  setTimeout(async () => {
    const cap = await run(["tmux", "capture-pane", "-p", "-t", a.name]).catch(() => ({ code: 1, out: "" }));
    if (cap.code === 0 && trustPromptAnswered(cap.out)) await run(["tmux", "send-keys", "-t", a.name, "Down", "Enter"]).catch(() => {});
  }, 6000);
  return { cwd: a.cwd, name: a.name };
}

export function stopProcess(pid: number): void {
  process.kill(pid, "SIGTERM");
}
