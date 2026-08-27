/**
 * Per-account mint oracle (Exp A/B results, 2026-08-26):
 *  - token = pageBotGuard.gp(xv, sha256(allTextParts.join(" ")))   -> proto field 5
 *  - binding: contents (+ page's selected model); everything else free
 *  - send raw from Node with cookie jar + SAPISIDHASH — no TLS constraint
 */
import crypto from "node:crypto";
import type { Cdp } from "./cdp.js";

export function contentHash(texts: string[]): string {
  return crypto.createHash("sha256").update(texts.join(" ")).digest("hex");
}

// locate the token-write inside the served bundle at runtime, NAME-AGNOSTIC so it
// survives Google's minified renames (observed rotations: gp->ip, a.zc->a.I, b_b->RZb).
// The stable fingerprint is: token = yield _.<MINTFN>(<svc>.<field>, token); then the
// proto field-5 write _.m(<proto>, 5, token). We capture the actual names each raid.
export interface RaidHandle {
  line: number; col: number;
  mintFn: string;   // e.g. "gp" or "ip"
  svc: string;      // controller var, e.g. "a"
  svcField: string; // field on controller holding the BotGuard service, e.g. "zc" / "I"
}

/** Fetch the main bundle text inside the page and locate every mint-site with its real names. */
export async function locateAnchor(cdp: Cdp): Promise<RaidHandle[]> {
  const expr = `
    (async () => {
      const urls = [...document.scripts].map(s => s.src).filter(u => u && u.includes('/js/') && /[?&/]m=_b\\b/.test(u));
      const perf = performance.getEntriesByType('resource').map(r => r.name)
        .filter(u => u.includes('/js/') && /[?&/]m=_b\\b/.test(u));
      const url = urls[urls.length - 1] || perf[perf.length - 1];
      if (!url) return JSON.stringify({ err: 'no bundle url' });
      const txt = await (await fetch(url)).text();
      window.__aisBundleText = txt; window.__aisBundleUrl = url;
      return JSON.stringify({ url, len: txt.length });
    })()`;
  const r = await cdp.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, 45_000);
  const info = JSON.parse(r.result.value);
  if (info.err) throw new Error(info.err);
  // search in the fetched text (in-page), capturing mint-fn + service + token-var names
  const findExpr = `
    (() => {
      const txt = window.__aisBundleText;
      const out = [];
      const re = /yield\\s+_\\.([\\\\w$]{1,8})\\(\\s*(\\\\w+)\\s*\\.\\s*(\\\\w+),\\s*(\\\\w+)\\s*\\)\\s*;\\s*_\\.m\\((\\\\w+),\\s*5\\s*,\\s*\\{\\{TOKREV\\}\\}\\)/g;
      // build once with a numeric backref: use a two-pass scan instead to avoid
      // esbuild/string escaping of \\N inside template literals
      return re;
    })()`;
  // Do the scan in Node on the fetched text to avoid nested-regex escaping pain:
  // pull the text down first by a one-off eval, then re-run a real Node regex.
  const textExpr = `window.__aisBundleText`;
  const tRes = await cdp.send("Runtime.evaluate", { expression: textExpr, returnByValue: true }, 20_000);
  const txt: string = tRes.result.value || "";
  const hits: RaidHandle[] = [];
  // mint call: yield _.MINTFN(SVC.field, TOKEN); ... _.m(PROTO, 5, TOKEN)
  const re = /yield\s+_\.([\w$]{1,8})\(\s*(\w+)\s*\.\s*(\w+)\s*,\s*(\w+)\s*\)\s*;\s*_\.m\(\s*(\w+)\s*,\s*5\s*,\s*(\w+)\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(txt)) && hits.length < 8) {
    const mintFn = m[1], svc = m[2], svcField = m[3], tokenVar = m[4], proto = m[5], written = m[6];
    if (tokenVar !== written) continue;      // token must be the same var written into field 5
    const off = m.index + m[0].lastIndexOf("yield");
    let line = 0, col = off;
    const nl = txt.lastIndexOf("\n", off);
    if (nl === -1) col = off; else { line = (txt.slice(0, off).match(/\n/g) || []).length; col = off - nl - 1; }
    hits.push({ line, col, mintFn, svc, svcField });
  }
  if (!hits.length) throw new Error("raid anchor not found in bundle (Google update?)");
  return hits;
}

export const RAID_HOOK_SETUP = `(() => {
  if (window.__gcHookInstalled) return 'already';
  window.__gcHookInstalled = true; window.__gcLog = [];
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(m, u) { this.__gcUrl = String(u); return origOpen.apply(this, arguments); };
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function(body) {
    try { if ((this.__gcUrl||'').includes('GenerateContent') && typeof body === 'string')
      window.__gcLog.push({t: Date.now(), body}); } catch(e) {}
    return origSend.apply(this, arguments);
  };
  return 'hooked';
})()`;

export function uiInjectJs(prompt: string): string {
  return `
(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let ta = null;
  for (let i = 0; i < 60; i++) { ta = document.querySelector('textarea'); if (ta) break; await sleep(500); }
  if (!ta) return JSON.stringify({ ok: false, err: 'NO_TEXTAREA' });
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, ${JSON.stringify(prompt)});
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(600);
  const btns = [...document.querySelectorAll('button')];
  const run = document.querySelector('button.run-button:not([disabled])')
    || btns.find(b => (b.getAttribute('aria-label') || '').trim().toLowerCase() === 'run' && !b.disabled);
  if (run) { run.click(); return JSON.stringify({ ok: true, via: 'button' }); }
  ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
  return JSON.stringify({ ok: true, via: 'ctrl-enter' });
})()`;
}

/** Evaluate the mint against the raided oracle. */
export async function mintWithOracle(cdp: Cdp, hex: string): Promise<string> {
  const expr = `
    (async () => {
      const R = window.__raid;
      if (!R || !R.xv || !R.xv.A) return JSON.stringify({ err: 'no_oracle' });
      try {
        const tok = await R.gp(R.xv, ${JSON.stringify(hex)});
        return JSON.stringify({ ok: true, tok: String(tok) });
      } catch (e) { return JSON.stringify({ err: String(e).slice(0, 200) }); }
    })()`;
  const r = await cdp.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, 30_000);
  const res = JSON.parse(r.result.value);
  if (!res.ok) throw new Error("mint failed: " + res.err);
  return res.tok;
}

export function hasOracleExpr(): string {
  return `!!(window.__raid && window.__raid.xv && window.__raid.xv.A && window.__raid.gp)`;
}

/** Build a steal expression for the SPECIFIC names captured at this mint site. */
export function stealExpr(h: { svc: string; svcField: string; mintFn: string }): string {
  return `(() => {
    try {
      window.__raid = { xv: ${h.svc}.${h.svcField}, gp: _.${h.mintFn} };
      return 'stolen';
    } catch (e) { return 'ERR:' + e.message; }
  })()`;
}
