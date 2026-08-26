import path from "node:path";
import fs from "node:fs";

const ROOT = path.resolve(import.meta.dirname, "..");

export const config = {
  root: ROOT,
  port: Number(process.env.PORT || 8787),
  chromePaths: [
    process.env.CHROME_PATH,
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    path.join(process.env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe"),
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean) as string[],
  accountsDir: process.env.ACCOUNTS_DIR || path.join(ROOT, "accounts"),
  apiKeys: (process.env.API_KEYS || "").split(",").map(s => s.trim()).filter(Boolean),
  chatTimeoutMs: Number(process.env.CHAT_TIMEOUT_MS || 180_000),
  defaultModel: process.env.DEFAULT_MODEL || "gemini-3.1-pro-preview",
};

export function findChrome(): string {
  for (const p of config.chromePaths) if (p && fs.existsSync(p)) return p;
  throw new Error("Chrome not found; set CHROME_PATH");
}

export function ensureAccountsDir() {
  fs.mkdirSync(config.accountsDir, { recursive: true });
}
