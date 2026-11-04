// 送った文と、そのときの transcript の offset を sessionId ごとに残す（~/.config/session-inbox/sends.json）
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR } from "./client";

export type SendRecord = { offset: number; text: string; at: string };
const FILE = join(CONFIG_DIR, "sends.json");
const KEEP = 50;

function load(): Record<string, SendRecord> {
  try {
    return JSON.parse(readFileSync(FILE, "utf8"));
  } catch {
    return {};
  }
}

export function recordSend(sessionId: string, rec: SendRecord): void {
  const all = load();
  all[sessionId] = rec;
  // 古いものから落として KEEP 件までにする
  const entries = Object.entries(all).sort((a, b) => a[1].at.localeCompare(b[1].at)).slice(-KEEP);
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(FILE, JSON.stringify(Object.fromEntries(entries), null, 2) + "\n", { mode: 0o600 });
}

export function lastSend(sessionId: string): SendRecord | null {
  return load()[sessionId] ?? null;
}
