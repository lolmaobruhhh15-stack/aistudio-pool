import { AisDriver, type ChatResult } from "./driver.js";
import { config, ensureAccountsDir } from "./config.js";
import fs from "node:fs";
import path from "node:path";

export type AccountState = "starting" | "idle" | "busy" | "cooldown" | "error" | "logged_out" | "paused";

export interface AccountStats {
  requests: number; errors: number; lastUsed?: number; lastError?: string;
  quotaUntil?: number; avgMs?: number; totalMs?: number;
}

export class Account {
  driver: AisDriver | null = null;
  state: AccountState = "starting";
  stats: AccountStats = { requests: 0, errors: 0 };

  constructor(public name: string) {}

  info() {
    return {
      name: this.name,
      state: this.state,
      stats: this.stats,
      alive: this.driver?.isAlive ?? false,
    };
  }
}

export class AccountPool {
  accounts: Account[] = [];
  private waiters: Array<() => void> = [];

  async loadFromDir(headless = true) {
    ensureAccountsDir();
    const entries = fs.readdirSync(config.accountsDir, { withFileTypes: true })
      .filter(e => e.isDirectory());
    for (const e of entries) {
      const acc = new Account(e.name);
      this.accounts.push(acc);
      this.startDriver(acc, headless).catch(err => {
        acc.state = "error";
        acc.stats.lastError = String(err);
      });
    }
  }

  async startDriver(acc: Account, headless: boolean) {
    acc.state = "starting";
    const drv = await AisDriver.launch({ name: acc.name, headless });
    acc.driver = drv;
    await drv.navigate("https://aistudio.google.com/prompts/new_chat");
    const ok = await drv.isLoggedIn();
    if (!ok) { acc.state = "logged_out"; return; }
    await drv.hasTextarea(20_000).catch(() => {});
    acc.state = "idle";
  }

  /** Launch a fresh account slot in HEADED mode so the user can sign in manually. */
  async addAccount(name: string): Promise<Account> {
    const safe = name.replace(/[^a-zA-Z0-9_-]/g, "_");
    const acc = new Account(safe);
    this.accounts.push(acc);
    this.startDriver(acc, false).catch(err => { acc.state = "error"; acc.stats.lastError = String(err); });
    return acc;
  }

  /** Close an account's browser and drop it from the pool (profile dir is kept). */
  async removeAccount(name: string): Promise<boolean> {
    const i = this.accounts.findIndex(a => a.name === name);
    if (i === -1) return false;
    const acc = this.accounts[i];
    if (acc.state === "busy") return false;
    try { await acc.driver?.close(); } catch {}
    this.accounts.splice(i, 1);
    return true;
  }

  private pickIdle(): Account | null {
    const now = Date.now();
    const ready = this.accounts.filter(a =>
      a.state === "idle" ||
      (a.state === "cooldown" && (a.stats.quotaUntil ?? 0) < now));
    if (!ready.length) return null;
    ready.sort((a, b) => (a.stats.lastUsed ?? 0) - (b.stats.lastUsed ?? 0));
    return ready[0];
  }

  private async acquire(timeoutMs = 60_000): Promise<Account> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const acc = this.pickIdle();
      if (acc) { acc.state = "busy"; return acc; }
      if (Date.now() > deadline) throw new Error("no available account (all busy/cooldown)");
      await new Promise(r => setTimeout(r, 500));
    }
  }

  private release(acc: Account) {
    if (acc.state === "busy") acc.state = "idle";
    const w = this.waiters.shift(); w?.();
  }

  /** v2 path: real messages + streaming; falls back to legacy UI transcript if the oracle can't bootstrap. */
  async chatMessages(
    messages: Array<{ role: string; content: string }>,
    model: string,
    opts: { temperature?: number; topP?: number; maxTokens?: number; thinkingLevel?: number } = {},
    onChunks?: (chunks: any[]) => void,
  ): Promise<{ text: string; thinking: string; durationMs: number; account: string; via: string }> {
    const acc = await this.acquire();
    const t0 = Date.now();
    try {
      let result;
      let via = "v2";
      try {
        result = await acc.driver!.chatV2(messages, model, opts, onChunks);
      } catch (err: any) {
        const msg = String(err?.message || err);
        if (/raid|oracle|anchor|breakpoint|PERMISSION_DENIED/i.test(msg)) {
          if (process.env.AIS_DEBUG) console.log(`[pool] v2 failed for ${acc.name}, falling back legacy: ${msg}`);
          via = "legacy";
          result = await acc.driver!.chat(transcript(messages), model);
          if (onChunks) onChunks(result.chunks);
        } else throw err;
      }
      acc.stats.requests++;
      acc.stats.totalMs = (acc.stats.totalMs ?? 0) + result.durationMs;
      acc.stats.avgMs = Math.round(acc.stats.totalMs / acc.stats.requests);
      this.release(acc);
      return { text: result.text, thinking: result.thinking, durationMs: result.durationMs, account: acc.name, via };
    } catch (err: any) {
      acc.stats.errors++;
      acc.stats.lastError = String(err?.message || err);
      const msg = String(err?.message || err);
      if (/RESOURCE_EXHAUSTED|quota|429/i.test(msg)) {
        acc.state = "cooldown";
        acc.stats.quotaUntil = Date.now() + 10 * 60_000;
      } else if (/not logged in|textarea|bot check|PERMISSION_DENIED/i.test(msg)) {
        acc.state = "logged_out";
      } else {
        this.release(acc);
      }
      throw err;
    } finally {
      acc.stats.lastUsed = t0;
    }
  }

  async chat(prompt: string, model: string, signal?: AbortSignal): Promise<ChatResult & { account: string }> {
    const acc = await this.acquire();
    const t0 = Date.now();
    try {
      const res = await acc.driver!.chat(prompt, model, signal);
      acc.stats.requests++;
      acc.stats.totalMs = (acc.stats.totalMs ?? 0) + res.durationMs;
      acc.stats.avgMs = Math.round(acc.stats.totalMs / acc.stats.requests);
      this.release(acc);
      return { ...res, account: acc.name };
    } catch (err: any) {
      acc.stats.errors++;
      acc.stats.lastError = String(err?.message || err);
      const msg = String(err?.message || err);
      if (/RESOURCE_EXHAUSTED|quota|429/i.test(msg)) {
        acc.state = "cooldown";
        acc.stats.quotaUntil = Date.now() + 10 * 60_000;
      } else if (/not logged in|textarea|bot check/i.test(msg)) {
        acc.state = "logged_out";
      } else {
        this.release(acc);
      }
      throw err;
    } finally {
      acc.stats.lastUsed = t0;
    }
  }
}

/** Build a single transcript prompt from OpenAI-style messages. */
export function transcript(messages: Array<{ role: string; content: any }>): string {
  const texts = messages.map(m => {
    const c = typeof m.content === "string" ? m.content
      : Array.isArray(m.content) ? m.content.map((p: any) => p?.text ?? "").join("\n")
      : String(m.content ?? "");
    return { role: m.role, text: c };
  }).filter(m => m.text.trim().length);
  if (texts.length === 1 && texts[0].role === "user") return texts[0].text;
  return texts.map(m => {
    const label = m.role === "assistant" ? "Model" : m.role === "system" ? "System" : "User";
    return `[${label}]\n${m.text}`;
  }).join("\n\n") + "\n\n[User]\n(continue)";
}
