// 子セッションを tmux で立てる手順。別の Mac なら ssh <マシン名> で、この Mac なら直接
// ssh のホスト名はノードのマシン名と同じにしてある前提（~/.ssh/config で合わせる）
export const REMOTE_PATH = "export PATH=$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH";
const SAFE = /^[A-Za-z0-9._\/~-]+$/; // シェルに渡すので、空白や ; は通さない

export type SpawnPlan = { remote: boolean; start: string; trust: string; pwd: string; stop: string };

export function spawnPlan(o: { machine: string; dir: string; name: string; localHost: string }): SpawnPlan {
  for (const [k, v] of Object.entries({ machine: o.machine, dir: o.dir, name: o.name })) {
    if (!SAFE.test(v)) throw new Error(`${k} に使えない文字がある: ${v}`);
  }
  const remote = o.machine !== o.localHost;
  // tmux の中でも claude が見つかるように PATH を通す
  const inner = `${REMOTE_PATH}; claude --dangerously-skip-permissions`;
  const script = (body: string) => (remote ? `ssh ${o.machine} ${JSON.stringify(`${REMOTE_PATH}; ${body}`)}` : `${REMOTE_PATH}; ${body}`);
  return {
    remote,
    start: script(`mkdir -p ${o.dir} && tmux new -d -s ${o.name} -c ${o.dir} ${JSON.stringify(inner)}`),
    // 初めてのディレクトリは「信頼するか」の確認が出る。出ていれば「Yes, I trust this folder」を選ぶ
    trust: script(`tmux capture-pane -p -t ${o.name} | grep -q 'trust this folder' && tmux send-keys -t ${o.name} Down Enter; true`),
    pwd: script(`mkdir -p ${o.dir} && cd ${o.dir} && pwd`),
    stop: script(`tmux kill-session -t ${o.name}`),
  };
}

export async function sh(cmd: string): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(["bash", "-c", cmd], { stdout: "pipe", stderr: "pipe" });
  const out = (await new Response(p.stdout).text()) + (await new Response(p.stderr).text());
  return { code: await p.exited, out: out.trim() };
}
