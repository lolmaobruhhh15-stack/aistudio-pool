import React, { useEffect, useRef, useState } from "react";

// ---------- types & api ----------
interface Acc { name: string; state: string; alive: boolean; stats: { requests: number; errors: number; lastUsed?: number; lastError?: string; avgMs?: number; quotaUntil?: number } }
interface LogEntry { t: number; model: string; account: string; ms: number; ok: boolean; error?: string; stream: boolean; promptPreview: string }
interface Stats { accounts: number; idle: number; busy: number; requests: number; errors: number; avgMs: number }

const j = async (url: string, init?: RequestInit) => (await fetch(url, init)).json();

const STATE_COLORS: Record<string, string> = {
  idle: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  busy: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  cooldown: "bg-orange-500/15 text-orange-400 border-orange-500/30",
  error: "bg-rose-500/15 text-rose-400 border-rose-500/30",
  logged_out: "bg-slate-500/15 text-slate-400 border-slate-500/30",
  paused: "bg-violet-500/15 text-violet-400 border-violet-500/30",
  starting: "bg-sky-500/15 text-sky-400 border-sky-500/30",
};

const rel = (t?: number) => !t ? "—" : `${Math.max(0, Math.round((Date.now() - t) / 1000))}s ago`;

// ---------- shell ----------
export default function App() {
  const [tab, setTab] = useState<"accounts" | "play" | "log">("accounts");
  const [stats, setStats] = useState<Stats | null>(null);
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [authRequired, setAuthRequired] = useState(false);
  const [pw, setPw] = useState("");
  const [pwErr, setPwErr] = useState("");
  useEffect(() => {
    j("/api/auth/check").then(d => { setAuthed(d.authed); setAuthRequired(d.authRequired); }).catch(() => setAuthed(false));
  }, []);
  useEffect(() => {
    if (!authed) return;
    const tick = () => j("/api/stats").then(setStats).catch(r => { if (r?.status === 401) setAuthed(false); });
    tick(); const iv = setInterval(tick, 2500); return () => clearInterval(iv);
  }, [authed]);

  const login = async () => {
    setPwErr("");
    const res = await fetch("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: pw }) });
    if (res.ok) { setAuthed(true); setPw(""); }
    else { const d = await res.json().catch(() => ({})); setPwErr(d.error || "login failed"); }
  };

  if (authed === false) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-white/[0.03] p-6 space-y-4">
          <div className="text-lg font-semibold bg-gradient-to-r from-indigo-400 to-violet-400 bg-clip-text text-transparent">AI Studio Pool</div>
          <div className="text-xs text-slate-500">Enter the dashboard password to continue.</div>
          <input type="password" value={pw} onChange={e => setPw(e.target.value)}
            onKeyDown={e => e.key === "Enter" && login()}
            placeholder="password"
            className="w-full bg-black/30 border border-white/10 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-indigo-500/50" />
          {pwErr && <div className="text-xs text-rose-400">{pwErr}</div>}
          <button onClick={login} className="w-full py-2.5 rounded-xl bg-indigo-500 hover:bg-indigo-400 text-sm font-medium text-white transition">Sign in</button>
        </div>
      </div>
    );
  }

  const tabs = [
    { id: "accounts", label: "Accounts", icon: "▦" },
    { id: "play", label: "Playground", icon: "◈" },
    { id: "log", label: "Log", icon: "≡" },
  ] as const;

  return (
    <div className="min-h-screen flex flex-col md:flex-row max-w-6xl mx-auto">
      {/* sidebar (desktop) */}
      <aside className="hidden md:flex flex-col gap-1 p-4 w-56 shrink-0">
        <div className="px-3 py-4 mb-2">
          <div className="text-lg font-semibold bg-gradient-to-r from-indigo-400 to-violet-400 bg-clip-text text-transparent">AI Studio Pool</div>
          <div className="text-xs text-slate-500 mt-0.5">OpenAI-compatible gateway</div>
        </div>
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`text-left px-3 py-2.5 rounded-xl text-sm transition ${tab === t.id ? "bg-indigo-500/15 text-indigo-300" : "text-slate-400 hover:bg-white/5"}`}>
            <span className="mr-2">{t.icon}</span>{t.label}
          </button>
        ))}
        <AuthControls onLogout={() => setAuthed(false)} />
        <StatsBar stats={stats} className="mt-auto" />
      </aside>

      {/* header (mobile) */}
      <header className="md:hidden sticky top-0 z-10 bg-[#0b0d13]/90 backdrop-blur px-4 pt-4 pb-2 border-b border-white/5">
        <div className="text-lg font-semibold bg-gradient-to-r from-indigo-400 to-violet-400 bg-clip-text text-transparent">AI Studio Pool</div>
        <StatsBar stats={stats} className="mt-2" />
      </header>

      <main className="flex-1 p-4 pb-24 md:pb-8 overflow-x-hidden">
        <div className="md:hidden mb-4"><AuthControls onLogout={() => setAuthed(false)} /></div>
        {tab === "accounts" && <Accounts />}
        {tab === "play" && <Playground />}
        {tab === "log" && <LogView />}
      </main>

      {/* bottom tabs (mobile) */}
      <nav className="md:hidden fixed bottom-0 inset-x-0 z-10 bg-[#11141c]/95 backdrop-blur border-t border-white/5 flex pb-[env(safe-area-inset-bottom)]">
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`flex-1 py-3 text-[11px] flex flex-col items-center gap-0.5 ${tab === t.id ? "text-indigo-400" : "text-slate-500"}`}>
            <span className="text-base">{t.icon}</span>{t.label}
          </button>
        ))}
      </nav>
    </div>
  );
}

