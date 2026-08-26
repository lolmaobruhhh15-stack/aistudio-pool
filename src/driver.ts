import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import net from "node:net";
import { Cdp, waitFor, type CdpEvent } from "./cdp.js";
import { parseGenerateContent, mergeChunks, type ParsedChunk } from "./parse.js";
import { findChrome, config } from "./config.js";

const NEW_CHAT = (model: string) => `https://aistudio.google.com/prompts/new_chat?model=${encodeURIComponent(model)}`;

export interface ChatResult {
  ok: boolean;
  error?: string;
  thinking: string;
  text: string;
  chunks: ParsedChunk[];
  durationMs: number;
  rawBody?: string;
}

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as any).port; s.close(() => res(p)); });
    s.on("error", rej);
  });
}

async function httpJson(port: number, p: string, method = "GET") {
  const r = await fetch(`http://localhost:${port}${p}`, { method: method as any });
  return r.json();
}

const RESET_STATE_JS = `
(() => {
  // close popups (surveys etc.)
  document.querySelectorAll('button').forEach(b => {
    const l = (b.getAttribute('aria-label') || '').toLowerCase();
    if (l === 'close' || l === 'dismiss') b.click();
  });
  // remove active tool chips (e.g. leftover "Grounding with Google Search")
  const chips = [...document.querySelectorAll('ms-chip, ms-trigger-chip')]
    .filter(c => (c.textContent || '').trim());
  for (const c of chips) {
    const x = c.querySelector('button[aria-label*="Remove"], .remove, [data-test-id*="remove"]') || c;
    x.click();
  }
  return chips.length;
})()`;

const INJECT_JS = (prompt: string) => `
(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let ta = null;
  for (let i = 0; i < 80; i++) { ta = document.querySelector('textarea'); if (ta) break; await sleep(500); }
  if (!ta) return JSON.stringify({ ok: false, err: 'NO_TEXTAREA' });
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, ${JSON.stringify(prompt)});
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(700);
  const btns = [...document.querySelectorAll('button')];
  const run = document.querySelector('button.run-button:not([disabled])')
    || btns.find(b => (b.getAttribute('aria-label') || '').trim().toLowerCase() === 'run' && !b.disabled)
    || btns.find(b => /^(run|send)/i.test((b.getAttribute('aria-label') || '').trim())
        && !/close|panel|settings/i.test(b.getAttribute('aria-label') || '') && !b.disabled);
  if (run) { run.click(); return JSON.stringify({ ok: true, via: 'button' }); }
  ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
  return JSON.stringify({ ok: true, via: 'ctrl-enter' });
})()`;

export class AisDriver {
  name: string;
  port: number;
  private cdp = new Cdp();
  private proc: ChildProcess | null = null;
  private detached = false;
  private wsUrl = "";
  private genCalls = new Map<string, { url: string; startedAt: number }>();
  private bodies = new Map<string, { url: string; body: string }>();
  private unsub: (() => void) | null = null;

  private constructor(name: string, port: number) { this.name = name; this.port = port; }

  /** Attach to an already-running Chrome with CDP enabled. */
  static async attach(port: number, name = "attached"): Promise<AisDriver> {
    const d = new AisDriver(name, port);
    await waitFor(async () => { try { await httpJson(port, "/json/version"); return true; } catch { return false; } }, 5_000, "cdp http");
    d.detached = true;
    await d.init();
    return d;
  }

