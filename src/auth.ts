import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "./config.js";

/**
 * Dashboard password auth. Password seeds from DASH_PASSWORD env (authoritative on boot),
 * persists to dash_password file so a website change survives restart. A session cookie
 * (HttpOnly) gates /api/* (admin) and the dashboard SPA. /v1/* uses API_KEYS bearer
 * (separate), /health is open.
 */
const PW_FILE = path.join(config.root, "dash_password");

function readStored(): string {
  try { return fs.readFileSync(PW_FILE, "utf8").trim(); } catch { return ""; }
}

export class Auth {
  private password: string;
  private sessions = new Set<string>();
  enabled: boolean;

  constructor() {
    const env = (process.env.DASH_PASSWORD || "").trim();
    const stored = readStored();
    this.password = env || stored;
    if (env && env !== stored) {
      // env is authoritative on boot; persist it so website changes won't fight it unless re-set
      try { fs.writeFileSync(PW_FILE, env); } catch {}
      this.password = env;
    }
    this.enabled = this.password.length > 0;
  }

  /** Verify a password; on success mint a session token. */
  login(password: string): string | null {
    if (!this.enabled || password !== this.password) return null;
    const token = crypto.randomBytes(24).toString("hex");
    this.sessions.add(token);
    return token;
  }

  valid(token: string | undefined): boolean {
    return !!token && this.sessions.has(token);
  }

  logout(token: string | undefined) {
    if (token) this.sessions.delete(token);
  }

  changePassword(oldPw: string, newPw: string): { ok: boolean; error?: string } {
    if (!this.enabled) return { ok: true };
    if (oldPw !== this.password) return { ok: false, error: "current password incorrect" };
    if (!newPw || newPw.length < 4) return { ok: false, error: "new password too short" };
    this.password = newPw;
    this.enabled = true;
    this.sessions.clear();
    try { fs.writeFileSync(PW_FILE, newPw); } catch {}
    return { ok: true };
  }
}