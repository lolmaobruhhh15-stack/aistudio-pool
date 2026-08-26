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
    const messages = body.messages || [];
    if (!messages.length) return reply.code(400).send({ error: { message: "messages required" } });
    const prompt = transcript(messages);
    const id = "chatcmpl-" + crypto.randomBytes(12).toString("hex");
    const created = Math.floor(Date.now() / 1000);
    const t0 = Date.now();

    let result;
    try {
      result = await pool.chat(prompt, model);
    } catch (err: any) {
      pushLog({ t: t0, model, account: "-", ms: Date.now() - t0, ok: false, error: String(err?.message || err), stream: !!body.stream, promptPreview: prompt.slice(0, 120) });
      return reply.code(502).send({ error: { message: String(err?.message || err) } });
    }
    pushLog({ t: t0, model, account: result.account, ms: result.durationMs, ok: true, stream: !!body.stream, promptPreview: prompt.slice(0, 120) });

    if (!body.stream) {
      return {
        id, object: "chat.completion", created, model,
        choices: [{ index: 0, message: { role: "assistant", content: result.text, reasoning_content: result.thinking || undefined }, finish_reason: "stop" }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        _account: result.account,
      };
    }
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream", "cache-control": "no-cache",
      connection: "keep-alive", "x-accel-buffering": "no",
    });
    const sse = (obj: any) => reply.raw.write(`data: ${JSON.stringify(obj)}\n\n`);
    const chunk = (delta: any) => ({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: null }] });
    sse(chunk({ role: "assistant" }));
    for (const c of result.chunks) {
      if (c.kind === "thinking" && c.text) sse(chunk({ reasoning_content: c.text }));
      else if (c.kind === "text" && c.text) sse(chunk({ content: c.text }));
    }
    sse({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    reply.raw.write("data: [DONE]\n\n");
    reply.raw.end();
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
    const { name } = req.body as any;
    if (!name) return { error: "name required" };
    const acc = await pool.addAccount(name);
    return { ok: true, account: acc.info(), note: "headed Chrome launched — sign into Google in that window, then POST /api/accounts/" + acc.name + "/refresh" };
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
