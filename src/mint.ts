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

// locate the token-write inside the served bundle at runtime (survives Google pushes
// better than hardcoded line/col: we re-scan the actual served text every raid)
const RAID_ANCHOR_NOTE = "anchor: gp(xX.zc,yY);.m(z,5,yY) — searched inside the page at raid time";

export interface RaidHandle {
  line: number; col: number;
}

/** Fetch the main bundle text from inside the page and locate the _.m(p,5,r) anchor. */
export async function locateAnchor(cdp: Cdp): Promise<RaidHandle[]> {
  const expr = `
    (async () => {
      // prefer live <script> tags (performance buffer may have evicted the entry);
      // '/js/' discriminates the JS bundle from the /ss/ stylesheet that shares the m=_b suffix
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
  // search in node (we have the text in-page; pull a window around candidate matches)
  const findExpr = `
    (() => {
      const txt = window.__aisBundleText;
      const out = [];
      const re = /gp\\((\\w+)\\.zc,(\\w+)\\);\\w*\\.m\\((\\w),5,\\2\\)/g;
      let m;
      while ((m = re.exec(txt)) && out.length < 5) {
        const off = m.index;
        let line = 0, col = off;
        const nl = txt.lastIndexOf('\\n', off);
        if (nl === -1) col = off; else { line = (txt.slice(0, off).match(/\\n/g) || []).length; col = off - nl - 1; }
        out.push({ line, col, sample: m[0] });
      }
      return JSON.stringify(out);
    })()`;
  const r2 = await cdp.send("Runtime.evaluate", { expression: findExpr, returnByValue: true });
  const hits = JSON.parse(r2.result.value);
  if (!hits.length) throw new Error("raid anchor not found in bundle (Google update?)");
  return hits.map((h: any) => ({ line: h.line as number, col: h.col as number }));
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

/** Steal the oracle from a paused frame (must be called while Debugger is paused in Ezb). */
export const RAID_STEAL_ON_FRAME = `(() => {
  try {
    window.__raid = { xv: a.zc, gp: _.gp, Qv: _.Qv, Iu: _.Iu };
    window.__raidTokSample = (typeof r !== "undefined" && r) || (typeof U !== "undefined" && U) || (typeof g !== "undefined" && g) || null;
    return 'stolen';
  } catch (e) { return 'ERR:' + e.message; }
})()`;
