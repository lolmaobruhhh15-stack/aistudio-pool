import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { AccountPool, transcript } from "./pool.js";
import { config } from "./config.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const MODELS = [
  "gemini-3.1-pro-preview", "gemini-3.1-flash-preview", "gemini-3-pro-preview",
  "gemini-3-flash-preview", "gemini-3.7-flash", "gemini-2.5-pro", "gemini-2.5-flash",
];

// browser pane toggle: OFF by default (normal local CDP + headed login windows).
// ON = cloud/embedded mode: the in-website screenshot/click browser pane serves logins.
let localBrowserPaneEnabled = (process.env.BROWSER_PANE || "").toLowerCase() === "1";
const browserPaneEnabled = () => localBrowserPaneEnabled;

export interface LogEntry {
  t: number; model: string; account: string; ms: number;
  ok: boolean; error?: string; stream: boolean; promptPreview: string;
}

export async function buildServer(pool: AccountPool) {
  const app = Fastify({ logger: false, bodyLimit: 4 * 1024 * 1024 });
  await app.register(cors, {});

  const log: LogEntry[] = [];
  const pushLog = (e: LogEntry) => { log.push(e); if (log.length > 300) log.shift(); };

  const requireKey = async (req: any, reply: any) => {
    if (!config.apiKeys.length) return;
    const auth = req.headers["authorization"] || "";
    const key = auth.replace(/^Bearer\s+/i, "").trim() || (req.query as any)?.key;
    if (!config.apiKeys.includes(key)) reply.code(401).send({ error: { message: "invalid api key" } });
  };

  app.get("/health", async () => ({ ok: true, accounts: pool.accounts.length }));

  app.get("/v1/models", { preHandler: requireKey }, async () => ({
    object: "list",
    data: MODELS.map(id => ({ id, object: "model", created: 1700000000, owned_by: "aistudio-pool" })),
  }));

  app.post("/v1/chat/completions", { preHandler: requireKey }, async (req, reply) => {
    const body = req.body as any;
    const model = (body.model || config.defaultModel).replace(/^.*\//, "");
    const messages: Array<{ role: string; content: string }> = ((body.messages || []) as any[]).map((m: any) => ({
      role: m.role === "assistant" ? "assistant" : m.role === "system" ? "system" : "user",
      content: typeof m.content === "string" ? m.content
        : Array.isArray(m.content) ? m.content.map((p: any) => p?.text ?? "").join("\n") : String(m.content ?? ""),
    })).filter(m => m.content.length);
    if (!messages.length) return reply.code(400).send({ error: { message: "messages required" } });
    const id = "chatcmpl-" + crypto.randomBytes(12).toString("hex");
    const created = Math.floor(Date.now() / 1000);
    const t0 = Date.now();
    const opts = {
      temperature: body.temperature,
      topP: body.top_p,
      maxTokens: body.max_tokens,
    };

    let result;
    try {
      if (body.stream) {
        reply.raw.writeHead(200, {
          "content-type": "text/event-stream", "cache-control": "no-cache",
          connection: "keep-alive", "x-accel-buffering": "no",
        });
        const sse = (obj: any) => reply.raw.write(`data: ${JSON.stringify(obj)}\n\n`);
        const chunk = (delta: any) => ({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: null }] });
        sse(chunk({ role: "assistant" }));
        let accName = "-", via = "-";
        try {
          result = await pool.chatMessages(messages, model, opts, (chunks) => {
            for (const c of chunks) {
              if (c.kind === "thinking" && c.text) sse(chunk({ reasoning_content: c.text }));
              else if (c.kind === "text" && c.text) sse(chunk({ content: c.text }));
            }
          });
          accName = result.account; via = result.via;
        } catch (err: any) {
          pushLog({ t: t0, model, account: "-", ms: Date.now() - t0, ok: false, error: String(err?.message || err), stream: true, promptPreview: messages[messages.length - 1]?.content.slice(0, 120) });
          sse(chunk({ content: "\n[pool error] " + String(err?.message || err) }));
        }
        sse({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], _account: accName, _via: via });
        reply.raw.write("data: [DONE]\n\n");
        reply.raw.end();
        if (result) pushLog({ t: t0, model, account: result.account, ms: result.durationMs, ok: true, stream: true, promptPreview: messages[messages.length - 1]?.content.slice(0, 120) });
        return;
      }
      result = await pool.chatMessages(messages, model, opts);
    } catch (err: any) {
      pushLog({ t: t0, model, account: "-", ms: Date.now() - t0, ok: false, error: String(err?.message || err), stream: false, promptPreview: messages[messages.length - 1]?.content.slice(0, 120) });
      return reply.code(502).send({ error: { message: String(err?.message || err) } });
    }
    pushLog({ t: t0, model, account: result.account, ms: result.durationMs, ok: true, stream: false, promptPreview: messages[messages.length - 1]?.content.slice(0, 120) });
    return {
      id, object: "chat.completion", created, model,
      choices: [{ index: 0, message: { role: "assistant", content: result.text, reasoning_content: result.thinking || undefined }, finish_reason: "stop" }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      _account: result.account, _via: result.via,
    };
  });

  // ---- admin / dashboard ----
  app.get("/api/accounts", async () => ({ accounts: pool.accounts.map(a => a.info()) }));

  app.get("/api/log", async () => ({ log: log.slice().reverse() }));

  app.get("/api/stats", async () => {
    const accs = pool.accounts.map(a => a.info());
    return {
      accounts: accs.length,
      idle: accs.filter(a => a.state === "idle").length,
      busy: accs.filter(a => a.state === "busy").length,
      requests: accs.reduce((s, a) => s + a.stats.requests, 0),
      errors: accs.reduce((s, a) => s + a.stats.errors, 0),
      avgMs: Math.round(accs.reduce((s, a) => s + (a.stats.avgMs ?? 0), 0) / Math.max(1, accs.filter(a => a.stats.avgMs).length)),
    };
  });

  app.post("/api/accounts", async (req) => {
    const { name, cookies, mode } = req.body as any;
    if (!name) return { error: "name required" };
    if (cookies) {
      // cookie-paste import: launch headless (no login UI needed), inject cookies, verify
      const acc = await pool.addAccountHeadless(name);
      await new Promise(r => setTimeout(r, 4000)); // let the browser come up
      try {
        const n = await acc.driver!.importCookies(cookies);
        acc.state = (await acc.driver!.isLoggedIn()) ? "idle" : "logged_out";
        return { ok: true, account: acc.info(), importedCookies: n };
      } catch (e: any) {
        acc.state = "error"; acc.stats.lastError = String(e?.message || e);
        return { ok: false, error: String(e?.message || e) };
      }
    }
    const acc = await pool.addAccount(name);
    return { ok: true, account: acc.info(), note: "headed Chrome launched — sign into Google in that window, then POST /api/accounts/" + acc.name + "/refresh" };
  });

  // cookie export: dump an account's Google cookies as paste-ready JSON
  app.get("/api/accounts/:name/export", async (req) => {
    const acc = pool.findAccount((req.params as any).name);
    if (!acc?.driver) return { error: "not found" };
    try {
      const cookies = await acc.driver.exportCookies();
      return { ok: true, account: acc.name, count: cookies.length, cookies };
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) };
    }
  });

  app.post("/api/accounts/:name/import", async (req) => {
    const acc = pool.findAccount((req.params as any).name);
    if (!acc?.driver) return { error: "not found" };
    const cookies = (req.body as any)?.cookies;
    if (!Array.isArray(cookies) || !cookies.length) return { error: "cookies array required" };
    try {
      const n = await acc.driver.importCookies(cookies);
      acc.state = (await acc.driver.isLoggedIn()) ? "idle" : "logged_out";
      return { ok: true, account: acc.name, imported: n, state: acc.state };
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) };
    }
  });

  // ---- manual browser panel (glm2api-style, no VNC) ----
  app.get("/api/browser/:name/screenshot", async (req, reply) => {
    const acc = pool.findAccount((req.params as any).name);
    if (!acc?.driver || !browserPaneEnabled()) return reply.code(404).send({ error: "no browser pane" });
    const img = await acc.driver.screenshot();
    return reply.type("image/jpeg").send(Buffer.from(img, "base64"));
  });

  app.post("/api/browser/:name/click", async (req) => {
    const acc = pool.findAccount((req.params as any).name);
    if (!acc?.driver || !browserPaneEnabled()) return { error: "no browser pane" };
    const { x, y } = req.body as any;
    await acc.driver.mouseClick(Number(x), Number(y));
    return { ok: true };
  });

  app.post("/api/browser/:name/type", async (req) => {
    const acc = pool.findAccount((req.params as any).name);
    if (!acc?.driver || !browserPaneEnabled()) return { error: "no browser pane" };
    const { text } = req.body as any;
    await acc.driver.typeText(String(text ?? ""));
    return { ok: true };
  });

  app.post("/api/browser/:name/key", async (req) => {
    const acc = pool.findAccount((req.params as any).name);
    if (!acc?.driver || !browserPaneEnabled()) return { error: "no browser pane" };
    const { key } = req.body as any;
    await acc.driver.keyPress(String(key ?? ""));
    return { ok: true };
  });

  app.post("/api/browser/:name/drag", async (req) => {
    const acc = pool.findAccount((req.params as any).name);
    if (!acc?.driver || !browserPaneEnabled()) return { error: "no browser pane" };
    const { x1, y1, x2, y2 } = req.body as any;
    await acc.driver.drag(Number(x1), Number(y1), Number(x2), Number(y2));
    return { ok: true };
  });

  // ---- browser-pane toggle (cloud embedded browser) ----
  app.get("/api/settings/browser-pane", async () => ({ enabled: browserPaneEnabled() }));
  app.post("/api/settings/browser-pane", async (req) => {
    const on = Boolean((req.body as any)?.on);
    localBrowserPaneEnabled = on;
    return { enabled: on, note: on ? "embedded browser pane ON (cloud mode)" : "embedded browser pane OFF (normal local CDP)" };
  });

  app.post("/api/accounts/:name/refresh", async (req) => {
    const acc = pool.accounts.find(a => a.name === (req.params as any).name);
    if (!acc?.driver) return { error: "not found" };
    const ok = await acc.driver.isLoggedIn();
    if (ok && (acc.state === "logged_out" || acc.state === "starting")) acc.state = "idle";
    return { ok, state: acc.state };
  });

  app.post("/api/accounts/:name/pause", async (req) => {
    const acc = pool.accounts.find(a => a.name === (req.params as any).name);
    if (acc) { acc.state = acc.state === "paused" ? "idle" : "paused"; }
    return acc?.info() ?? { error: "not found" };
  });

  app.delete("/api/accounts/:name", async (req, reply) => {
    const name = (req.params as any).name;
    if (name === "main") return reply.code(400).send({ error: "cannot remove attached main account" });
    const ok = await pool.removeAccount(name);
    if (!ok) return reply.code(409).send({ error: "not found or busy" });
    return { ok: true };
  });

  // static dashboard (web/dist) — registered last so /api and /v1 win
  const dist = path.join(config.root, "web", "dist");
  if (fs.existsSync(dist)) {
    await app.register(fastifyStatic, { root: dist });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api") || req.url.startsWith("/v1")) return reply.code(404).send({ error: "not found" });
      reply.sendFile("index.html");
    });
  }

  return app;
}
