import { AisDriver } from "./driver.js";
import { AccountPool } from "./pool.js";
import { buildServer } from "./api.js";
import { config, ensureAccountsDir } from "./config.js";

const args = process.argv.slice(2);
const attachIdx = args.indexOf("--attach");
const smoke = args.includes("--smoke");

async function smokeTest(port: number) {
  console.log(`[smoke] attaching to CDP :${port} ...`);
  const drv = await AisDriver.attach(port, "smoke");
  const loggedIn = await drv.isLoggedIn();
  console.log("[smoke] logged in:", loggedIn);
  const model = config.defaultModel;
  const marker = "SMOKE_OK_" + Math.floor(1000 + Math.random() * 9000);
  console.log(`[smoke] chatting via ${model} (marker ${marker}) ...`);
  const res = await drv.chat(
    `Reply with exactly ${marker}, then one short dolphin fact. Keep it under 40 words total.`,
    model,
  );
  console.log(`[smoke] done in ${res.durationMs}ms via ${res.chunks.length} chunks`);
  console.log("[smoke] RAW[:700]:", JSON.stringify((res.rawBody || "").slice(0, 700)));
  console.log("[smoke] THINKING:", JSON.stringify(res.thinking.slice(0, 200)));
  console.log("[smoke] TEXT:", JSON.stringify(res.text));
  const pass = res.text.includes(marker);
  console.log("[smoke]", pass ? "PASS ✓" : "FAIL ✗ (marker missing)");
  process.exit(pass ? 0 : 1);
}

async function serve() {
  ensureAccountsDir();
  const pool = new AccountPool();
  const headless = (process.env.HEADED || "").toLowerCase() !== "1";
  await pool.loadFromDir(headless);
  if (process.env.ATTACH_PORT) {
    const { Account } = await import("./pool.js");
    const name = process.env.ATTACH_NAME || "main";
    const drv = await AisDriver.attach(Number(process.env.ATTACH_PORT), name);
    const acc = new Account(name);
    acc.driver = drv;
    acc.state = (await drv.isLoggedIn()) ? "idle" : "logged_out";
    pool.accounts.push(acc);
    console.log(`attached account '${name}' via CDP :${process.env.ATTACH_PORT} (${acc.state})`);
  }
  const app = await buildServer(pool);
  await app.listen({ port: config.port, host: "0.0.0.0" });
  console.log(`aistudio-pool listening on :${config.port} (${pool.accounts.length} accounts, headless=${headless})`);
  console.log(`  POST /v1/chat/completions | GET /v1/models | GET /api/accounts | POST /api/accounts {"name":"acc1"}`);
}

if (smoke) {
  await smokeTest(attachIdx >= 0 ? Number(args[attachIdx + 1]) : 9222);
} else {
  await serve();
}
