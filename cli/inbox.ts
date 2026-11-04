// 親の Claude Code が、別の Mac の子セッションを読み、文を送り、返事を読むための CLI
// 使い方: inbox list | show <対象> | send <対象> <文|-> [--as <名前>] | read <対象> [--since <n>] [--wait <秒>] [--all] | run <対象> <文> [--wait <秒>]
//        inbox spawn <マシン> <dir> [--name <tmux名>] | stop <マシン> <tmux名> | wait <対象>... [--wait <秒>]
import { getSummary, listSessions, loadClient, sendText, type Client, type Session } from "./lib/client";
import { resolveTarget } from "./lib/resolve";
import { renderFooter, renderItems, renderList, renderSummary } from "./lib/render";
import { apiFor, readLoop, startOffset, waitAll } from "./lib/read";
import { lastSend, recordSend } from "./lib/sends";
import { spawnPlan, sh } from "./lib/spawn";
import { agentName } from "./lib/identity";
import { hostname } from "node:os";

type Opts = { hub?: string; as?: string; since?: number; wait?: number; all: boolean; machine?: string; name?: string; args: string[] };

export function parseArgs(argv: string[]): Opts {
  const o: Opts = { all: false, args: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} に値が要る`);
      return v;
    };
    if (a === "--hub") o.hub = next();
    else if (a === "--as") o.as = next();
    else if (a === "--since") o.since = Number(next());
    else if (a === "--wait") o.wait = Number(next());
    else if (a === "--machine") o.machine = next();
    else if (a === "--name") o.name = next();
    else if (a === "--all") o.all = true;
    else if (a.startsWith("--")) throw new Error(`知らないオプション ${a}`);
    else o.args.push(a);
  }
  return o;
}

async function resolve(c: Client, target: string): Promise<Session> {
  const { sessions } = await listSessions(c);
  const r = resolveTarget(sessions, target);
  if (r.ok) return r.session;
  if (r.reason === "ambiguous") {
    throw new Error(`「${target}」は複数ある。<マシン>/<名前> か sessionId で指定する:\n${r.candidates.map((s) => `  ${s.machine}/${s.name}  ${s.sessionId}`).join("\n")}`);
  }
  throw new Error(`「${target}」に当たるセッションが無い。inbox list で確かめる`);
}

// この Mac のマシン名。手元のノード（127.0.0.1:4321）が名乗る名前を使い、無ければホスト名
async function localMachine(): Promise<string> {
  try {
    const r = await fetch(`http://127.0.0.1:${process.env.INBOX_LOCAL_PORT ?? 4321}/api/sessions`, { headers: { "x-cc-inject": "1" }, signal: AbortSignal.timeout(1500) });
    const j = (await r.json()) as { machines?: { name: string }[] };
    if (j.machines?.[0]?.name) return j.machines[0].name;
  } catch {}
  return hostname().replace(/\.local$/, "");
}

// spawn: tmux で claude を立て、信頼確認に答え、一覧に出るまで待って <マシン>/<名前> を返す。stop: その tmux を消す
async function spawnOrStop(c: Client, cmd: "spawn" | "stop", machine: string, o: Opts): Promise<number> {
  const dirOrName = o.args[2];
  if (!dirOrName) throw new Error(cmd === "spawn" ? "spawn には <マシン> <dir> が要る" : "stop には <マシン> <tmux名> が要る");
  const localHost = await localMachine();
  if (cmd === "stop") {
    const r = await sh(spawnPlan({ machine, dir: "~", name: dirOrName, localHost }).stop);
    console.log(r.code === 0 ? `止めた: ${machine} の tmux ${dirOrName}` : `止められなかった: ${r.out}`);
    return r.code === 0 ? 0 : 1;
  }
  const name = o.name ?? `child-${dirOrName.replace(/\/+$/, "").split("/").pop()}`;
  const plan = spawnPlan({ machine, dir: dirOrName, name, localHost });
  const abs = await sh(plan.pwd);
  if (abs.code !== 0) throw new Error(`${machine} の ${dirOrName} に入れない: ${abs.out}`);
  const started = await sh(plan.start);
  if (started.code !== 0) throw new Error(`tmux を立てられなかった: ${started.out}`);
  await Bun.sleep(6000);
  await sh(plan.trust);
  // 一覧に出るまで最大 40 秒待つ。cwd で見分ける
  for (let i = 0; i < 20; i++) {
    await Bun.sleep(2000);
    const { sessions } = await listSessions(c);
    const s = sessions.find((x) => x.machine === machine && x.cwd === abs.out);
    if (s) {
      console.log(`${machine}/${s.name}  ${s.sessionId}  tmux=${name}  cwd=${abs.out}`);
      return 0;
    }
  }
  throw new Error(`立てたが一覧に出てこない。ssh ${machine} で tmux attach -t ${name} を見る`);
}