function AuthControls({ onLogout }: { onLogout: () => void }) {
  const [curPw, setCurPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [msg, setMsg] = useState("");
  const change = async () => {
    setMsg("");
    const res = await fetch("/api/auth/password", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ oldPassword: curPw, newPassword: newPw }) });
    const d = await res.json().catch(() => ({}));
    if (res.ok) { setMsg("password updated"); setCurPw(""); setNewPw(""); }
    else setMsg(d.error || "failed");
  };
  const logout = async () => { await fetch("/api/auth/logout", { method: "POST" }).catch(() => {}); onLogout(); };
  return (
    <div className="mt-2 space-y-2">
      <div className="text-[11px] text-slate-500 font-medium">Auth</div>
      <input type="password" value={curPw} onChange={e => setCurPw(e.target.value)} placeholder="current password"
        className="w-full bg-black/30 border border-white/10 rounded-lg px-2.5 py-1.5 text-[11px] outline-none focus:border-indigo-500/50" />
      <input type="password" value={newPw} onChange={e => setNewPw(e.target.value)} placeholder="new password"
        className="w-full bg-black/30 border border-white/10 rounded-lg px-2.5 py-1.5 text-[11px] outline-none focus:border-indigo-500/50" />
      {msg && <div className="text-[10px] text-amber-400">{msg}</div>}
      <div className="flex gap-2">
        <button onClick={change} disabled={!curPw || !newPw}
          className="flex-1 text-[11px] py-1.5 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 disabled:opacity-40 transition">Change</button>
        <button onClick={logout} className="text-[11px] py-1.5 px-3 rounded-lg bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/30 text-rose-300 transition">Logout</button>
      </div>
    </div>
  );
}

function StatsBar({ stats, className = "" }: { stats: Stats | null; className?: string }) {
  const items = stats ? [
    ["accounts", `${stats.idle}/${stats.accounts}`],
    ["busy", String(stats.busy)],
    ["req", String(stats.requests)],
    ["err", String(stats.errors)],
    ["avg", stats.avgMs ? `${(stats.avgMs / 1000).toFixed(1)}s` : "—"],
  ] : [];
  return (
    <div className={`flex flex-wrap gap-1.5 ${className}`}>
      {items.map(([k, v]) => (
        <span key={k} className="text-[10px] px-2 py-1 rounded-lg bg-white/5 border border-white/10 text-slate-400">
          {k} <b className="text-slate-200 font-medium">{v}</b>
        </span>
      ))}
    </div>
  );
}

