import WebSocket from "ws";

export interface CdpEvent { method: string; params: any }

/** Minimal CDP client over a page-level WebSocket. */
export class Cdp {
  private ws!: WebSocket;
  private nextId = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private listeners: Array<(ev: CdpEvent) => void> = [];
  private closed = false;

  static async listTargets(port: number): Promise<any[]> {
    const res = await fetch(`http://localhost:${port}/json`);
    return res.json();
  }

  async connect(wsUrl: string, timeoutMs = 15_000): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl, { handshakeTimeout: timeoutMs });
      const t = setTimeout(() => reject(new Error("CDP connect timeout")), timeoutMs);
      ws.on("open", () => { clearTimeout(t); this.ws = ws; resolve(); });
      ws.on("error", (e) => { clearTimeout(t); reject(e); });
      ws.on("message", (data) => this.onMessage(String(data)));
      ws.on("close", () => { this.closed = true; this.pending.forEach(p => p.reject(new Error("CDP closed"))); });
    });
  }

  private onMessage(raw: string) {
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || String(msg.error)));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method) for (const l of this.listeners) l(msg);
  }

  onEvent(listener: (ev: CdpEvent) => void) {
    this.listeners.push(listener);
    return () => { this.listeners = this.listeners.filter(l => l !== listener); };
  }

  send(method: string, params: Record<string, any> = {}, timeoutMs = 30_000): Promise<any> {
    if (this.closed || !this.ws) return Promise.reject(new Error("CDP not connected"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timeout`)); }, timeoutMs);
      this.pending.set(id, {
        resolve: v => { clearTimeout(t); resolve(v); },
        reject: e => { clearTimeout(t); reject(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.closed = true;
    try { this.ws?.close(); } catch {}
  }

  get isConnected() { return !this.closed && !!this.ws; }
}

/** Wait until fn returns truthy, polling with backoff. */
export async function waitFor<T>(fn: () => Promise<T> | T, ms: number, label = ""): Promise<T> {
  const start = Date.now();
  let delay = 200;
  while (Date.now() - start < ms) {
    const v = await fn();
    if (v) return v;
    await new Promise(r => setTimeout(r, delay));
    delay = Math.min(delay * 1.4, 1500);
  }
  throw new Error(`timeout waiting for ${label}`);
}