  /** Launch a dedicated Chrome instance for an account profile. */
  static async launch(opts: { name: string; headless?: boolean; port?: number }): Promise<AisDriver> {
    const port = opts.port ?? await freePort();
    const profile = path.join(config.accountsDir, opts.name, "profile");
    fs.mkdirSync(profile, { recursive: true });
    const chrome = findChrome();
    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "--no-first-run", "--no-default-browser-check",
      "--disable-blink-features=AutomationControlled",
      "--disable-session-crashed-bubble", "--hide-crash-restore-bubble",
      // keep parked tabs alive: no background throttling / freezing
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-features=IntensiveWakeUpThrottling,CalculateNativeWinOcclusion",
    ];
    if (opts.headless) args.push("--headless=new", "--disable-gpu");
    else args.push("--window-size=1366,900", "--window-position=0,0");
    args.push("about:blank");
    const proc = spawn(chrome, args, { detached: false, stdio: "ignore" });
    const d = new AisDriver(opts.name, port);
    d.proc = proc;
    await waitFor(async () => { try { await httpJson(port, "/json/version"); return true; } catch { return false; } }, 20_000, "chrome start");
    await d.init();
    return d;
  }

  private async init() {
    const targets = await Cdp.listTargets(this.port);
    let page = targets.find((t: any) => t.type === "page" && t.url.includes("aistudio.google.com"));
    if (!page) {
      await fetch(`http://localhost:${this.port}/json/new?about:blank`, { method: "PUT" }).catch(() => {});
      const again = await Cdp.listTargets(this.port);
      page = again.find((t: any) => t.type === "page" && t.url.includes("aistudio.google.com"))
          ?? again.find((t: any) => t.type === "page");
    }
    this.wsUrl = page.webSocketDebuggerUrl;
    await this.connect();
  }

  private async connect() {
    this.unsub?.();
    this.cdp.close();
    this.cdp = new Cdp();
    await this.cdp.connect(this.wsUrl);
    this.unsub = this.cdp.onEvent(ev => this.onNetEvent(ev));
    // wake a possibly-frozen background tab before issuing renderer commands
    await this.cdp.send("Page.bringToFront").catch(() => {});
    await this.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
    await this.cdp.send("Network.enable", { maxPostDataSize: 8 * 1024 * 1024 }, 60_000);
    await this.cdp.send("Page.enable");
    await this.cdp.send("Runtime.enable");
  }

  /** Reconnect if the websocket dropped (Chrome may close idle/devtool-argled sessions). */
  private async ensureConnected() {
    if (this.cdp.isConnected) return;
    let page: any;
    try {
      const targets = await Cdp.listTargets(this.port);
      page = targets.find((t: any) => t.type === "page" && t.url.includes("aistudio.google.com"))
           ?? targets.find((t: any) => t.type === "page" && (t.webSocketDebuggerUrl || "").includes(this.wsUrl.split("/").pop() || "###"));
      if (!page) throw new Error("tab gone");
      this.wsUrl = page.webSocketDebuggerUrl;
    } catch {
      throw new Error("chrome not reachable on port " + this.port);
    }
    await this.connect();
  }

  private onNetEvent(ev: CdpEvent) {
    const p = ev.params;
    if (ev.method === "Network.requestWillBeSent") {
      const url: string = p.request?.url || "";
      if (p.request?.method === "POST" && url.includes("/GenerateContent")) {
        this.genCalls.set(p.requestId, { url, startedAt: Date.now() });
      }
    } else if (ev.method === "Network.loadingFinished" && this.genCalls.has(p.requestId)) {
      const info = this.genCalls.get(p.requestId)!;
      this.genCalls.delete(p.requestId);
      this.cdp.send("Network.getResponseBody", { requestId: p.requestId })
        .then((r: any) => {
          const body = r.base64 ? Buffer.from(r.body, "base64").toString("utf-8") : r.body;
          this.bodies.set(info.url, { url: info.url, body });
        })
        .catch(() => {});
    }
  }

  async navigate(url: string) {
    await this.cdp.send("Page.navigate", { url });
  }

  async isLoggedIn(): Promise<boolean> {
    try {
      await this.ensureConnected();
      const r = await this.cdp.send("Storage.getCookies");
      const cookies = r.cookies || [];
      return cookies.some((c: any) => c.name === "SAPISID" && (c.domain || "").endsWith("google.com"))
          && cookies.some((c: any) => c.name === "__Secure-1PSID" || c.name === "SID");
    } catch { return false; }
  }

  async hasTextarea(timeoutMs = 20_000): Promise<boolean> {
    try {
      await this.evalJs(`!!document.querySelector('textarea')`, timeoutMs, true);
      return true;
    } catch { return false; }
  }

  private async evalJs(expr: string, timeoutMs = 30_000, awaitPromise = false): Promise<any> {
    const r = await this.cdp.send("Runtime.evaluate", {
      expression: expr, awaitPromise, returnByValue: true,
    }, timeoutMs + 5_000);
    if (r.exceptionDetails) throw new Error("page js: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result?.value;
  }

  /** Run one chat turn in a fresh chat. Serial per driver (one page). */
  async chat(prompt: string, model = config.defaultModel, signal?: AbortSignal): Promise<ChatResult> {
    await this.ensureConnected();
    const t0 = Date.now();
    this.bodies.clear();
    await this.navigate(NEW_CHAT(model));
    // wait for the app to be ready to accept input
    const ready = await this.hasTextarea(30_000);
    if (!ready) throw new Error("AI Studio page never showed a prompt textarea (not logged in? bot check?)");
    await this.evalJs(RESET_STATE_JS, 15_000).catch(() => {});
    const trigRaw = await this.evalJs(INJECT_JS(prompt), 60_000, true);
    let trig: any = {};
    try { trig = JSON.parse(trigRaw); } catch {}
    if (!trig?.ok) throw new Error("inject failed: " + (trig?.err || trigRaw));
    // wait for the GenerateContent response to finish
    const deadline = Date.now() + config.chatTimeoutMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error("aborted");
      if (this.bodies.size > 0) break;
      await new Promise(r => setTimeout(r, 300));
    }
    if (this.bodies.size === 0) throw new Error("no GenerateContent response captured (timeout)");
    const entry = [...this.bodies.values()][0];
    // Google-side RPC errors arrive as [,[code,"message"]] — surface them as chat errors
    const raw = entry.body;
    if (/^\[,\[\d+,/.test(raw.trim())) {
      const m = raw.match(/\[(\d+),"([^"]{0,300})/);
      const code = m ? Number(m[1]) : -1;
      const msg = m ? m[2] : raw.slice(0, 200);
      if (code === 8 || /quota|RESOURCE_EXHAUSTED/i.test(msg)) throw new Error("RESOURCE_EXHAUSTED: " + msg);
      if (code === 7) throw new Error("PERMISSION_DENIED: " + msg);
      throw new Error("RPC_ERROR_" + code + ": " + msg);
    }
    const chunks = parseGenerateContent(raw);
    const merged = mergeChunks(chunks);
    return { ok: true, thinking: merged.thinking, text: merged.text, chunks, durationMs: Date.now() - t0, rawBody: raw };
  }

  get isAlive(): boolean { return this.cdp.isConnected; }

  async close() {
    this.unsub?.();
    this.cdp.close();
    if (this.proc) { try { this.proc.kill(); } catch {} }
  }
}