// ---------- accounts ----------
function Accounts() {
  const [accs, setAccs] = useState<Acc[]>([]);
  const [newName, setNewName] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [paste, setPaste] = useState("");
  const [pasteName, setPasteName] = useState("");

  const refresh = () => j("/api/accounts").then(d => setAccs(d.accounts || [])).catch(() => {});
  useEffect(() => { refresh(); const iv = setInterval(refresh, 2500); return () => clearInterval(iv); }, []);

  const add = async () => {
    if (!newName.trim()) return;
    setBusy(true);
    const r = await j("/api/accounts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: newName.trim() }) });
    setNote(r.note || r.error || "");
    setNewName(""); setBusy(false); refresh();
  };

  const addPaste = async () => {
    if (!pasteName.trim() || !paste.trim()) return;
    setBusy(true);
    let cookies: any;
    try { cookies = JSON.parse(paste); } catch { cookies = null; }
    if (!cookies) { setNote("Paste must be JSON: [{\"name\":\"SAPISID\",\"value\":\"...\",\"domain\":\".google.com\",...}] or the object returned by Export."); setBusy(false); return; }
    const arr = Array.isArray(cookies) ? cookies : (cookies.cookies || [cookies]);
    const r = await j("/api/accounts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: pasteName.trim(), cookies: arr }) });
    setNote(r.note || r.error || (r.ok ? `imported ${r.importedCookies} cookies, state: ${r.account?.state}` : r.error));
    setPasteName(""); setPaste(""); setBusy(false); refresh();
  };

  const act = async (name: string, what: string) =>
    await j(`/api/accounts/${name}/${what}`, { method: "POST" }).then(refresh);

  const doExport = async (name: string) => {
    const d = await j(`/api/accounts/${name}/export`);
    if (d.cookies) {
      await navigator.clipboard.writeText(JSON.stringify(d.cookies));
      setNote(`Exported ${d.cookies.length} cookies for "${name}" to clipboard — paste into another deployment's Add-account box.`);
    } else setNote("Export failed: " + (d.error || ""));
  };

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
        <div className="text-sm font-medium text-slate-300 mb-2">Add account</div>
        <div className="flex gap-2">
          <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="account name (e.g. acc2)"
            onKeyDown={e => e.key === "Enter" && add()}
            className="flex-1 bg-black/30 border border-white/10 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-indigo-500/50" />
          <button disabled={busy || !newName.trim()} onClick={add}
            className="px-4 py-2.5 rounded-xl bg-indigo-500 hover:bg-indigo-400 disabled:opacity-40 text-sm font-medium text-white transition">
            {busy ? "…" : "Launch"}
          </button>
        </div>
        <div className="mt-2 text-[11px] text-slate-500">"Launch" opens a headed Chrome window to sign in manually. For cloud/headless, paste cookies below instead.</div>
      </div>

      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
        <div className="text-sm font-medium text-slate-300 mb-2">Add account from pasted cookies (cloud / cookie-paste — no login UI)</div>
        <div className="flex gap-2 mb-2">
          <input value={pasteName} onChange={e => setPasteName(e.target.value)} placeholder="account name"
            className="w-40 bg-black/30 border border-white/10 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-indigo-500/50" />
        </div>
        <textarea value={paste} onChange={e => setPaste(e.target.value)} rows={3} placeholder='Paste cookie JSON: [{"name":"SAPISID","value":"...","domain":".google.com","path":"/","secure":true,"httpOnly":true}]'
          className="w-full bg-black/30 border border-white/10 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-indigo-500/50 font-mono text-[11px] resize-y" />
        <button disabled={busy || !pasteName.trim() || !paste.trim()} onClick={addPaste}
          className="mt-2 px-4 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 text-sm font-medium text-white transition">
          {busy ? "…" : "Import cookies"}
        </button>
        <div className="mt-2 text-[11px] text-slate-500">Cut/paste the JSON from an Export in another deployment, or from a docs script — Google login never happens on this host.</div>
      </div>

      {note && <div className="text-xs text-amber-400/90 leading-relaxed border border-amber-500/20 rounded-xl p-3 bg-amber-500/5">{note}</div>}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {accs.map(a => (
          <div key={a.name} className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
            <div className="flex items-center justify-between">
              <div className="font-medium text-slate-200">{a.name}</div>
              <span className={`text-[10px] uppercase tracking-wide px-2 py-1 rounded-full border ${STATE_COLORS[a.state] || STATE_COLORS.error}`}>
                {a.state.replace("_", " ")}
              </span>
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2 text-center">
              {[["req", a.stats.requests], ["err", a.stats.errors], ["avg", a.stats.avgMs ? `${(a.stats.avgMs / 1000).toFixed(1)}s` : "—"]].map(([k, v]) => (
                <div key={k as string} className="rounded-xl bg-black/30 py-2">
                  <div className="text-[10px] text-slate-500">{k}</div>
                  <div className="text-sm text-slate-300">{v}</div>
                </div>
              ))}
            </div>
            <div className="mt-2 text-[11px] text-slate-500">last used {rel(a.stats.lastUsed)} · cdp {a.alive ? "live" : "down"}</div>
            {a.stats.lastError && <div className="mt-1 text-[11px] text-rose-400/80 truncate" title={a.stats.lastError}>{a.stats.lastError}</div>}
            <div className="mt-3 flex gap-2 flex-wrap">
              <button onClick={() => act(a.name, a.state === "paused" ? "pause" : "pause")}
                className="flex-1 text-xs py-2 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 transition">
                {a.state === "paused" ? "Resume" : "Pause"}
              </button>
              <button onClick={() => act(a.name, "refresh")}
                className="flex-1 text-xs py-2 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 transition">Refresh</button>
              <button onClick={() => doExport(a.name)}
                className="flex-1 text-xs py-2 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 transition">Export</button>
              {a.name !== "main" && (
                <button onClick={() => { if (confirm(`Remove ${a.name}? (profile kept on disk)`)) j(`/api/accounts/${a.name}`, { method: "DELETE" }).then(refresh); }}
                  className="text-xs py-2 px-3 rounded-xl bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/30 text-rose-300 transition">✕</button>
              )}
            </div>
          </div>
        ))}
        {!accs.length && <div className="col-span-full text-center text-slate-500 text-sm py-10 border border-dashed border-white/10 rounded-2xl">No accounts yet. Add one above.</div>}
      </div>
    </div>
  );
}

// ---------- playground ----------
function Playground() {
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState("gemini-3.1-pro-preview");
  const [system, setSystem] = useState("");
  const [input, setInput] = useState("Say exactly PLAYGROUND_OK and one fun fact.");
  const [stream, setStream] = useState(true);
  const [reasoning, setReasoning] = useState("");
  const [answer, setAnswer] = useState("");
  const [status, setStatus] = useState<"idle" | "running" | "done" | "error">("idle");
  const [err, setErr] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => { j("/v1/models").then(d => setModels((d.data || []).map((m: any) => m.id))).catch(() => {}); }, []);

  const send = async () => {
    setStatus("running"); setReasoning(""); setAnswer(""); setErr("");
    const messages: any[] = [];
    if (system.trim()) messages.push({ role: "system", content: system });
    messages.push({ role: "user", content: input });
    const ctl = new AbortController(); abortRef.current = ctl;
    try {
      const res = await fetch("/v1/chat/completions", {
        method: "POST", headers: { "content-type": "application/json" }, signal: ctl.signal,
        body: JSON.stringify({ model, messages, stream }),
      });
      if (!stream) {
        const d = await res.json();
        if (d.error) throw new Error(d.error.message);
        setReasoning(d.choices?.[0]?.message?.reasoning_content || "");
        setAnswer(d.choices?.[0]?.message?.content || "");
      } else {
        const reader = res.body!.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split("\n"); buf = lines.pop()!;
          for (const line of lines) {
            if (!line.startsWith("data: ") || line.includes("[DONE]")) continue;
            try {
              const d = JSON.parse(line.slice(6));
              const delta = d.choices?.[0]?.delta || {};
              if (delta.reasoning_content) setReasoning(r => r + delta.reasoning_content);
              if (delta.content) setAnswer(a => a + delta.content);
            } catch {}
          }
        }
      }
      setStatus("done");
    } catch (e: any) {
      if (e.name !== "AbortError") { setErr(String(e.message || e)); setStatus("error"); } else setStatus("idle");
    }
  };

  return (
    <div className="space-y-3">
      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 space-y-3">
        <div className="flex gap-2">
          <select value={model} onChange={e => setModel(e.target.value)}
            className="flex-1 bg-black/30 border border-white/10 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-indigo-500/50">
            {(models.length ? models : [model]).map(m => <option key={m} value={m} className="bg-[#11141c]">{m}</option>)}
          </select>
          <label className="flex items-center gap-2 text-xs text-slate-400 px-3 rounded-xl border border-white/10 bg-black/30 cursor-pointer">
            <input type="checkbox" checked={stream} onChange={e => setStream(e.target.checked)} className="accent-indigo-500" />
            stream
          </label>
        </div>
        <input value={system} onChange={e => setSystem(e.target.value)} placeholder="system instructions (optional)"
          className="w-full bg-black/30 border border-white/10 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-indigo-500/50" />
        <textarea value={input} onChange={e => setInput(e.target.value)} rows={3}
          className="w-full bg-black/30 border border-white/10 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-indigo-500/50 resize-y" />
        <div className="flex gap-2">
          <button onClick={send} disabled={status === "running" || !input.trim()}
            className="flex-1 py-2.5 rounded-xl bg-indigo-500 hover:bg-indigo-400 disabled:opacity-40 text-sm font-medium text-white transition">
            {status === "running" ? "Running…" : "Send"}
          </button>
          {status === "running" && (
            <button onClick={() => abortRef.current?.abort()}
              className="px-4 py-2.5 rounded-xl bg-rose-500/20 text-rose-300 border border-rose-500/30 text-sm">Stop</button>
          )}
        </div>
        {err && <div className="text-xs text-rose-400">{err}</div>}
      </div>

      {(reasoning || answer || status === "running") && (
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 space-y-3">
          {reasoning && (
            <details open={status === "running"}>
              <summary className="text-xs text-slate-500 cursor-pointer select-none">thinking ({reasoning.length} chars)</summary>
              <div className="mt-2 text-xs text-slate-500 italic whitespace-pre-wrap leading-relaxed max-h-48 overflow-y-auto">{reasoning}</div>
            </details>
          )}
          <div className="text-sm text-slate-200 whitespace-pre-wrap leading-relaxed">{answer || (status === "running" ? "…" : "")}</div>
        </div>
      )}
    </div>
  );
}

