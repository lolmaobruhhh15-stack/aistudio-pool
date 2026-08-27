import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import net from "node:net";
import { Cdp, waitFor, type CdpEvent } from "./cdp.js";
import { parseGenerateContent, parseFrame, mergeChunks, FrameSplitter, type ParsedChunk } from "./parse.js";
import {
  contentHash, locateAnchor, mintWithOracle, hasOracleExpr,
  RAID_HOOK_SETUP, RAID_STEAL_ON_FRAME, uiInjectJs,
} from "./mint.js";
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

const RPC_URL = "https://alkalimakersuite-pa.clients6.google.com/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/GenerateContent";
const SAFETY = [[null, null, 7, 5], [null, null, 8, 5], [null, null, 9, 5], [null, null, 10, 5]];

export interface ChatMessage { role: string; content: string }
export interface GenOpts {
  temperature?: number; topP?: number; maxTokens?: number; thinkingLevel?: number;
}

function buildBody(model: string, messages: ChatMessage[], token: string, opts: GenOpts, timezone: string): any[] {
  const turns = messages
    .filter(m => m.content?.trim() && m.role !== "system")
    .map(m => [[[null, m.content]], m.role === "assistant" ? "model" : "user"]);
  const sys = messages.filter(m => m.role === "system").map(m => m.content).join("\n\n");
  if (sys) turns.unshift([[[null, "[System instructions]\n" + sys]], "user"]);
  const thinkingTail = opts.thinkingLevel ?? (model.includes("pro") ? 3 : 2);
  return [
    `models/${model}`,
    turns,
    SAFETY,
    [null, null, null,
      opts.maxTokens ?? 65536, opts.temperature ?? 1, opts.topP ?? 0.95, 64,
      null, null, null, null, null, null, 1,
      null, null,
      [1, null, null, thinkingTail],
    ],
    token,
    null,
    [[null, null, null, [null, [[]]]]],
    null, null, null,
    1, null, null,
    [[null, null, timezone]],
  ];
}

function authFrom(cookies: any[], origin = "https://aistudio.google.com"): { cookie: string; authorization: string } {
  const cookie = cookies
    .filter(c => (c.domain || "").endsWith("google.com"))
    .map(c => `${c.name}=${c.value}`).join("; ");
  const sapisid = cookies.find(c => c.name === "SAPISID" && (c.domain || "") === ".google.com")?.value;
  if (!sapisid) throw new Error("no SAPISID cookie — account not signed in");
  const ts = Math.floor(Date.now() / 1000);
  const h = crypto.createHash("sha1").update(`${ts} ${sapisid} ${origin}`).digest("hex");
  return { cookie, authorization: `SAPISIDHASH ${ts}_${h} SAPISID1PHASH ${ts}_${h} SAPISID3PHASH ${ts}_${h}` };
}

