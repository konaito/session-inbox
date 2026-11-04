// 各 Mac のノードへの問い合わせ。Access のサービストークンと合言葉の両方を付ける
export type NodeEnv = {
  NODES: string;
  CF_ACCESS_CLIENT_ID: string;
  CF_ACCESS_CLIENT_SECRET: string;
  NODE_TOKEN: string;
};
export type Node = { name: string; url: string };

export function nodes(env: NodeEnv): Node[] {
  const list = JSON.parse(env.NODES) as Node[];
  if (!Array.isArray(list) || !list.length) throw new Error("NODES is empty");
  return list;
}

export function nodeFetch(env: NodeEnv, node: Node, path: string, init: RequestInit = {}, timeoutMs = 5000) {
  if (!env.CF_ACCESS_CLIENT_ID || !env.CF_ACCESS_CLIENT_SECRET || !env.NODE_TOKEN) throw new Error("node credentials are not set");
  return fetch(node.url + path, {
    ...init,
    redirect: "manual", // Access に弾かれたときのログイン画面への転送を、成功と取り違えない
    headers: {
      ...(init.headers as Record<string, string> | undefined),
      "CF-Access-Client-Id": env.CF_ACCESS_CLIENT_ID,
      "CF-Access-Client-Secret": env.CF_ACCESS_CLIENT_SECRET,
      "x-node-token": env.NODE_TOKEN,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
}

export function pick(env: NodeEnv, machine: string | undefined) {
  const node = nodes(env).find((n) => n.name === machine);
  if (!node) throw Object.assign(new Error(`unknown machine: ${machine}`), { status: 400 });
  return node;
}