// ---------- log ----------
function LogView() {
  const [log, setLog] = useState<LogEntry[]>([]);
  useEffect(() => {
    const tick = () => j("/api/log").then(d => setLog(d.log || [])).catch(() => {});
    tick(); const iv = setInterval(tick, 2500); return () => clearInterval(iv);
  }, []);
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] divide-y divide-white/5">
      {!log.length && <div className="p-8 text-center text-slate-500 text-sm">No requests yet — try the Playground.</div>}
      {log.map((e, i) => (
        <div key={i} className="p-3 flex items-start gap-3 text-xs">
          <span className={`mt-0.5 w-1.5 h-1.5 rounded-full shrink-0 ${e.ok ? "bg-emerald-400" : "bg-rose-400"}`} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap gap-x-2 text-slate-400">
              <span className="text-slate-200">{new Date(e.t).toLocaleTimeString()}</span>
              <span className="text-indigo-300/80">{e.model.replace("gemini-", "")}</span>
              <span>@{e.account}</span>
              <span>{(e.ms / 1000).toFixed(1)}s</span>
              {e.stream && <span className="text-slate-500">SSE</span>}
            </div>
            <div className={`mt-0.5 truncate ${e.ok ? "text-slate-500" : "text-rose-400/90"}`}>{e.error || e.promptPreview}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