async function main(argv: string[]): Promise<number> {
  const o = parseArgs(argv);
  const [cmd, target] = o.args;
  if (!cmd || cmd === "help" || cmd === "--help") {
    console.log("使い方: inbox list | show <対象> | send <対象> <文|-> [--as <名前>] | read <対象> [--since <n>] [--wait <秒>] [--all] | run <対象> <文> [--wait <秒>]\n       inbox spawn <マシン> <dir> [--name <tmux名>] | stop <マシン> <tmux名> | wait <対象>... [--wait <秒>]\n対象は sessionId、その先頭 8 文字以上、<マシン>/<名前>、<名前>。--hub <URL> で手元のノードに向ける（試験専用）");
    return cmd ? 0 : 1;
  }
  const c = loadClient({ hub: o.hub });
  if (cmd === "list") {
    const r = await listSessions(c);
    process.stdout.write(renderList(r.sessions, r.machines));
    return 0;
  }
  if (!target) throw new Error(`${cmd} には対象が要る`);
  if (cmd === "spawn" || cmd === "stop") return await spawnOrStop(c, cmd, target, o);
  // wait: 送ってある複数の子を同時に待ち、子ごとに返事と生の状態を出す。終了コードはいちばん大きいもの
  if (cmd === "wait") {
    const { sessions } = await listSessions(c);
    const targets = o.args.slice(1).map((t) => {
      const r = resolveTarget(sessions, t);
      if (!r.ok) throw new Error(r.reason === "ambiguous" ? `「${t}」は複数ある。<マシン>/<名前> で指定する` : `「${t}」に当たるセッションが無い`);
      const rec = lastSend(r.session.sessionId);
      return { label: `${r.session.machine}/${r.session.name}`, api: apiFor(c, r.session), since: rec?.offset ?? 0, sentText: rec?.text ?? null };
    });
    const results = await waitAll(targets, o.wait ?? 600);
    for (const r of results) {
      process.stdout.write(`\n# ${r.label}\n\n`);
      process.stdout.write(renderItems(r.items, o.all));
      process.stdout.write(`${r.stop.reason}（終了コード ${r.stop.code}）\n`);
      process.stdout.write(renderFooter({ status: r.last.status ?? (r.last.status === undefined ? "exited" : null), waitingFor: r.last.waitingFor, permissionMode: r.permissionMode, offset: r.offset }));
    }
    return Math.max(0, ...results.map((r) => r.stop.code));
  }
  if (cmd === "show") {
    // 終了したセッションは一覧に無いので、sessionId 全文と --machine で直接読む
    if (o.machine && /^[0-9a-f-]{36}$/.test(target)) {
      process.stdout.write(renderSummary(await getSummary(c, { machine: o.machine, sessionId: target }), null));
      return 0;
    }
    const s = await resolve(c, target);
    process.stdout.write(renderSummary(await getSummary(c, s), s));
    return 0;
  }
  const s = await resolve(c, target);
  const readText = async (arg: string | undefined) => {
    const t = arg === "-" ? await Bun.stdin.text() : arg ?? "";
    if (!t.trim()) throw new Error("送る文が空");
    return t.trim();
  };
  // send: 応答の offset（書く直前の transcript の長さ）を sends.json に残す
  const send = async (text: string) => {
    // 名乗る名前は <このマシン>/<自分の sessionId 先頭8文字>/<役割>。--as は役割だけ
    const as = agentName({ machine: await localMachine(), sessionId: process.env.CLAUDE_CODE_SESSION_ID, label: o.as });
    const r = await sendText(c, s, text, as);
    // transcript がまだ無く offset が無いときも記録する（先頭から読めば送った文に当たる）
    recordSend(s.sessionId, { offset: startOffset(r.offset), text, at: new Date().toISOString() });
    return r;
  };
  // read: 項目のあとに生の status と offset を必ず付ける。終了コードは判定の結果
  const read = async (since: number, sentText: string | null) => {
    const r = await readLoop(apiFor(c, s), { since, sentText, waitSec: o.wait ?? 120 });
    process.stdout.write(renderItems(r.items, o.all));
    process.stdout.write(`${r.stop.reason}\n`);
    process.stdout.write(renderFooter({ status: r.last.status ?? (r.last.status === undefined ? "exited" : null), waitingFor: r.last.waitingFor, permissionMode: r.permissionMode, offset: r.offset }));
    return r.stop.code;
  };
  if (cmd === "send") {
    const r = await send(await readText(o.args[2]));
    console.log(`送った。pid ${r.pid}、status ${r.status ?? "不明"}、offset ${r.offset ?? "不明"}`);
    return 0;
  }
  if (cmd === "read") {
    const rec = lastSend(s.sessionId);
    const since = o.since ?? rec?.offset ?? (await getSummary(c, s)).offset;
    return read(since, o.since === undefined && rec ? rec.text : null);
  }
  if (cmd === "run") {
    const text = await readText(o.args[2]);
    const r = await send(text);
    return read(startOffset(r.offset), text);
  }
  throw new Error(`知らないコマンド ${cmd}`);
}

if (import.meta.main) {
  main(Bun.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(String(e instanceof Error ? e.message : e));
      process.exit(1);
    },
  );
}