const RESET_STATE_JS = `(() => {
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

  /** UI-driven chat (legacy fallback path). Run one chat turn in a fresh chat. */
  async chat(prompt: string, model = config.defaultModel, signal?: AbortSignal): Promise<ChatResult> {
    await this.ensureConnected();
    const t0 = Date.now();
    this.bodies.clear();
    await this.navigate(NEW_CHAT(model));
    // wait for the app to be ready to accept input
    const ready = await this.hasTextarea(30_000);
    if (!ready) throw new Error("AI Studio page never showed a prompt textarea (not logged in? bot check?)");
    await this.evalJs(RESET_STATE_JS, 15_000).catch(() => {});
    const trigRaw = await this.evalJs(uiInjectJs(prompt), 60_000, true);
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

  // ---------------- v2: mint-oracle + raw-HTTP path ----------------

  private oracleModel: string | null = null;

  /** True if the raided mint oracle is alive in the page for this model. */
  private async oracleAlive(model: string): Promise<boolean> {
    if (this.oracleModel !== model) return false;
    try {
      const r = await this.cdp.send("Runtime.evaluate", { expression: hasOracleExpr(), returnByValue: true }, 10_000);
      return r.result?.value === true;
    } catch { return false; }
  }

  /**
   * Bootstrap the mint oracle for a model: park the page on new_chat?model=..., then
   * breakpoint-raid one UI probe chat to steal {xv, gp} into window.__raid.
   */
  async ensureOracle(model: string): Promise<void> {
    const dbg = process.env.AIS_DEBUG ? (m: string) => console.log(`[oracle:${this.name}] ${m}`) : () => {};
    await this.ensureConnected();
    if (await this.oracleAlive(model)) { dbg("alive"); return; }

    const onPage = await this.evalJs(
      `location.search.includes('model=' + ${JSON.stringify(model)}) || location.pathname !== '/prompts/new_chat' ? location.href : ''`,
      10_000).catch(() => "");
    const url: string = onPage || "";
    if (!url.includes(encodeURIComponent(model)) && !url.includes(model)) {
      dbg("navigating to fresh new_chat for " + model);
      await this.navigate(NEW_CHAT(model));
      await waitFor(async () => !!(await this.hasTextarea(15_000).catch(() => false)), 25_000, "page load");
      await new Promise(r => setTimeout(r, 4000));
    } else dbg("staying on " + url.slice(0, 70));

    // breakpoint at the token-write; the regex anchor is found from the LIVE bundle text
    await this.cdp.send("Debugger.enable", { maxScriptsCacheSize: 1_000_000_000 }).catch(() => {});
    let anchor: { line: number; col: number }[] | null = null;
    for (let i = 0; i < 3; i++) {
      try { anchor = await locateAnchor(this.cdp); break; }
      catch (e: any) {
        dbg("locateAnchor try " + i + ": " + String(e?.message || e).slice(0, 80));
        if (i === 2 || !/collected|context|timeout|no bundle url/i.test(String(e?.message || e))) throw e;
        await new Promise(r => setTimeout(r, 2000));
      }
    }
    if (!anchor) throw new Error("raid anchor not found (bundle updated?)");
    dbg(`anchors: ${anchor.map(a => a.line + ":" + a.col).join(" | ")}`);
    const bps: Array<{ id: string; loc: any }> = [];
    for (const a of anchor) {
      const bp = await this.cdp.send("Debugger.setBreakpointByUrl", {
        lineNumber: a.line, columnNumber: a.col,
        urlRegex: "gstatic\\.com/.*m=_b",
      }, 15_000).catch(() => null);
      if (bp?.locations?.length) bps.push({ id: bp.breakpointId, loc: bp.locations[0] });
    }
    if (!bps.length) throw new Error("raid anchor not resolved (bundle updated?)");
    dbg("breakpoints set: " + bps.length);

    await this.evalJs(RAID_HOOK_SETUP, 10_000).catch(() => {});
    await this.evalJs(RESET_STATE_JS, 10_000).catch(() => {});

    // fire probe chat; pause event will arrive asynchronously
    const probe = "Reply with exactly ORACLE_BOOT_" + Math.floor(Math.random() * 9000 + 1000) + " and nothing else.";
    const pauseP = this.waitPause(90_000);
    // NOTE: do NOT await the probe's evaluate — the breakpoint pauses the page mid-eval
    this.evalJs(uiInjectJs(probe), 5_000, true).catch(e => dbg("probe eval: " + String(e).slice(0, 80)));
    const paused = await pauseP;
    dbg("paused, frames=" + paused.callFrames.length);

    // steal from the paused frame
    const steal = await this.cdp.send("Debugger.evaluateOnCallFrame", {
      callFrameId: paused.callFrames[0].callFrameId,
      expression: RAID_STEAL_ON_FRAME, returnByValue: true,
    }, 15_000).catch(() => null);
    const stolen = steal?.result?.value === "stolen";
    dbg("steal: " + (stolen ? "ok" : JSON.stringify(steal)?.slice(0, 120)));
    for (const b of bps) await this.cdp.send("Debugger.removeBreakpoint", { breakpointId: b.id }).catch(() => {});
    await this.cdp.send("Debugger.resume").catch(() => {});
    await this.cdp.send("Debugger.disable").catch(() => {});
    if (!stolen) throw new Error("raid failed: could not steal oracle from frame");

    // drain the probe's own GenerateContent capture so it can't confuse legacy paths
    this.bodies.clear();
    // wait for the probe chat to complete (interpreter warms up during the first page-driven chat)
    dbg("waiting for probe to complete...");
    await waitFor(async () => {
      try {
        const v = await this.evalJs("location.pathname.includes('/prompts/') && !location.pathname.includes('/new_chat')", 5_000);
        return v === true;
      } catch { return false; }
    }, 60_000, "probe completion").catch(() => dbg("probe completion wait timed out"));
    this.oracleModel = model;
  }

  private waitPause(timeoutMs: number): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error("raid timeout: breakpoint never hit")); }, timeoutMs);
      const onEvent = (ev: CdpEvent) => {
        if (ev.method === "Debugger.paused") {
          cleanup();
          resolve(ev.params);
        }
      };
      const cleanup = () => {
        clearTimeout(timer);
        // listener removal: our Cdp has no remove; harmless to leave (resolves once)
      };
      this.cdp.onEvent(onEvent);
    });
  }

  /**
   * Harvest the browser's live UA + client hints so raw-send headers match the
   * context that minted the token (Chrome auto-updates break hardcoded values).
   */
  async clientHeaders(): Promise<Record<string, string>> {
    const expr = `(async () => {
      const ua = navigator.userAgent;
      let h = {};
      try { h = await navigator.userAgentData.getHighEntropyValues(["architecture","bitness","formFactors","model","platform","platformVersion","fullVersionList","wow64"]); } catch {}
      const brands = (navigator.userAgentData?.brands || []).map(b => '"' + b.brand + '";v="' + b.version + '"').join(', ');
      const fvl = (h.fullVersionList || []).map(b => '"' + b.brand + '";v="' + b.version + '"').join(', ');
      return JSON.stringify({
        ua,
        chUA: brands,
        chMobile: navigator.userAgentData?.mobile ? "?0" : "?0",
        chPlatform: '"' + ((h.platform) || '') + '"',
        chArch: '"' + ((h.architecture) || '') + '"',
        chBitness: '"' + ((h.bitness) || '') + '"',
        chFVL: fvl,
        chModel: '""',
        chPlatformVersion: '"' + ((h.platformVersion) || '') + '"',
        chWow64: h.wow64 ? "?0" : "?0",
        chFormFactors: (h.formFactors || []).join(','),
      });
    })()`;
    const raw = await this.evalJs(expr, 15_000, true).catch(() => null);
    if (!raw) return {};
    try {
      const d = JSON.parse(raw);
      const out: Record<string, string> = {
        "User-Agent": d.ua,
        "sec-ch-ua": d.chUA,
        "sec-ch-ua-mobile": d.chMobile,
        "sec-ch-ua-platform": d.chPlatform,
        "sec-ch-ua-arch": d.chArch,
        "sec-ch-ua-bitness": d.chBitness,
        "sec-ch-ua-full-version-list": d.chFVL,
        "sec-ch-ua-model": d.chModel,
        "sec-ch-ua-platform-version": d.chPlatformVersion,
        "sec-ch-ua-wow64": d.chWow64,
        "sec-ch-ua-form-factors": d.chFormFactors,
      };
      return out;
    } catch { return {}; }
  }

  /**
   * v2 chat: mint token for arbitrary messages, raw-HTTP send, TRUE streaming.
   * onChunks fires per network chunk as frames complete.
   */
  async chatV2(
    messages: ChatMessage[],
    model = config.defaultModel,
    opts: GenOpts = {},
    onChunks?: (chunks: ParsedChunk[]) => void,
  ): Promise<ChatResult> {
    await this.ensureOracle(model);
    const t0 = Date.now();

    const sys = messages.filter(m => m.role === "system").map(m => m.content).join("\n\n");
    const turns: ChatMessage[] = messages
      .filter(m => m.content?.trim() && m.role !== "system")
      .map(m => ({ role: m.role, content: m.content }));
    if (sys) turns.unshift({ role: "user", content: "[System instructions]\n" + sys });

    const hex = contentHash(turns.map(t => t.content));
    // interpreter refreshes on tab visibility; make sure the page is frontmost before minting
    try { await this.cdp.send("Page.bringToFront", {}, 5_000); } catch {}
    await new Promise(r => setTimeout(r, 800));
    const token = await mintWithOracle(this.cdp, hex);

    const cookies = (await this.cdp.send("Storage.getCookies", {}, 15_000)).cookies || [];
    const { cookie, authorization } = authFrom(cookies);
    const tz = await this.evalJs("Intl.DateTimeFormat().resolvedOptions().timeZone", 10_000).catch(() => "UTC");
    const body = JSON.stringify(buildBody(model, turns, token, opts, String(tz)));
    const ch = await this.clientHeaders();

    const res = await fetch(RPC_URL, {
      method: "POST",
      headers: {
        "Authorization": authorization,
        "Content-Type": "application/json+protobuf",
        "X-Goog-Api-Key": "AIzaSyDdP816MREB3SkjZO04QXbjsigfcI0GWOs",
        "X-Goog-AuthUser": "0",
        "X-Goog-Ext-519733851-bin": "CAESAUwwATgEQABQBGICQkRwAXgB",
        "X-User-Agent": "grpc-web-javascript/0.1",
        "Origin": "https://aistudio.google.com",
        "Referer": "https://aistudio.google.com/",
        "Cookie": cookie,
        ...ch,
      },
      body,
    });

    if (!res.ok) {
      const errText = (await res.text()).slice(0, 300);
      const m = errText.match(/\[(\d+),"([^"]{0,200})/);
      const code = m ? Number(m[1]) : res.status;
      const msg = m ? m[2] : errText;
      if (code === 8 || /quota|RESOURCE_EXHAUSTED/i.test(msg)) throw new Error("RESOURCE_EXHAUSTED: " + msg);
      if (code === 7) { this.oracleModel = null; throw new Error("PERMISSION_DENIED: " + msg); }
      throw new Error(`RPC_ERROR_${code}: ` + msg);
    }

    const splitter = new FrameSplitter();
    const chunks: ParsedChunk[] = [];
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const frameChunks of splitter.push(dec.decode(value, { stream: true }))) {
        chunks.push(...frameChunks);
        onChunks?.(frameChunks);
      }
    }
    for (const frameChunks of splitter.push("")) {
      chunks.push(...frameChunks);
      onChunks?.(frameChunks);
    }
    const merged = mergeChunks(chunks);
    return { ok: true, thinking: merged.thinking, text: merged.text, chunks, durationMs: Date.now() - t0 };
  }

  get isAlive(): boolean { return this.cdp.isConnected; }

  async close() {
    this.unsub?.();
    this.cdp.close();
    if (this.proc) { try { this.proc.kill(); } catch {} }
  }
}
