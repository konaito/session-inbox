import { defineConfig } from "void/config";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ハブ（まとめ役の Worker）。自分の環境の値は hub/deploy.json（git には入れない。雛形は deploy.example.json）に書く
// 各 Mac のノード（Access のサービストークンで守った API）に問い合わせて1つの画面にまとめる
const cfg = JSON.parse(readFileSync(join(process.cwd(), "deploy.json"), "utf8")) as {
  name: string;
  account_id: string;
  domain: string;
  access_team_domain: string;
  access_aud: string;
  access_emails: string;
  parent_client_ids: string;
  nodes: { name: string; url: string }[];
};

export default defineConfig({
  cloudflare: {
    name: cfg.name,
    account_id: cfg.account_id,
    // 公開先は Access の裏にあるカスタムドメインだけにする
    workers_dev: false,
    preview_urls: false,
    routes: [{ pattern: cfg.domain, custom_domain: true }],
  },
  worker: {
    compatibility_date: "2026-02-24",
    vars: {
      NODES: JSON.stringify(cfg.nodes),
      ACCESS_TEAM_DOMAIN: cfg.access_team_domain,
      ACCESS_AUD: cfg.access_aud,
      ACCESS_EMAILS: cfg.access_emails,
      // 親エージェントとして通すサービストークンの client_id（カンマ区切り）。秘密ではない
      PARENT_CLIENT_IDS: cfg.parent_client_ids,
    },
  },
  routing: { alwaysUseHttps: true },
});
